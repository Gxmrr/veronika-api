import express from "express";
import { initNotifications, queueReminder, queueReschedule, smsPhone, processNotifications } from "./notifications.js";
import { p1smsReady, p1smsConfigured, sendP1sms } from "./p1sms.js";
import { Pool } from "pg";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { telegramReady, telegramClientLink, configureTelegramWebhook, processTelegramUpdate } from "./telegram.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const currentDir = dirname(fileURLToPath(import.meta.url));
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb" }));

// Для опубликованного сайта задайте CLIENT_ORIGIN равным адресу фронтенда.
const allowedOrigin = process.env.CLIENT_ORIGIN || "*";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  // Администратор с валидным ключом не ограничен лимитами для гостей.
  // Публичные запросы по-прежнему имеют ограничение.
  skip: req => authorized(req),
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Слишком много запросов. Попробуйте позже." }
}));

if (!process.env.DATABASE_URL) {
  console.error("Нет DATABASE_URL. Подключите PostgreSQL к проекту ONREZA.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5
});

// Время можно выбрать с точностью до минуты, пока процедура помещается в график.
// Продолжительность услуг взята из настроек учебного расписания.
const OPEN_MINUTES = 12 * 60;
const CLOSE_MINUTES = 20 * 60;
const BREAK_MINUTES = 15;

const durations = new Map([
  ["Простой маникюр", 60],
  ["Маникюр в один тон", 90],
  ["Маникюр с дизайном", 120], // Сохраняем длительность старых записей.
  ["Ремонт ногтя", 60],
  ["Донаращивание ногтя", 120],
  ["Наращивание ногтя", 120]
]);

// Дополнительные услуги и их продолжительность на одну позицию.
// Дополнения считают отдельные ногти. Старые полные процедуры наращивания
// по-прежнему остаются в durations с прежней длительностью 120 минут.
const addonDurations = Object.freeze({
  repair: 15,
  extension: 25,
  nails: 25
});

