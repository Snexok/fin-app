-- Первичная продуктовая аналитика (без сторонних SDK).
-- Приватность: только имя события из allowlist, псевдоним (HMAC от user_id), канал, минута и
-- свойства-перечисления. Никаких текстов, сумм, балансов, имён, Telegram ID, IP или user-agent.
CREATE TABLE analytics_events (
    id bigserial PRIMARY KEY,
    -- HMAC естественного ключа события: повтор webhook/HTTP/alreadyApplied не создаёт дубль
    dedup_key text NOT NULL UNIQUE,
    name text NOT NULL,
    -- псевдоним пользователя: HMAC-SHA256(ANALYTICS_SECRET, user_id:epoch), 32 hex
    subject text NOT NULL,
    -- псевдоним попытки онбординга (HMAC), для воронки по проходам
    attempt text,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram', 'miniapp', 'system')),
    source text NOT NULL CHECK (source IN ('server', 'client')),
    -- округлено до минуты: меньше точных последовательностей для сопоставления с логами
    occurred_at timestamptz NOT NULL,
    props jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- синтетические данные для локальных скриншотов; в проде всегда false
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX analytics_events_time ON analytics_events (occurred_at);
CREATE INDEX analytics_events_name_time ON analytics_events (name, occurred_at);
CREATE INDEX analytics_events_subject ON analytics_events (subject, occurred_at);
-- воронка по проходам знакомства
CREATE INDEX analytics_events_attempt ON analytics_events (attempt, name) WHERE attempt IS NOT NULL;

-- Отказ от статистики (opt-out) и эпоха псевдонима: при отказе события удаляются, эпоха растёт,
-- поэтому после повторного включения пользователь получает новый, несвязанный псевдоним.
ALTER TABLE users ADD COLUMN analytics_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN analytics_epoch integer NOT NULL DEFAULT 0;
