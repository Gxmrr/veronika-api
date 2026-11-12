-- Таблица уже создана в ONREZA, повторно создавать её не требуется.
-- Этот запрос также запускается при первом старте API, если таблицы нет.
CREATE TABLE IF NOT EXISTS bookings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visit_date DATE NOT NULL,
  visit_time TIME WITHOUT TIME ZONE NOT NULL,
  client_name VARCHAR(80) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  service VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_visit_datetime UNIQUE (visit_date, visit_time)
);
