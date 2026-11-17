// P1SMS (p1sms.ru) gateway. This is distinct from ip1sms.com.
// The request shape is based on published third-party integration examples:
// POST https://admin.p1sms.ru/apiSms/create, JSON with apiKey and sms array.
// A trial send to your own phone is required before enabling client sends.
const API_URL = "https://admin.p1sms.ru/apiSms/create";

export function p1smsConfigured() {
  return Boolean(
    process.env.P1SMS_API_KEY?.trim() &&
    ["digit", "char"].includes(process.env.P1SMS_CHANNEL)
  );
}

export function p1smsReady() {
  return p1smsConfigured() && process.env.P1SMS_SMS_ENABLED === "true";
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (!/^7\d{10}$/.test(digits)) throw new Error("Неверный номер телефона для SMS.");
  return digits;
}

export async function sendP1sms(phone, message, { test = false } = {}) {
  if (!p1smsConfigured()) {
    throw new Error("P1SMS не настроен: нужны API-ключ и SMS-канал.");
  }
  if (!test && !p1smsReady()) {
    throw new Error("Автоматические SMS отключены до успешного теста.");
  }
  const destination = normalizePhone(phone);
  if (test) {
    if (!process.env.P1SMS_TEST_PHONE ||
        destination !== normalizePhone(process.env.P1SMS_TEST_PHONE)) {
      throw new Error("Тест разрешён только на P1SMS_TEST_PHONE из ONREZA.");
    }
  }
  if (typeof message !== "string" || !message.trim() || message.length > 240) {
    throw new Error("Некорректная длина текста SMS.");
  }

  const item = {
    phone: destination,
    channel: process.env.P1SMS_CHANNEL,
    text: message
  };
  if (process.env.P1SMS_SENDER?.trim()) {
    item.sender = process.env.P1SMS_SENDER.trim();
  }
  // 'phone' at root is included for compatibility with published examples.
  const payload = {
    apiKey: process.env.P1SMS_API_KEY.trim(),
    phone: destination,
    sms: [item]
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  // Never write the request body, key, or full provider response to logs.
  if (!response.ok) {
    throw new Error("P1SMS отказал в запросе: HTTP " + response.status);
  }
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("P1SMS вернул неожиданный ответ; проверьте историю кабинета до повторной отправки.");
  }
  if (!data || typeof data !== "object" ||
      data.success === false || data.result === false ||
      data.error || (Array.isArray(data.errors) && data.errors.length > 0) ||
      ["fail", "failed", "error"].includes(String(data.status || "").toLowerCase()) ||
      data.data?.success === false) {
    throw new Error("P1SMS не подтвердил принятие SMS. Проверьте историю в кабинете.");
  }
  // HTTP 2xx with no reported error means accepted by the gateway, not delivered.
  return { accepted: true };
}
