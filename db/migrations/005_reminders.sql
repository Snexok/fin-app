-- Мягкие напоминания из Telegram-бота: настройки пользователя и журнал отправок (дедуп по дню).
CREATE TABLE reminder_settings (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    -- виды: payment_due, payday, onboarding, log_nudge, weekly, morning; значение: true/false
    kinds jsonb NOT NULL DEFAULT '{}'::jsonb,
    send_hour smallint NOT NULL DEFAULT 10 CHECK (send_hour BETWEEN 0 AND 23),
    quiet_start smallint NOT NULL DEFAULT 22 CHECK (quiet_start BETWEEN 0 AND 23),
    quiet_end smallint NOT NULL DEFAULT 9 CHECK (quiet_end BETWEEN 0 AND 23),
    -- «Реже» для подсказки записать траты: минимальный интервал в днях
    nudge_every_days smallint NOT NULL DEFAULT 7 CHECK (nudge_every_days BETWEEN 2 AND 30),
    blocked_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reminder_log (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    ref text NOT NULL DEFAULT '',
    local_day date NOT NULL,
    status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'skipped')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, ref, local_day)
);
CREATE INDEX reminder_log_user_day ON reminder_log (user_id, local_day);
