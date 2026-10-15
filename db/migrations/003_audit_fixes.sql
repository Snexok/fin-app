-- 003: исправления pre-audit.
-- Привязка Telegram: бот показывает контекст и одобряет только по явной кнопке того же отправителя.
ALTER TABLE auth_challenges ADD COLUMN context jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE auth_challenges ADD COLUMN previewed_subject text;

-- Inbox вебхука: аренда (lease) и повторы, полный апдейт хранится до обработки.
ALTER TABLE inbox ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE inbox ADD COLUMN locked_until timestamptz;
ALTER TABLE inbox ADD COLUMN last_error text;
CREATE INDEX inbox_pending ON inbox(received_at) WHERE processed_at IS NULL;

-- Календарная дата операции в зоне пользователя (occurred_at остаётся моментом записи/полднем локального дня).
ALTER TABLE ledger_entries ADD COLUMN occurred_on date;

-- Индексы для очистки (retention).
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX auth_challenges_created ON auth_challenges(created_at);
CREATE INDEX idempotency_keys_expires ON idempotency_keys(expires_at);
