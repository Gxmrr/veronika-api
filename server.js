import express from "express";
import { Pool } from "pg";
import { rateLimit } from "express-rate-limit";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb" }));

// Для опубликованного сайта задайте CLIENT_ORIGIN равным адресу фронтенда.
const allowedOrigin = process.env.CLIENT_ORIGIN || "*";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
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

const slots = ["12:00", "17:30"];

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

// Проверка связи с базой
app.get("/api/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "veronika-api" });
  } catch (error) {
    next(error);
  }
});

// Список доступных часов
app.get("/api/slots", async (req, res, next) => {
  try {
    const date = req.query.date;
    if (!validDate(date)) {
      return res.status(400).json({
        error: "Выберите рабочую дату в ближайшие 90 дней."
      });
    }

    const result = await pool.query(
      "SELECT to_char(visit_time, 'HH24:MI') AS time FROM bookings WHERE visit_date = $1",
      [date]
    );

    const busy = new Set(result.rows.map(row => row.time));
    const available = slots.filter(time =>
      !busy.has(time) && futureSlot(date, time)
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ date, times: available });
  } catch (error) {
    next(error);
  }
});

// Новое бронирование; PostgreSQL атомарно запрещает повтор даты+времени
app.post("/api/bookings", async (req, res, next) => {
  try {
    const data = req.body || {};
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const phone = typeof data.phone === "string" ? data.phone.trim() : "";
    const service = services.get(data.service);
    const { date, time } = data;
    const digits = phone.replace(/\D/g, "");

    if (name.length < 2 || name.length > 80 ||
        digits.length < 10 || digits.length > 15 ||
        !service || !validDate(date) || !slots.includes(time) ||
        !futureSlot(date, time)) {
      return res.status(400).json({
        error: "Проверьте имя, телефон, услугу, дату и время."
      });
    }

    await pool.query(
      `INSERT INTO bookings (visit_date, visit_time, client_name, phone, service)
       VALUES ($1, $2, $3, $4, $5)`,
      [date, time, name, phone, service]
    );

    res.status(201).json({
      success: true,
      message: "Тестовая запись сохранена",
      date,
      time
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "Это время уже занято. Выберите другое."
      });
    }
    next(error);
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

  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => {
    console.log(`VERONIKA API started on ${port}`);
  });
}

start().catch(error => {
  console.error("Не удалось открыть базу данных:", error.code || error.message);
  process.exit(1);
});
