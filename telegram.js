// Optional free Telegram reminders. A client must explicitly start the bot
// using the private one-time booking link. No phone numbers go to Telegram.
import { createHash } from "node:crypto";

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const username = process.env.TELEGRAM_BOT_USERNAME || "";
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const publicUrl = process.env.TELEGRAM_PUBLIC_URL || "";

export function telegramReady() {
  return Boolean(token && /^[A-Za-z0-9_]{5,32}$/.test(username) &&
    /^[A-Za-z0-9_-]{20,128}$/.test(secret) && /^https:\/\//.test(publicUrl));
}

export function telegramClientLink(linkToken) {
  if (!telegramReady()) return null;
  return "https://t.me/" + username + "?start=" + encodeURIComponent(linkToken);
}

async function telegramApi(method, args) {
  if (!token) throw new Error("Telegram is not configured");
  const response = await fetch("https://api.telegram.org/bot" +
    token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Telegram HTTP " + response.status);
  const data = await response.json();
  if (!data.ok) throw new Error("Telegram API error " + data.error_code);
  return data.result;
}

export async function telegramSend(chatId, text) {
  return telegramApi("sendMessage", { chat_id: chatId, text });
}

export async function configureTelegramWebhook() {
  if (!telegramReady()) return false;
  const site = publicUrl.replace(/\/$/, "");
  await telegramApi("setWebhook", {
    url: site + "/api/internal/telegram/webhook",
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false
  });
  return true;
}

export async function processTelegramUpdate(pool, update) {
  const message = update?.message;
  const chat = message?.chat;
  if (!message || !chat || chat.type !== "private" ||
      !Number.isSafeInteger(chat.id) || chat.id <= 0 ||
      typeof message.text !== "string") return;
  const content = message.text.trim();
  if (content === "/stop") {
    const result = await pool.query(
      "UPDATE bookings SET telegram_chat_id = NULL, reminder_channel = 'none' WHERE telegram_chat_id = $1 AND reminder_channel = 'telegram' RETURNING id",
      [String(chat.id)]
    );
    await telegramSend(chat.id, "Уведомления VERONIKA отключены. Записей: " + result.rowCount + ".");
    return;
  }
  const match = /^\/start\s+([A-Za-z0-9_-]{20,64})$/.exec(content);
  if (!match) {
    if (content.startsWith("/start") || content === "/help") {
      await telegramSend(chat.id, "Для бесплатного напоминания выберите Telegram на сайте VERONIKA и нажмите кнопку подключения после записи.");
    }
    return;
  }
  const hash = createHash("sha256").update(match[1]).digest("hex");
  const result = await pool.query(
    "UPDATE bookings SET telegram_chat_id = $1, telegram_link_token_hash = NULL " +
    "WHERE telegram_link_token_hash = $2 " +
    "AND reminder_channel = 'telegram' " +
    "AND ((visit_date + visit_time) AT TIME ZONE 'Europe/Moscow') > NOW() " +
    "RETURNING to_char(visit_date,'DD.MM.YYYY') AS date, " +
    "to_char(visit_time,'HH24:MI') AS time",
    [String(chat.id), hash]
  );
  if (result.rowCount) {
    const booking = result.rows[0];
    await telegramSend(chat.id, "VERONIKA: напоминание подключено для записи " +
      booking.date + " в " + booking.time + ". Отправим его за час до визита. Чтобы отказаться — /stop.");
  } else {
    await telegramSend(chat.id, "Ссылка уже использована или срок записи истёк. Для новой записи получите новую ссылку после бронирования.");
  }
}
