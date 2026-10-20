-- 007: служебные журналы для метрик конкурса (критерий 4): ошибки сервиса, журнал обращений,
-- источник первого касания и флаг команды/тестовых аккаунтов.
-- Приватность: только псевдоним (тот же HMAC, что в analytics_events, NULL при отказе от статистики),
-- стабильные коды и короткие сообщения без ввода пользователя, сумм, токенов, IP и user-agent.

-- Команда и тестовые аккаунты: исключаются из дашборда и выгрузки по умолчанию.
ALTER TABLE users ADD COLUMN is_internal boolean NOT NULL DEFAULT false;
-- Копия флага в событиях (псевдоним нельзя соединить с users); обновляется при пометке пользователя.
ALTER TABLE analytics_events ADD COLUMN internal boolean NOT NULL DEFAULT false;
CREATE INDEX analytics_events_internal ON analytics_events (occurred_at) WHERE internal;
-- «Реальные» события: без команды и тестов. Дашборд читает этот вид.
CREATE VIEW analytics_events_real AS SELECT * FROM analytics_events WHERE NOT internal;

-- Журнал обращений: одна строка на обращение к ключевому компоненту (тип из allowlist CALL_TYPES).
CREATE TABLE service_calls (
    id bigserial PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT date_trunc('second', now()),
    subject text,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram', 'miniapp', 'cron', 'system')),
    call_type text NOT NULL,
    result text NOT NULL CHECK (result IN ('ok', 'error')),
    code text,
    http_status smallint,
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    internal boolean NOT NULL DEFAULT false,
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX service_calls_time ON service_calls (occurred_at);
CREATE INDEX service_calls_type_time ON service_calls (call_type, occurred_at);
CREATE INDEX service_calls_subject ON service_calls (subject) WHERE subject IS NOT NULL;

-- Ошибки сервиса: API (4xx/5xx), бот, cron, фоновые отправки.
CREATE TABLE service_errors (
    id bigserial PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT date_trunc('second', now()),
    subject text,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram', 'miniapp', 'cron', 'system')),
    route text NOT NULL,
    code text NOT NULL,
    http_status smallint,
    message text CHECK (message IS NULL OR length(message) <= 200),
    internal boolean NOT NULL DEFAULT false,
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX service_errors_time ON service_errors (occurred_at);
CREATE INDEX service_errors_code_time ON service_errors (code, occurred_at);
CREATE INDEX service_errors_subject ON service_errors (subject) WHERE subject IS NOT NULL;

-- Источник первого касания: одна строка на пользователя, пишется один раз (ON CONFLICT DO NOTHING).
-- Значения нормализованы ([a-z0-9._-], до 40 символов); от реферера хранится только домен.
CREATE TABLE user_sources (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram', 'miniapp')),
    source text NOT NULL,
    medium text,
    campaign text,
    referrer_host text,
    first_seen_at timestamptz NOT NULL DEFAULT date_trunc('second', now()),
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX user_sources_time ON user_sources (first_seen_at);
