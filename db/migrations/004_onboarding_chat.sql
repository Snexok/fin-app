-- 004: онбординг-чат. Одна сессия на пользователя (общая для web и Telegram), CAS по revision.
CREATE TABLE onboarding_session (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state jsonb NOT NULL,
    revision integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- История ленты онбординга (восстановление после прерывания) и идемпотентность повторов
-- (client_key = clientMessageId веба или tg:<update_id> / tg-cb:<callback id>).
CREATE TABLE onboarding_message (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('web', 'telegram')),
    role text NOT NULL CHECK (role IN ('user', 'assistant')),
    payload jsonb NOT NULL,
    client_key text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX onboarding_message_client_key ON onboarding_message(user_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX onboarding_message_user ON onboarding_message(user_id, created_at);
