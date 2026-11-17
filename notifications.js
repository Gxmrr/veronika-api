// Transactional notification outbox for bookings (Telegram opt-in or SMS.ru).
import { telegramSend, telegramReady } from "./telegram.js";
// Secrets must only live in ONREZA environment variables, never in GitHub.
const API_KEY = process.env.SMS_RU_API_ID || "";

export function smsPhone(input) {
  let digits = String(input || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length === 11 && digits[0] === "8") digits = "7" + digits.slice(1);
  return /^7\d{10}$/.test(digits) ? digits : null;
}

export async function initNotifications(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_notifications (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      kind VARCHAR(16) NOT NULL CHECK(kind IN ('reminder','rescheduled')),
      scheduled_at TIMESTAMPTZ NOT NULL,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','sending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      locked_until TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      last_error VARCHAR(150),
      UNIQUE (booking_id, kind)
    )
  `);
}

export async function queueReminder(db, bookingId) {
  // Any previous reminder belongs to the old appointment time.
  await db.query(
    "DELETE FROM booking_notifications WHERE booking_id = $1 AND kind = 'reminder'",
    [bookingId]
  );
  // Schedule one hour before a visit; late bookings cannot get this reminder.
  await db.query(`
    INSERT INTO booking_notifications (booking_id, kind, scheduled_at, next_attempt_at)
    SELECT id, 'reminder', due_at, due_at
    FROM (
      SELECT id,
        ((visit_date + visit_time) AT TIME ZONE 'Europe/Moscow')
          - INTERVAL '1 hour' AS due_at
      FROM bookings WHERE id = $1
    ) AS candidate
    WHERE due_at > NOW()
  `, [bookingId]);
}

export async function queueReschedule(db, bookingId) {
  await db.query(`
    INSERT INTO booking_notifications (booking_id, kind, scheduled_at, next_attempt_at)
    VALUES ($1, 'rescheduled', NOW(), NOW())
    ON CONFLICT (booking_id, kind) DO UPDATE
    SET scheduled_at = NOW(), next_attempt_at = NOW(), status = 'pending',
      attempts = 0, revision = booking_notifications.revision + 1,
      locked_until = NULL, sent_at = NULL, last_error = NULL
  `, [bookingId]);
}

async function sendSms(phone, message) {
  const params = new URLSearchParams({
    api_id: API_KEY,
    to: phone,
    msg: message,
    json: "1"
  });
  if (process.env.SMS_RU_FROM) {
    params.set("from", process.env.SMS_RU_FROM);
  }
  const response = await fetch("https://sms.ru/sms/send", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("SMS gateway HTTP " + response.status);
  const data = await response.json();
  if (data.status !== "OK" || data.sms?.[phone]?.status !== "OK") {
    throw new Error("SMS gateway error " +
      String(data.sms?.[phone]?.status_code || data.status_code || "unknown"));
  }
}

function formatDate(iso) {
  const [year, month, day] = iso.split("-");
  return day + "." + month + "." + year;
}

// Trigger via a protected POST every minute (e.g. cron-job.org).
// SKIP LOCKED prevents simultaneous invocations from claiming the same job.
export async function processNotifications(pool, maxCount = 15) {
  if (!API_KEY && !telegramReady()) return { configured: false, sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < maxCount; i++) {
    const db = await pool.connect();
    let job;
    try {
      await db.query("BEGIN");
      const claim = await db.query(`
        WITH picked AS (
          SELECT n.id
          FROM booking_notifications n
          JOIN bookings b ON b.id = n.booking_id
          WHERE n.scheduled_at <= NOW()
            AND ( ($1::boolean AND b.telegram_chat_id IS NOT NULL) OR $2::boolean )
            AND ((b.visit_date + b.visit_time)
              AT TIME ZONE 'Europe/Moscow') > NOW()
            AND n.attempts < 5
            AND (
              (n.status = 'pending' AND n.next_attempt_at <= NOW())
              OR (n.status = 'sending' AND n.locked_until < NOW())
            )
          ORDER BY n.scheduled_at, n.id
          FOR UPDATE OF n SKIP LOCKED
          LIMIT 1
        )
        UPDATE booking_notifications n
          SET status = 'sending', attempts = n.attempts + 1,
              locked_until = NOW() + INTERVAL '2 minutes'
        FROM picked WHERE n.id = picked.id
        RETURNING n.id, n.booking_id, n.kind, n.revision
      `, [telegramReady(), Boolean(API_KEY)]);
      job = claim.rows[0];
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
    if (!job) break;

    try {
      const result = await pool.query(`
        SELECT phone, telegram_chat_id,
          to_char(visit_date, 'YYYY-MM-DD') AS date,
          to_char(visit_time, 'HH24:MI') AS time
        FROM bookings WHERE id = $1
          AND ((visit_date + visit_time)
            AT TIME ZONE 'Europe/Moscow') > NOW()
      `, [job.booking_id]);
      if (!result.rowCount) continue;
      const b = result.rows[0];
      const when = formatDate(b.date) + " в " + b.time;
      const message = job.kind === "reminder"
        ? "VERONIKA: напоминаем, запись через час (" + when + ")."
        : "VERONIKA: ваша запись перенесена на " + when + ".";
      if (telegramReady() && b.telegram_chat_id) {
        // Free and explicitly opted-in: send only to the linked Telegram chat.
        await telegramSend(String(b.telegram_chat_id), message);
      } else if (API_KEY) {
        // Paid SMS fallback only if the operator configured SMS.ru.
        const phone = smsPhone(b.phone);
        if (!phone) throw new Error("Invalid Russian mobile number");
        await sendSms(phone, message);
      } else {
        throw new Error("No available opt-in notification channel");
      }
      await pool.query(`
        UPDATE booking_notifications
        SET status = 'sent', sent_at = NOW(), locked_until = NULL,
            last_error = NULL
        WHERE id = $1 AND revision = $2 AND status = 'sending'
      `, [job.id, job.revision]);
      sent++;
    } catch (error) {
      failed++;
      // Do not log phone numbers or API keys.
      await pool.query(`
        UPDATE booking_notifications
        SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
            next_attempt_at = NOW() + INTERVAL '5 minutes',
            locked_until = NULL, last_error = $3
        WHERE id = $1 AND revision = $2 AND status = 'sending'
      `, [job.id, job.revision, String(error.message || "SMS failed").slice(0, 150)]);
    }
  }
  return { configured: true, sent, failed };
}
