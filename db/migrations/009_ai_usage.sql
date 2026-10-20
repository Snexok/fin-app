-- 009: учёт стоимости LLM и бюджеты (Монетизация.md §2, план MVP шаг 1).
--  • ai_usage — журнал КАЖДОЙ попытки вызова модели (в т.ч. отказ бюджета без вызова): модель, токены, стоимость, задержка, итог.
--  • budget_buckets — атомарные счётчики «резерв → сверка» по проекту (жёсткий потолок) и пользователю (мягкий) за день по Москве,
--    плюс накопительный счётчик всего бюджета акселератора.
-- Приватность: в ai_usage только псевдоним (тот же HMAC, что в analytics_events; NULL при отказе от статистики),
-- без текстов запроса и ответа. Стоимость в микрорублях (целое), копейки — производная колонка: округление до копеек
-- съело бы стоимость разбора намерения (~1,5 коп.).

CREATE TABLE ai_usage (
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- День бюджета (Europe/Moscow), к которому отнесён расход.
    budget_day date NOT NULL,
    -- Одна логическая операция (вызов обёртки) = один request_id; попытки цепочки моделей — attempt 1, 2, 3.
    request_id text NOT NULL CHECK (request_id ~ '^[a-z0-9-]{8,64}$'),
    attempt smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
    subject text,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram', 'miniapp', 'cron', 'system')),
    purpose text NOT NULL CHECK (purpose IN ('intent_parse', 'explain', 'compare', 'goal_chat', 'weekly_review', 'voice_transcribe', 'onboarding')),
    provider text NOT NULL CHECK (length(provider) <= 40),
    model text NOT NULL CHECK (length(model) <= 80),
    prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    -- Голос: длительность аудио (тарифицируется посекундно).
    audio_ms integer CHECK (audio_ms IS NULL OR audio_ms >= 0),
    -- true — провайдер не вернул usage, токены оценены по длине текста.
    usage_estimated boolean NOT NULL DEFAULT false,
    reserved_microrub bigint NOT NULL DEFAULT 0 CHECK (reserved_microrub >= 0),
    cost_microrub bigint NOT NULL DEFAULT 0 CHECK (cost_microrub >= 0),
    cost_kopecks numeric(16, 4) GENERATED ALWAYS AS (cost_microrub / 10000.0) STORED,
    price_version text NOT NULL CHECK (length(price_version) <= 40),
    latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
    -- ok — ответ основной (первой в цепочке) модели; fallback — ответ резервной (fallback_from — чья попытка провалилась);
    -- error — ошибка попытки (5xx, 4xx, сеть, невалидный ответ); timeout — таймаут попытки; budget_denied — вызова не было.
    status text NOT NULL CHECK (status IN ('ok', 'error', 'fallback', 'budget_denied', 'timeout')),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_:]{1,64}$'),
    fallback_from text CHECK (fallback_from IS NULL OR length(fallback_from) <= 80),
    -- Задел под квоты AI-ответов (шаг 2): true — успешный пользовательский AI-ответ (объяснение, сравнение, цель, разбор).
    -- Разбор намерения, голос, ошибки и шаблонный fallback квоту не тратят (false).
    ai_answer boolean NOT NULL DEFAULT false,
    internal boolean NOT NULL DEFAULT false,
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX ai_usage_time ON ai_usage (created_at);
CREATE INDEX ai_usage_day ON ai_usage (budget_day);
CREATE INDEX ai_usage_request ON ai_usage (request_id);
CREATE INDEX ai_usage_subject ON ai_usage (subject) WHERE subject IS NOT NULL;

-- Счётчики бюджета. Резерв перед вызовом — одна условная вставка/обновление (INSERT … ON CONFLICT DO UPDATE … WHERE
-- spent + reserved + оценка <= лимит): строка блокируется, параллельные запросы не пробивают потолок.
-- После ответа: reserved -= оценка, spent += факт. Лимиты не хранятся: они из env и передаются в запрос.
--   project/all/day/<день МСК> — жёсткий дневной потолок проекта (LLM_DAILY_BUDGET_RUB);
--   user/<user_id>/day/<день МСК> — мягкий дневной лимит пользователя (LLM_USER_DAILY_SOFT_CAP_RUB);
--   project/all/total/<LLM_BUDGET_START> — весь бюджет акселератора (LLM_TOTAL_BUDGET_RUB).
-- Квоты AI-ответов (шаг 2) добавятся сюда же отдельным scope_type.
CREATE TABLE budget_buckets (
    scope_type text NOT NULL CHECK (scope_type IN ('project', 'user')),
    scope_id text NOT NULL CHECK (length(scope_id) <= 64),
    period_kind text NOT NULL CHECK (period_kind IN ('day', 'total')),
    period_start date NOT NULL,
    reserved_microrub bigint NOT NULL DEFAULT 0 CHECK (reserved_microrub >= 0),
    spent_microrub bigint NOT NULL DEFAULT 0 CHECK (spent_microrub >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    demo boolean NOT NULL DEFAULT false,
    PRIMARY KEY (scope_type, scope_id, period_kind, period_start)
);
CREATE INDEX budget_buckets_period ON budget_buckets (period_kind, period_start);