// Никакого жёсткого лимита числа дополнительных услуг в интерфейсе.
// Но количество должно быть неотрицательным целым и помещаться в рабочий день.
function parseAddons(value) {
  if (value === undefined || value === null || value === "") return {};
  let data = value;
  if (typeof data === "string") {
    if (data.length > 500) return null;
    try { data = JSON.parse(data); } catch (_error) { return null; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.some(key => !Object.hasOwn(addonDurations, key))) return null;
  const parsed = {};
  for (const key of keys) {
    const quantity = data[key];
    if (!Number.isSafeInteger(quantity) || quantity < 0) return null;
    if (quantity > 0) parsed[key] = quantity;
  }
  return parsed;
}

function durationOf(service, addons = {}) {
  const base = durations.get(service);
  if (!Number.isFinite(base)) return NaN;
  return base + Object.entries(addons || {}).reduce(
    (total, [key, quantity]) => total + (addonDurations[key] || 0) * quantity, 0
  );
}

function slotStep(_service, _addons = {}) {
  // Все свободные начала показываем с шагом 30 минут;
  // реальная длительность выбранных услуг учитывается отдельно.
  return 30;
}

function minuteOfDay(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return NaN;
  }
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function asTime(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" +
    String(minutes % 60).padStart(2, "0");
}

function fitsSchedule(time, service, addons = {}) {
  const start = minuteOfDay(time);
  const duration = durationOf(service, addons);
  return Number.isFinite(start) && Number.isFinite(duration) &&
    start >= OPEN_MINUTES && start + duration <= CLOSE_MINUTES;
}

function timeIsAvailable(time, service, existing, manualBreaks = [], addons = {}) {
  if (!fitsSchedule(time, service, addons)) return false;
  const start = minuteOfDay(time);
  const end = start + durationOf(service, addons);
  const clearOfBreaks = manualBreaks.every(item => {
    const from = minuteOfDay(item.start);
    const to = minuteOfDay(item.end);
    return end <= from || start >= to;
  });

  return clearOfBreaks && existing.every(row => {
    const bookedStart = minuteOfDay(row.time);
    // Для записей со старыми названиями используем безопасную длительность 2,5 часа.
    const bookedDuration = durationOf(row.service, row.addons) || 150;
    const bookedEnd = bookedStart + bookedDuration;
    // Запрет пересечений и 15-минутный интервал между процедурами.
    return start >= bookedEnd + BREAK_MINUTES ||
      bookedStart >= end + BREAK_MINUTES;
  });
}

async function bookingsForDate(db, date, excludedId = null) {
  const result = await db.query(
    `SELECT to_char(visit_time, 'HH24:MI') AS time, service, addons FROM bookings
     WHERE visit_date = $1 AND ($2::bigint IS NULL OR id <> $2::bigint)`,
    [date, excludedId]
  );
  return result.rows;
}

// Закрытые мастером промежутки хранятся отдельно от записей.
async function manualBreaksForDate(db, date) {
  const result = await db.query(
    `SELECT id, to_char(start_time, 'HH24:MI') AS start,
      to_char(end_time, 'HH24:MI') AS "end", note
      FROM manual_breaks WHERE break_date = $1 ORDER BY start_time`,
    [date]
  );
  return result.rows;
}

const services = new Map([
  ["basic", "Простой маникюр"],
  ["color", "Маникюр в один тон"],
  ["repair", "Ремонт ногтя"],
  ["extension", "Донаращивание ногтя"],
  ["nails", "Наращивание ногтя"],
  ["Простой маникюр", "Простой маникюр"],
  ["Маникюр в один тон", "Маникюр в один тон"],
  ["Ремонт ногтя", "Ремонт ногтя"],
  ["Донаращивание", "Донаращивание ногтя"],
  ["Донаращивание ногтя", "Донаращивание ногтя"],
  ["Наращивание", "Наращивание ногтя"],
  ["Наращивание ногтя", "Наращивание ногтя"]
]);

function moscowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`
  };
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  if (!Number.isFinite(timestamp)) return false;
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) return false;
  const day = new Date(timestamp).getUTCDay();
  if (day === 0 || day === 6) return false; // Только будние дни
  const today = moscowParts().date;
  return value >= today &&
    timestamp <= Date.parse(`${today}T12:00:00Z`) + 90 * 86400000;
}

function futureSlot(date, time) {
  const now = moscowParts();
  return date > now.date || (date === now.date && time > now.time);
}

// Public methods: do not reveal any API keys.
app.get("/api/reminder-options", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ telegram: telegramReady(), sms: p1smsReady() });
});

// Проверка связи с базой
app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "veronika-api" });
  } catch (error) {
    next(error);
  }
});

// Показываем доступные начала с шагом 30 минут, проверяя сумму длительностей.
// POST принимает любое HH:MM с точностью до минуты при соблюдении расписания.
app.get("/api/slots", async (req, res, next) => {
  try {
    const date = req.query.date;
    const service = services.get(req.query.service || "color");
    const addons = parseAddons(req.query.addons);
    if (!validDate(date) || !service || addons === null) {
      return res.status(400).json({ error: "Укажите рабочую дату и услугу." });
    }
    const [existing, manualBreaks] = await Promise.all([
      bookingsForDate(pool, date), manualBreaksForDate(pool, date)
    ]);
    const times = [];
    const stepMinutes = slotStep(service, addons);
    for (let minute = OPEN_MINUTES; minute < CLOSE_MINUTES; minute += stepMinutes) {
      const time = asTime(minute);
      if (futureSlot(date, time) && timeIsAvailable(time, service, existing, manualBreaks, addons)) {
        times.push(time);
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ date, times, stepMinutes });
  } catch (error) {
    next(error);
  }
});

// Проверка произвольно выбранного часа и минуты из HTML input[type=time].
app.get("/api/availability", async (req, res, next) => {
  try {
    const { date, time } = req.query;
    const service = services.get(req.query.service);
    const addons = parseAddons(req.query.addons);
    if (!validDate(date) || !service || addons === null ||
        !Number.isFinite(minuteOfDay(time))) {
      return res.status(400).json({ error: "Выберите дату, услугу и время." });
    }
    const [existing, manualBreaks] = await Promise.all([
      bookingsForDate(pool, date), manualBreaksForDate(pool, date)
    ]);
    const available = futureSlot(date, time) &&
      timeIsAvailable(time, service, existing, manualBreaks, addons);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      date, time, available,
      message: available ? "Время свободно." :
        "Этот час занят или процедура не помещается в рабочий день."
    });
  } catch (error) {
    next(error);
  }
});

// Панель мастера — HTML доступен по /admin, но список клиентов скрыт за токеном.
// ADMIN_TOKEN задаётся только в переменных окружения ONREZA, НЕ в GitHub.
app.get("/admin", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(join(currentDir, "admin.html"));
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Не считаем действия мастера, если секретный токен подтверждён.
  // Неправильные ключи по-прежнему ограничены 12 попытками.
  skip: req => authorized(req),
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Слишком много попыток. Повторите позже." }
});

function authorized(req) {
  const secret = process.env.ADMIN_TOKEN;
  if (!secret || secret.length < 24) return false;

  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;

  const digest = text => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(digest(secret), digest(token));
}

// External scheduler runs this every minute using a protected secret.
app.post("/api/internal/notifications/run", async (req, res, next) => {
  const secret = process.env.REMINDER_CRON_TOKEN || "";
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const digest = value => createHash("sha256").update(value, "utf8").digest();
  if (secret.length < 24 || !token ||
      !timingSafeEqual(digest(secret), digest(token))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await processNotifications(pool));
  } catch (error) {
    next(error);
  }
});

// Telegram authenticates webhook calls with a secret header.
// Manual one-message test: admin-only, ONLY to the server-configured own number.
// A daily DB lock prevents accidental repetitions that could consume trial credit.
app.post("/api/admin/p1sms/test", adminLimiter, async (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: "Неверный ключ администратора." });
  if (!p1smsConfigured() || !process.env.P1SMS_TEST_PHONE) {
    return res.status(503).json({
      error: "Для теста настройте P1SMS_API_KEY, P1SMS_CHANNEL и P1SMS_TEST_PHONE в ONREZA."
    });
  }
  try {
    const claim = await pool.query(`
      INSERT INTO p1sms_test_log(day, result)
      VALUES ((NOW() AT TIME ZONE 'Europe/Moscow')::date, 'attempted')
      ON CONFLICT (day) DO NOTHING RETURNING day
    `);
    if (!claim.rowCount) {
      return res.status(429).json({
        error: "Сегодня тест P1SMS уже запускался. Проверьте историю в кабинете; повторять платную отправку автоматически нельзя."
      });
    }
    try {
      await sendP1sms(process.env.P1SMS_TEST_PHONE,
        "VERONIKA: test SMS. P1SMS API connection.", { test: true });
      await pool.query(`UPDATE p1sms_test_log SET result = 'accepted'
        WHERE day = (NOW() AT TIME ZONE 'Europe/Moscow')::date`);
      res.json({ success: true,
        message: "P1SMS принял тестовый запрос. Доставку проверьте на своём телефоне и в кабинете." });
    } catch (error) {
      await pool.query(`UPDATE p1sms_test_log SET result = 'uncertain'
        WHERE day = (NOW() AT TIME ZONE 'Europe/Moscow')::date`).catch(() => {});
      res.status(502).json({
        error: "Не удалось подтвердить отправку. Проверьте историю P1SMS и баланс до любого повторного теста."
      });
    }
  } catch (error) { next(error); }
});

app.post("/api/internal/telegram/webhook", async (req, res, next) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  const supplied = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
  const sha = input => createHash("sha256").update(input, "utf8").digest();
  if (!telegramReady() || !supplied ||
      !timingSafeEqual(sha(secret), sha(supplied))) {
    return res.sendStatus(403);
  }
  try {
    await processTelegramUpdate(pool, req.body);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bookings", adminLimiter, async (req, res, next) => {
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 24) {
    return res.status(503).json({
      error: "Просмотр записей ещё не настроен: добавьте ADMIN_TOKEN в ONREZA."
    });
  }

  if (!authorized(req)) {
    return res.status(401).json({ error: "Неверный пароль администратора." });
  }

  try {
    const result = await pool.query(
      `SELECT
          id,
          to_char(visit_date, 'YYYY-MM-DD') AS date,
          to_char(visit_time, 'HH24:MI') AS time,
          client_name AS name,
          phone,
          service,
          addons,
          reminder_channel
        FROM bookings
        ORDER BY visit_date DESC, visit_time DESC
        LIMIT 100`
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ bookings: result.rows });
  } catch (error) {
    next(error);
  }
});

// Приватный список вручную закрытых временных интервалов.
app.get("/api/breaks", adminLimiter, async (req, res, next) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Требуется ключ администратора." });
  }
  try {
    const result = await pool.query(
      `SELECT id, to_char(break_date, 'YYYY-MM-DD') AS date,
        to_char(start_time, 'HH24:MI') AS start,
        to_char(end_time, 'HH24:MI') AS "end", note
        FROM manual_breaks
        WHERE break_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date
        ORDER BY break_date, start_time LIMIT 200`
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ breaks: result.rows });
  } catch (error) {
    next(error);
  }
});

// Закрыть 15:00–16:00 или даже весь день 12:00–20:00.
app.post("/api/breaks", adminLimiter, async (req, res, next) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Требуется ключ администратора." });
  }
  const { date, start, end } = req.body || {};
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  const startMinutes = minuteOfDay(start);
  const endMinutes = minuteOfDay(end);

  if (!validDate(date) || !Number.isFinite(startMinutes) ||
      !Number.isFinite(endMinutes) || startMinutes < OPEN_MINUTES ||
      endMinutes > CLOSE_MINUTES || endMinutes <= startMinutes ||
      note.length > 120) {
    return res.status(400).json({
      error: "Укажите рабочую дату и перерыв с 12:00 до 20:00 (начало раньше конца)."
    });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [date]);
    const existing = await bookingsForDate(client, date);
    const conflict = existing.some(item => {
      const bookedStart = minuteOfDay(item.time);
      const bookedEnd = bookedStart + (durationOf(item.service, item.addons) || 150);
      return startMinutes < bookedEnd && endMinutes > bookedStart;
    });
    if (conflict) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "На этот период уже есть запись. Выберите другой перерыв."
      });
    }
    const blocks = await manualBreaksForDate(client, date);
    if (blocks.some(item =>
      startMinutes < minuteOfDay(item.end) && endMinutes > minuteOfDay(item.start)
    )) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Этот период уже закрыт." });
    }
    const result = await client.query(
      `INSERT INTO manual_breaks (break_date, start_time, end_time, note)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [date, start, end, note]
    );
    await client.query("COMMIT");
    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
});

