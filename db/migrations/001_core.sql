-- 001_core: ядро пилота "Сегодня" (ARCHITECTURE.md §3.3, шаги 3-5).
-- Отличия от плана: provider 'anonymous' для веб-сессии до привязки Telegram;
-- goals.saved_outside_minor для накоплений вне остатка; conversation_state для черновиков диалога.
-- Таблицы jobs/notification_settings переносятся в 002 (шаг 9-10).

CREATE TABLE users (
    id uuid PRIMARY KEY,
    timezone text NOT NULL DEFAULT 'Europe/Moscow',
    locale text NOT NULL DEFAULT 'ru-RU',
    history_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE TABLE identities (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL
        CHECK (provider IN ('telegram', 'oidc', 'passkey', 'anonymous')),
    issuer text NOT NULL,
    subject text NOT NULL,
    delivery_address text,
    verified_at timestamptz NOT NULL,
    UNIQUE (provider, issuer, subject),
    UNIQUE (user_id, id)
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, identity_id)
        REFERENCES identities(user_id, id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE auth_challenges (
    id uuid PRIMARY KEY,
    purpose text NOT NULL CHECK (purpose IN ('login', 'link')),
    target_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    browser_secret_hash bytea NOT NULL,
    candidate_issuer text,
    candidate_subject text,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'consumed', 'cancelled')),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    opening_balance_minor bigint NOT NULL,
    opening_as_of timestamptz NOT NULL,
    reserve_minor bigint NOT NULL DEFAULT 0 CHECK (reserve_minor >= 0),
    essential_daily_minor bigint CHECK (essential_daily_minor >= 0),
    planning_days integer NOT NULL DEFAULT 30
        CHECK (planning_days BETWEEN 1 AND 365),
    finance_version bigint NOT NULL DEFAULT 1 CHECK (finance_version > 0),
    last_reconciled_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE occurrences (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES books(user_id) ON DELETE CASCADE,
    rule_id uuid,
    direction text NOT NULL CHECK (direction IN ('income', 'expense')),
    name text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    due_on date NOT NULL,
    certainty text NOT NULL DEFAULT 'expected'
        CHECK (certainty IN ('committed', 'expected', 'speculative')),
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    UNIQUE (rule_id, due_on)
);

CREATE TABLE ledger_entries (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES books(user_id) ON DELETE CASCADE,
    occurrence_id uuid,
    kind text NOT NULL CHECK (kind IN ('income', 'expense', 'adjustment')),
    amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
    affects_balance boolean NOT NULL DEFAULT true,
    occurred_at timestamptz NOT NULL,
    name text NOT NULL,
    category text,
    merchant_key text,
    source text NOT NULL
        CHECK (source IN ('form', 'chat', 'telegram', 'import', 'reconciliation')),
    external_ref text,
    reversal_of uuid,
    proposal_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, occurrence_id)
        REFERENCES occurrences(user_id, id),
    FOREIGN KEY (user_id, reversal_of)
        REFERENCES ledger_entries(user_id, id),
    CHECK (
        reversal_of IS NOT NULL
        OR kind = 'adjustment'
        OR (kind = 'income' AND amount_minor > 0)
        OR (kind = 'expense' AND amount_minor < 0)
    )
);

CREATE UNIQUE INDEX ledger_external_ref_unique
    ON ledger_entries(user_id, source, external_ref)
    WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX ledger_one_reversal
    ON ledger_entries(user_id, reversal_of)
    WHERE reversal_of IS NOT NULL;

-- Одно предложение -> не больше одной исходной записи.
CREATE UNIQUE INDEX ledger_one_per_proposal
    ON ledger_entries(proposal_id)
    WHERE proposal_id IS NOT NULL AND reversal_of IS NULL;

CREATE INDEX ledger_user_date
    ON ledger_entries(user_id, occurred_at DESC, id);

CREATE INDEX occurrences_user_date
    ON occurrences(user_id, due_on)
    WHERE cancelled_at IS NULL;

CREATE TABLE goals (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES books(user_id) ON DELETE CASCADE,
    name text NOT NULL,
    target_minor bigint NOT NULL CHECK (target_minor > 0),
    target_date date NOT NULL,
    saved_outside_minor bigint NOT NULL DEFAULT 0 CHECK (saved_outside_minor >= 0),
    priority integer NOT NULL DEFAULT 1 CHECK (priority > 0),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'paused', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id)
);

CREATE TABLE goal_allocations (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES books(user_id) ON DELETE CASCADE,
    goal_id uuid NOT NULL,
    delta_minor bigint NOT NULL CHECK (delta_minor <> 0),
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, goal_id)
        REFERENCES goals(user_id, id)
);

CREATE TABLE proposals (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES books(user_id) ON DELETE CASCADE,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    base_finance_version bigint NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),
    expires_at timestamptz NOT NULL,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    UNIQUE (user_id, id)
);

CREATE TABLE decisions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES books(user_id) ON DELETE CASCADE,
    finance_version bigint NOT NULL,
    engine_version text NOT NULL,
    as_of_date date NOT NULL,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decisions_user_created ON decisions(user_id, created_at DESC);

CREATE TABLE finance_events (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES books(user_id) ON DELETE CASCADE,
    finance_version bigint NOT NULL,
    event_type text NOT NULL,
    entity_id uuid,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, finance_version)
);

CREATE TABLE idempotency_keys (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL CHECK (status IN ('processing', 'completed')),
    response_status integer,
    response_body jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, scope, key)
);

CREATE TABLE inbox (
    source text NOT NULL,
    source_event_id text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    PRIMARY KEY (source, source_event_id)
);

CREATE TABLE conversation_state (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram')),
    state jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel)
);
