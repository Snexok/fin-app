-- 002: лимиты потребления платных и дорогих операций (STT, LLM, создание анонимных аккаунтов).
CREATE TABLE rate_limits (
    key text NOT NULL,
    window_start timestamptz NOT NULL,
    count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
);

-- Индексы под основные агрегаты прогноза.
CREATE INDEX ledger_user_created ON ledger_entries(user_id, created_at);
CREATE INDEX ledger_user_occurrence ON ledger_entries(user_id, occurrence_id) WHERE occurrence_id IS NOT NULL;
