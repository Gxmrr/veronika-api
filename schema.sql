-- Таблица уже создана в ONREZA, повторно создавать её не требуется.
-- Этот запрос также запускается при первом старте API, если таблицы нет.
CREATE TABLE IF NOT EXISTS bookings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visit_date DATE NOT NULL,
  visit_time TIME WITHOUT TIME ZONE NOT NULL,
  client_name VARCHAR(80) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  service VARCHAR(80) NOT NULL,
  addons JSONB NOT NULL DEFAULT '{}'::jsonb,
  telegram_chat_id BIGINT,
  telegram_link_token_hash VARCHAR(64),
  reminder_channel VARCHAR(16) NOT NULL DEFAULT 'none' CHECK (reminder_channel IN ('none', 'telegram', 'sms')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_visit_datetime UNIQUE (visit_date, visit_time)
);


-- Дополнительные перерывы, которые мастер закрывает вручную в /admin.
CREATE TABLE IF NOT EXISTS manual_breaks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  break_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  note VARCHAR(120) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_manual_break CHECK (start_time < end_time)
);


-- Очередь уведомлений: за 1 час до записи и при переносе.
-- Содержит только ссылку на запись, без дублирования телефона клиента.
CREATE TABLE IF NOT EXISTS booking_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('reminder', 'rescheduled')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  locked_until TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error VARCHAR(150),
  UNIQUE (booking_id, kind)
);

-- Для ранее созданных баз: добавить JSONB без удаления записей.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS telegram_link_token_hash VARCHAR(64);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_channel VARCHAR(16) NOT NULL DEFAULT 'none';

-- Минимизация трат пробного баланса P1SMS: 1 подтверждённый тест/день.
CREATE TABLE IF NOT EXISTS p1sms_test_log (
  day DATE PRIMARY KEY,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result VARCHAR(24) NOT NULL
);

-- Ограничитель реальных SMS в день, автоматически учитывает попытки.
CREATE TABLE IF NOT EXISTS p1sms_daily_usage (
  day DATE PRIMARY KEY,
  attempted INTEGER NOT NULL DEFAULT 0
);
