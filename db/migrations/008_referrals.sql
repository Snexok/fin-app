-- 008: реферальная программа (Монетизация.md §3). Сейчас только атрибуция; награды собраны, но выключены
-- флагом REFERRAL_REWARDS_ENABLED (по умолчанию выключено).
-- Приватность: код приглашения случайный и не раскрывает id; в таблицах только id пользователей (не псевдонимы),
-- канал и время. В дашборд и выгрузку попадают агрегаты и HMAC-псевдонимы, как в analytics_events.

-- Личный код пригласившего: создаётся лениво при первом запросе ссылки, стабилен. Алфавит без 0/1/i/l/o.
ALTER TABLE users ADD COLUMN ref_code text CHECK (ref_code IS NULL OR ref_code ~ '^[a-z0-9]{6,16}$');
CREATE UNIQUE INDEX users_ref_code ON users (ref_code) WHERE ref_code IS NOT NULL;

-- Одна атрибуция на приглашённого (first touch wins): referee_user_id UNIQUE, повтор ссылки ничего не меняет.
-- Самоприглашение, команда/тесты (users.is_internal) и уже существующие пользователи не записываются вовсе.
CREATE TABLE referrals (
    id bigserial PRIMARY KEY,
    referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    code text NOT NULL,
    channel text NOT NULL CHECK (channel IN ('web', 'bot', 'miniapp')),
    -- attributed → activated (друг выполнил первый целевой сценарий); held — всплеск по коду, ручная проверка;
    -- rejected — снято вручную или при подтверждённой накрутке (аудит сохраняется).
    status text NOT NULL DEFAULT 'attributed' CHECK (status IN ('attributed', 'activated', 'held', 'rejected')),
    risk_reasons text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    activated_at timestamptz,
    -- Награда (выключено флагом): NULL — не рассматривалась; pending/granted/revoked — см. referral_rewards;
    -- disabled — флаг выключен на момент активации; limit — месячный лимит; held — риск; none — нет права.
    reward_status text CHECK (reward_status IS NULL OR reward_status IN ('pending', 'granted', 'revoked', 'disabled', 'limit', 'held', 'none')),
    reward_id bigint,
    demo boolean NOT NULL DEFAULT false,
    CHECK (referrer_user_id <> referee_user_id)
);
CREATE INDEX referrals_referrer_time ON referrals (referrer_user_id, created_at);
CREATE INDEX referrals_time ON referrals (created_at);
CREATE INDEX referrals_activated ON referrals (activated_at) WHERE activated_at IS NOT NULL;

-- Журнал наград пригласившему (+7 дней Плюса, не больше 4 в месяц). Пока Плюса нет — только запись pending,
-- никакого доступа не выдаётся. Одна награда на атрибуцию (UNIQUE referral_id) — повтор cron/webhook не начисляет дважды.
CREATE TABLE referral_rewards (
    id bigserial PRIMARY KEY,
    referral_id bigint NOT NULL UNIQUE REFERENCES referrals(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'plus_days' CHECK (kind IN ('plus_days')),
    amount integer NOT NULL DEFAULT 7 CHECK (amount > 0 AND amount <= 31),
    -- месяц лимита (YYYY-MM по Москве)
    period text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'revoked', 'expired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- проверка 48 ч после активации друга, затем можно выдавать
    eligible_at timestamptz NOT NULL,
    granted_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz,
    demo boolean NOT NULL DEFAULT false
);
CREATE INDEX referral_rewards_user_period ON referral_rewards (user_id, period);

-- Признаки для конкурсного отчёта: referred — пришёл по приглашению; referral_reward_received — получил
-- (или ждёт) награду. Отчёт может исключить любую комбинацию.
CREATE VIEW user_referral_flags AS
SELECT u.id AS user_id,
       EXISTS (SELECT 1 FROM referrals r WHERE r.referee_user_id = u.id AND r.status <> 'rejected') AS referred,
       EXISTS (SELECT 1 FROM referral_rewards w WHERE w.user_id = u.id AND w.status IN ('pending', 'granted')) AS referral_reward_received
  FROM users u;
