// VERONIKA notification outbox. Respect the client-selected channel.
import { telegramSend, telegramReady } from "./telegram.js";
import { p1smsReady, sendP1sms } from "./p1sms.js";

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
      AND EXISTS (
        SELECT 1 FROM bookings b WHERE b.id = candidate.id
          AND b.reminder_channel IN ('telegram', 'sms')
      )
  `, [bookingId]);
}

export async function queueReschedule(db, bookingId) {
  await db.query(`
    INSERT INTO booking_notifications (booking_id, kind, scheduled_at, next_attempt_at)
    SELECT id, 'rescheduled', NOW(), NOW() FROM bookings
    WHERE id = $1 AND reminder_channel IN ('telegram', 'sms')
    ON CONFLICT (booking_id, kind) DO UPDATE
    SET scheduled_at = NOW(), next_attempt_at = NOW(), status = 'pending',
      attempts = 0, revision = booking_notifications.revision + 1,
      locked_until = NULL, sent_at = NULL, last_error = NULL
  `, [bookingId]);
}

// Conservative spending guard: count attempts, not only successful SMS.
// An uncertain provider response may still have charged the account.
async function reserveP1smsSend(pool) {
  const parsed = Number(process.env.P1SMS_DAILY_LIMIT || 2);
  const limit = Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 2;
  const result = await pool.query(`
    INSERT INTO p1sms_daily_usage(day, attempted)
    VALUES ((NOW() AT TIME ZONE 'Europe/Moscow')::date, 1)
    ON CONFLICT (day) DO UPDATE
      SET attempted = p1sms_daily_usage.attempted + 1
      WHERE p1sms_daily_usage.attempted < $1
    RETURNING attempted
  `, [limit]);
  if (!result.rowCount) throw new Error("P1SMS daily SMS limit reached");
}

function formatDate(iso) {
  const [year, month, day] = iso.split("-");
  return day + "." + month + "." + year;
}

// Trigger via a protected POST every minute (e.g. cron-job.org).
// SKIP LOCKED prevents simultaneous invocations from claiming the same job.
export async function processNotifications(pool, maxCount = 15) {
  if (!p1smsReady() && !telegramReady()) return { configured: false, sent: 0, failed: 0 };
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
            AND (($1::boolean AND b.reminder_channel = 'telegram' AND b.telegram_chat_id IS NOT NULL)
              OR ($2::boolean AND b.reminder_channel = 'sms'))
            AND ((b.visit_date + b.visit_time)
              AT TIME ZONE 'Europe/Moscow') > NOW()
            AND n.attempts < 5
            AND (
              (n.status = 'pending' AND n.next_attempt_at <= NOW())
              -- SMS jobs must never be claimed again after an uncertain
              -- send: the provider may have accepted the first attempt.
              OR (n.status = 'sending' AND n.locked_until < NOW()
                AND b.reminder_channel = 'telegram')
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
      `, [telegramReady(), p1smsReady()]);
      job = claim.rows[0];
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
    if (!job) break;

    let attemptedChannel = null;
    try {
      const result = await pool.query(`
        SELECT phone, telegram_chat_id, reminder_channel,
          to_char(visit_date, 'YYYY-MM-DD') AS date,
          to_char(visit_time, 'HH24:MI') AS time
        FROM bookings WHERE id = $1
          AND ((visit_date + visit_time)
            AT TIME ZONE 'Europe/Moscow') > NOW()
      `, [job.booking_id]);
      if (!result.rowCount) continue;
      const b = result.rows[0];
      attemptedChannel = b.reminder_channel;
      const when = formatDate(b.date) + " в " + b.time;
      const message = job.kind === "reminder"
        ? "VERONIKA: напоминаем, запись через час (" + when + ")."
        : "VERONIKA: ваша запись перенесена на " + when + ".";
      if (b.reminder_channel === "telegram" && telegramReady() && b.telegram_chat_id) {
        await telegramSend(String(b.telegram_chat_id), message);
      } else if (b.reminder_channel === "sms" && p1smsReady()) {
        const phone = smsPhone(b.phone);
        if (!phone) throw new Error("Invalid mobile number");
        await reserveP1smsSend(pool);
        await sendP1sms(phone, message);
      } else {
        throw new Error("Selected notification channel is not ready");
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
      // SMS can cost money. Do not retry automatically after uncertain
      // provider responses/timeouts: it might otherwise send (and bill) twice.
      // Telegram retries remain enabled.
      await pool.query(`
        UPDATE booking_notifications
        SET status = CASE WHEN $4::boolean OR attempts >= 5
              THEN 'failed' ELSE 'pending' END,
            next_attempt_at = NOW() + INTERVAL '5 minutes',
            locked_until = NULL, last_error = $3
        WHERE id = $1 AND revision = $2 AND status = 'sending'
      `, [job.id, job.revision, String(error.message || "Delivery failed").slice(0, 150),
        attemptedChannel === "sms"]);
    }
  }
  return { configured: true, sent, failed, telegramConfigured: telegramReady(), smsConfigured: p1smsReady() };
}
