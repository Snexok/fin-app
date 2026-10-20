-- 010: тарифы, права и квоты AI-ответов (Монетизация.md §1–2, план MVP шаг 2 и шаг 4).
-- Этап 1 (Sber500): денег не берём. Все получают одинаковый «Бета-Плюс» (PLANS_MODE=beta, вычисляется, строк не требует).
-- Здесь нет ни одной таблицы платежей: orders / payment_events появятся отдельной миграцией после разрешения ментора.
--  • entitlements — периоды доступа к Плюсу: награда за друга (referral), ручная выдача (manual), в будущем оплата (paid).
--  • ai_token_buckets + ai_token_ledger — пользовательские «токены» (1 токен = 1 AI-ответ): атомарный резерв до вызова модели,
--    списание только после успешного AI-ответа, возврат при сбое (тот же шаблон, что budget_buckets в 009).
--  • plus_interest — заявка «Хочу Плюс» без оплаты и без карты: одна строка на пользователя, повтор обновляет выбор цены.
-- Приватность: только id пользователя, тариф, назначение и время. Тексты вопросов и ответов не хранятся.

CREATE TABLE entitlements (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan text NOT NULL CHECK (plan IN ('beta_plus', 'plus')),
    -- beta — бета-доступ (обычно вычисляется без строки); referral — +N дней за друга (REFERRAL_REWARDS_ENABLED);
    -- manual — выдано командой; paid — зарезервировано под будущую оплату, в коде этапа 1 такой ветки нет.
    source text NOT NULL CHECK (source IN ('beta', 'referral', 'manual', 'paid')),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    -- Одна выдача на награду и на ключ идемпотентности: повтор cron/скрипта не продлевает дважды.
    referral_reward_id bigint UNIQUE REFERENCES referral_rewards(id) ON DELETE SET NULL,
    idempotency_key text UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) <= 120),
    note text CHECK (note IS NULL OR length(note) <= 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    demo boolean NOT NULL DEFAULT false,
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX entitlements_user ON entitlements (user_id, ends_at);

-- Счётчики AI-ответов: день (по Москве) и 30-дневное окно тарифа (начало окна — дата по Москве).
-- Резерв: INSERT … ON CONFLICT DO UPDATE … WHERE used + reserved + 1 <= лимит (строка блокируется, параллельные
-- запросы не пробивают квоту). Лимиты не хранятся: они из env (lib/plans/config.ts) и передаются в запрос.
-- voice_day / voice_window — секунды голоса (used = секунды), без резерва.
CREATE TABLE ai_token_buckets (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_kind text NOT NULL CHECK (period_kind IN ('day', 'window', 'voice_day', 'voice_window')),
    period_start date NOT NULL,
    used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
    reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    demo boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, period_kind, period_start)
);
CREATE INDEX ai_token_buckets_period ON ai_token_buckets (period_kind, period_start);

-- Журнал токенов: одна строка на вызов, которому квота понадобилась (request_id из lib/llm/client.ts).
-- reserved → consumed (успешный AI-ответ) | released (сбой модели, невалидный ответ, отказ бюджета, зависший резерв).
CREATE TABLE ai_token_ledger (
    request_id text PRIMARY KEY CHECK (request_id ~ '^[a-z0-9-]{8,64}$'),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan text NOT NULL CHECK (plan IN ('beta_plus', 'free', 'plus')),
    purpose text NOT NULL CHECK (purpose IN ('explain', 'compare', 'goal_chat', 'weekly_review')),
    day date NOT NULL,
    window_start date,
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'consumed', 'released')),
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX ai_token_ledger_user_status ON ai_token_ledger (user_id, status, created_at);
CREATE INDEX ai_token_ledger_day ON ai_token_ledger (day);

-- «Хочу Плюс»: заявка без оплаты. Повтор обновляет выбор («сколько честно платить») и updated_at, created_at остаётся.
CREATE TABLE plus_interest (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- выбранная «честная цена» в ₽ (NULL — «не знаю»)
    price_choice integer CHECK (price_choice IS NULL OR (price_choice > 0 AND price_choice <= 10000)),
    -- показанная цена Плюса и вариант эксперимента цены (PLUS_PRICE_EXPERIMENT), чтобы сравнивать WTP по вариантам
    offered_price integer NOT NULL CHECK (offered_price >= 0 AND offered_price <= 10000),
    variant text NOT NULL DEFAULT 'base' CHECK (variant ~ '^[a-z0-9_]{1,20}$'),
    channel text NOT NULL CHECK (channel IN ('web', 'telegram', 'miniapp')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updates integer NOT NULL DEFAULT 0 CHECK (updates >= 0),
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX plus_interest_time ON plus_interest (created_at);

-- Признаки для конкурсного отчёта Sber500 (Монетизация.md §4): ever_paid всегда false на этапе 1 (источника paid в коде нет);
-- entitlement_source — самый «сильный» источник выданного Плюса (paid > referral > manual), NULL — только общая бета.
CREATE VIEW user_plan_flags AS
SELECT u.id AS user_id,
       EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = u.id AND e.source = 'paid' AND e.revoked_at IS NULL) AS ever_paid,
       (SELECT e.source FROM entitlements e WHERE e.user_id = u.id AND e.revoked_at IS NULL AND e.source <> 'beta'
         ORDER BY CASE e.source WHEN 'paid' THEN 0 WHEN 'referral' THEN 1 ELSE 2 END, e.created_at LIMIT 1) AS entitlement_source,
       EXISTS (SELECT 1 FROM plus_interest p WHERE p.user_id = u.id) AS plus_interest
  FROM users u;