app.delete("/api/breaks/:id", adminLimiter, async (req, res, next) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Требуется ключ администратора." });
  }
  if (!/^[0-9]{1,18}$/.test(req.params.id)) {
    return res.status(400).json({ error: "Неверный номер перерыва." });
  }
  try {
    const result = await pool.query(
      "DELETE FROM manual_breaks WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Перерыв не найден." });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Редактирование и удаление записей доступно только в панели мастера.
// Изменение даты/времени проверяется по тем же правилам, что и новая запись.
function validBookingId(id) {
  return typeof id === "string" && /^[1-9][0-9]{0,17}$/.test(id);
}

async function acquireDateLocks(client, dates) {
  for (const date of [...new Set(dates)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [date]);
  }
}

app.patch("/api/bookings/:id", adminLimiter, async (req, res, next) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Неверный ключ администратора." });
  }
  const id = req.params.id;
  const { date, time } = req.body || {};
  if (!validBookingId(id) || !validDate(date) ||
      !Number.isFinite(minuteOfDay(time)) || !futureSlot(date, time)) {
    return res.status(400).json({ error: "Укажите существующую запись и будущие дату и время." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const first = await client.query(
      "SELECT to_char(visit_date, 'YYYY-MM-DD') AS date FROM bookings WHERE id = $1",
      [id]
    );
    if (!first.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Запись не найдена." });
    }
    const previousDate = first.rows[0].date;
    // Блокируем старую и новую дату в одном порядке, чтобы не было гонок.
    await acquireDateLocks(client, [previousDate, date]);
    const current = await client.query(
      `SELECT to_char(visit_date, 'YYYY-MM-DD') AS date,
         to_char(visit_time, 'HH24:MI') AS time, service, addons
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!current.rowCount || current.rows[0].date !== previousDate) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Запись изменилась. Обновите журнал и повторите." });
    }
    const service = current.rows[0].service;
    const addons = current.rows[0].addons || {};
    if (!fitsSchedule(time, service, addons)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Процедура не помещается в рабочий день (12:00–20:00)."
      });
    }

    const booked = await bookingsForDate(client, date, id);
    const breaks = await manualBreaksForDate(client, date);
    if (!timeIsAvailable(time, service, booked, breaks, addons)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Выбранное время занято, закрыто или нарушает 15-минутный перерыв."
      });
    }

    const changed = current.rows[0].date !== date || current.rows[0].time !== time;
    if (changed) {
      await client.query(
        "UPDATE bookings SET visit_date = $1, visit_time = $2 WHERE id = $3",
        [date, time, id]
      );
      await queueReminder(client, id);
      await queueReschedule(client, id);
    }
    await client.query("COMMIT");
    res.json({ success: true, id, date, time,
      message: changed
        ? "Запись перенесена. Напоминания обновлены, уведомление поставлено в очередь (если подключён канал связи)."
        : "Дата и время не изменились." });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return res.status(409).json({ error: "Это время уже занято." });
    }
    next(error);
  } finally {
    client?.release();
  }
});

app.delete("/api/bookings/:id", adminLimiter, async (req, res, next) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Неверный ключ администратора." });
  }
  const id = req.params.id;
  if (!validBookingId(id)) {
    return res.status(400).json({ error: "Неверный номер записи." });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const first = await client.query(
      "SELECT to_char(visit_date, 'YYYY-MM-DD') AS date FROM bookings WHERE id = $1",
      [id]
    );
    if (!first.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Запись не найдена." });
    }
    const previousDate = first.rows[0].date;
    await acquireDateLocks(client, [previousDate]);
    const removed = await client.query(
      "DELETE FROM bookings WHERE id = $1 AND visit_date = $2::date RETURNING id",
      [id, previousDate]
    );
    if (!removed.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Запись уже изменена. Обновите журнал." });
    }
    await client.query("COMMIT");
    res.json({ success: true, id, message: "Запись удалена." });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client?.release();
  }
});

// Транзакционная запись: блокируем выбранную дату, чтобы два человека
// одновременно не заняли пересекающееся время.
app.post("/api/bookings", async (req, res, next) => {
  let client;
  try {
    const data = req.body || {};
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const phone = typeof data.phone === "string" ? data.phone.trim() : "";
    const service = services.get(data.service);
    const addons = parseAddons(data.addons);
    const { date, time } = data;
    const normalizedPhone = smsPhone(phone);
    const reminderChannel = data.reminderChannel ?? "none";
    if (!["none", "telegram", "sms"].includes(reminderChannel)) {
      return res.status(400).json({ error: "Неизвестный способ напоминания." });
    }
    if (reminderChannel === "telegram" && !telegramReady()) {
      return res.status(503).json({ error: "Telegram-напоминания пока не настроены." });
    }
    if (reminderChannel === "sms" && !p1smsReady()) {
      return res.status(503).json({ error: "SMS через P1SMS пока не подключены." });
    }

    if (name.length < 2 || name.length > 80 ||
        !normalizedPhone ||
        !service || addons === null || !validDate(date) ||
        !futureSlot(date, time) || !fitsSchedule(time, service, addons)) {
      return res.status(400).json({
        error: "Проверьте имя, телефон, услугу, дату и время работы (12:00–20:00)."
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text))",
      [date]
    );

    const existing = await bookingsForDate(client, date);
    const manualBreaks = await manualBreaksForDate(client, date);
    if (!timeIsAvailable(time, service, existing, manualBreaks, addons)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Время закрыто мастером, занято или недостаточно 15-минутного перерыва."
      });
    }

    const telegramToken = reminderChannel === "telegram" && telegramReady()
      ? randomBytes(24).toString("base64url") : null;
    const telegramHash = telegramToken
      ? createHash("sha256").update(telegramToken).digest("hex") : null;
    const created = await client.query(
      "INSERT INTO bookings (visit_date, visit_time, client_name, phone, service, addons, telegram_link_token_hash, reminder_channel) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING id",
      [date, time, name, normalizedPhone, service, JSON.stringify(addons), telegramHash, reminderChannel]
    );
    await queueReminder(client, created.rows[0].id);
    await client.query("COMMIT");
    res.status(201).json({
      success: true,
      message: "Запись успешно сохранена.",
      date,
      time,
      telegramLink: telegramToken ? telegramClientLink(telegramToken) : null,
      reminderChannel
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      return res.status(409).json({ error: "Это время уже занято." });
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

app.use((error, _req, res, _next) => {
  console.error("API request failed:", error.code || error.message);
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Некорректный JSON." });
  }
  res.status(500).json({ error: "Ошибка сервера. Попробуйте позже." });
});

// Таблица создаётся только если ещё не существует
async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      visit_date DATE NOT NULL,
      visit_time TIME WITHOUT TIME ZONE NOT NULL,
      client_name VARCHAR(80) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      service VARCHAR(80) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT unique_visit_datetime UNIQUE (visit_date, visit_time)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_breaks (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      break_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      note VARCHAR(120) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT valid_manual_break CHECK (start_time < end_time)
    )
  `);

  // Без потери старых записей: к существующей таблице добавляется JSONB.
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS telegram_link_token_hash VARCHAR(64)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS p1sms_test_log (
      day DATE PRIMARY KEY,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      result VARCHAR(24) NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS p1sms_daily_usage (
      day DATE PRIMARY KEY,
      attempted INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_channel VARCHAR(16) NOT NULL DEFAULT 'none'");
  // Preserve previously linked Telegram users.
  await pool.query("UPDATE bookings SET reminder_channel = 'telegram' WHERE telegram_chat_id IS NOT NULL AND reminder_channel = 'none'");
  await initNotifications(pool);
  // Re-time existing pending reminders to the new one-hour rule.
  await pool.query(`
    UPDATE booking_notifications n
    SET scheduled_at = due, next_attempt_at = due
    FROM (
      SELECT id, ((visit_date + visit_time) AT TIME ZONE 'Europe/Moscow')
        - INTERVAL '1 hour' AS due
      FROM bookings
    ) b
    WHERE n.booking_id = b.id AND n.kind = 'reminder'
      AND n.status = 'pending'
      AND n.scheduled_at <> b.due
  `);

  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.log(`VERONIKA API started on ${port}`);
    // Webhook registration requires explicit opt-in environment configuration.
    configureTelegramWebhook()
      .then(ok => { if (ok) console.log("Telegram webhook configured"); })
      .catch(_error => console.error("Telegram webhook setup failed"));
  });
}

start().catch(error => {
  console.error("Не удалось открыть базу данных:", error.code || error.message);
  process.exit(1);
});
