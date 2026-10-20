# Метрики и логи: DAU, обращения, ошибки

Документ отвечает на критерий приёмки 4: где хранятся DAU, частота обращений и ошибки сервиса, как к ним подключиться и как выгрузить. Описано то, что есть в коде сейчас (миграции 001-008), и отдельно — оставшиеся пробелы. Подробности продуктовой аналитики: [ANALYTICS.md](ANALYTICS.md).

> **Статус на 18.10.2026 18:20 МСК.** Миграция 010 (тарифы и AI-ответы: `entitlements`, `ai_token_buckets`, `ai_token_ledger`, `plus_interest`, вид `user_plan_flags`), события `plus_viewed`, `plus_interest`, `tokens_exhausted`, `ai_answer_consumed`, раздел 9 дашборда и выгрузки `plus_interest.csv`, `tokens_daily.csv` есть только в рабочей копии. Оплаты нет (этап 1).
>
> **Статус выкладки на 18.10.2026 04:10 МСК.** Миграция 008 (рефералы: `referrals`, `referral_rewards`, `users.ref_code`) и код реферальной программы есть только в рабочей копии; награды выключены (`REFERRAL_REWARDS_ENABLED` не задан).
>
> **Статус выкладки на 18.10.2026 00:40 МСК.** Миграция 007 (журналы обращений и ошибок, источники трафика, флаг команды) тоже есть только в рабочей копии. Ниже — исходная заметка от 17.10.
>
> **Статус выкладки на 17.10.2026 22:15 МСК.** Онбординг-чат, напоминания, аналитика и дашборд (миграции 004-006, `app/api/v1/onboarding`, `app/api/v1/reminders`, `app/api/v1/analytics`, `app/internal`, `app/api/cron/reminders`) пока лежат в рабочей копии репозитория и не закоммичены. Production на них ещё не обновлён: `GET /api/v1/onboarding`, `/api/v1/reminders`, `/api/v1/analytics` и `/internal/analytics` на https://mozhno-mvp.vercel.app отвечают 404, при этом `/api/health` отвечает 200, а `/api/v1/me` — 401 (маршрут есть). Документы описывают код рабочей копии; чтобы метрики из этого документа появились в проде, нужно закоммитить, выкатить, применить миграции и задать `ANALYTICS_SECRET` и `ANALYTICS_ADMIN_SECRET`.

## 1. Где что хранится

| Что | Хранилище | Таблица / источник | Срок хранения | Доступ |
|---|---|---|---|---|
| Продуктовые события (DAU, сессии, «Можно?», онбординг, напоминания) | Postgres (Neon), `DATABASE_URL` | `analytics_events` (миграция 006) | 180 дней (`lib/retention.ts`) | SQL, `/internal/analytics`, `scripts/export-metrics.ts` |
| Расчёты «Можно?» (вход/выход движка) | Postgres | `decisions` | 30 дней, 365 при `users.history_enabled` | SQL (содержит финансовые данные пользователя, только агрегаты наружу) |
| Фоновые задачи: напоминания | Postgres | `reminder_log` (статус `claimed/sent/failed/skipped`) | 60 дней, «знакомство» 180 | SQL, выгрузка |
| Входящие апдейты Telegram и их ошибки | Postgres | `inbox` (`attempts`, `last_error`, `processed_at`) | обработанные 14 дней, необработанные 7 | SQL, выгрузка |
| Счётчики вызовов API (для лимитов) | Postgres | `rate_limits` (ключ `вид:u:<user_id>`, окно, счётчик) | ~1-2 суток | SQL, выгрузка (только агрегат по виду) |
| Ошибки API (4xx/5xx), бота, cron, отправок напоминаний | Postgres | `service_errors` (миграция 007) | 180 дней | SQL, `/internal/analytics` (раздел 7), `scripts/export-metrics.ts` |
| Журнал обращений: тип, итог, код, HTTP-статус, задержка | Postgres | `service_calls` (миграция 007) | 180 дней | SQL, `/internal/analytics` (раздел 7), выгрузка |
| Источник трафика (первое касание) | Postgres | `user_sources` (миграция 007) | пока жив аккаунт; удаляется при отказе от статистики | SQL, дашборд, выгрузка (агрегат или с псевдонимом) |
| Команда и тестовые аккаунты | Postgres | `users.is_internal`, копия в `analytics_events.internal`, `service_*.internal`, `ai_usage.internal` | — | исключаются по умолчанию |
| Вызовы LLM: модель, токены, стоимость, задержка, итог каждой попытки | Postgres | `ai_usage` (миграция 009) | 180 дней | SQL, `/internal/analytics` (раздел 8), `llm_daily.csv`, `ai_usage_log.csv` |
| Счётчики бюджета LLM (резерв и факт по проекту и пользователю за день МСК, весь бюджет) | Postgres | `budget_buckets` (миграция 009) | дневные 90 дней, накопительный не удаляется | SQL, раздел 8 дашборда |
| Приглашения друзей и награды | Postgres | `referrals`, `referral_rewards`, `users.ref_code`, вид `user_referral_flags` (миграция 008) | пока живы оба аккаунта (каскад при удалении) | SQL, `/internal/analytics` (карточка «Рефералы»), `referrals.csv` |
| Ошибки API, бота, cron (дублирующий поток) | stdout/stderr процесса → Vercel Runtime Logs | `console.error("api error", {requestId, name, code})` и аналоги | по тарифу Vercel | Vercel Dashboard → Logs, `vercel logs`, Log Drains |
| Доступность | HTTP | `GET /api/health` → `{ok}` (200 / 503 без БД) | — | любой внешний монитор |

В логах нет текстов сообщений, сумм и токенов: в `lib/api.ts` пишутся только `requestId`, имя и код ошибки; так же устроены логи бота, вебхука и cron.

## 2. Схема `analytics_events`

```sql
CREATE TABLE analytics_events (
  id          bigserial PRIMARY KEY,
  dedup_key   text NOT NULL UNIQUE,   -- HMAC естественного ключа: повтор вебхука или запроса не создаёт дубль
  name        text NOT NULL,          -- только из allowlist EVENTS (lib/analytics.ts)
  subject     text NOT NULL,          -- псевдоним: HMAC-SHA256(ANALYTICS_SECRET, user_id:epoch), 32 hex
  attempt     text,                   -- псевдоним попытки онбординга
  channel     text NOT NULL CHECK (channel IN ('web','telegram','miniapp','system')),
  source      text NOT NULL CHECK (source IN ('server','client')),
  occurred_at timestamptz NOT NULL,   -- округлено до минуты
  props       jsonb NOT NULL DEFAULT '{}',  -- только значения-перечисления
  demo        boolean NOT NULL DEFAULT false -- синтетика для локальных скриншотов
);
-- + users.analytics_enabled (opt-out), users.analytics_epoch (смена псевдонима после отказа)
```

События и свойства: таблица в [ANALYTICS.md](ANALYTICS.md#события). Ключевые для метрик:

- `user_active` — одна строка на пользователя, канал и UTC-день. Это основа DAU.
- `session_started` — начало сессии, окно 30 минут на канал.
- `purchase_asked` / `purchase_result {verdict, engine}` — вопрос «Можно?» и итог движка; `engine`: `llm` (намерение разобрала LLM), `fallback` (regex-парсер), `api` (прямой вызов `/api/v1/finance/simulations`).
- `onboarding_*` — шаги знакомства; `proposal_*`, `expense_logged` — записи в учёт.
- `reminder_sent / _clicked / _disabled` — фоновые напоминания и реакция.
- `invite_shared {method, surface}`, `invite_opened {result}`, `referral_attributed {via, held}`, `referral_activated`, `referral_reward_pending` — реферальная программа (код и пригласивший в события не попадают).

### Миграция 007: журналы, источники, команда

```sql
ALTER TABLE users ADD COLUMN is_internal boolean NOT NULL DEFAULT false;          -- команда и тесты
ALTER TABLE analytics_events ADD COLUMN internal boolean NOT NULL DEFAULT false;  -- копия флага (псевдоним не соединить с users)
CREATE VIEW analytics_events_real AS SELECT * FROM analytics_events WHERE NOT internal;  -- дашборд читает вид

CREATE TABLE service_calls (            -- одна строка на обращение к компоненту
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,     -- с точностью до секунды
  subject     text,                     -- тот же псевдоним, что в analytics_events; NULL без пользователя или при отказе
  channel     text NOT NULL,            -- web | telegram (бот) | miniapp | cron | system
  call_type   text NOT NULL,            -- allowlist CALL_TYPES (lib/service-log.ts)
  result      text NOT NULL,            -- ok | error
  code        text,                     -- стабильный код ошибки (RATE_LIMITED, INTERNAL, TG_403 …)
  http_status smallint,
  latency_ms  integer,
  internal    boolean NOT NULL DEFAULT false,
  demo        boolean NOT NULL DEFAULT false
);
CREATE TABLE service_errors (           -- ошибки сервиса
  id bigserial PRIMARY KEY, occurred_at timestamptz NOT NULL, subject text,
  channel text NOT NULL, route text NOT NULL,      -- путь API (/api/chat, uuid → :id) или тип (bot.update, reminder.send)
  code text NOT NULL, http_status smallint,
  message text,                                    -- ≤200 символов: шаблон ApiError или имя/код исключения, без ввода
  internal boolean NOT NULL DEFAULT false, demo boolean NOT NULL DEFAULT false
);
CREATE TABLE user_sources (             -- первое касание, одна строка на пользователя
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,                -- web | telegram | miniapp
  source text NOT NULL, medium text, campaign text,   -- [a-z0-9._-], до 40 символов
  referrer_host text,                   -- только домен (без пути и параметров)
  first_seen_at timestamptz NOT NULL, demo boolean NOT NULL DEFAULT false
);
```

Почему не `analytics_events`: события там — только перечисления, время округлено до минуты, дедуп по ключу и полное удаление при отказе. Журналу нужны миллисекунды задержки, HTTP-статус и код ошибки, а строки должны оставаться для подсчёта нагрузки и после отказа (без псевдонима). Поэтому `service_calls` — отдельная узкая таблица, одна вставка на обращение.

Типы обращений (`CALL_TYPES`):

| Тип | Что это | Где пишется |
|---|---|---|
| `chat.question` | вопрос «Можно?» (расчёт движка) | `/api/chat`, бот; тип уточняет `answer()` |
| `chat.message` | прочее сообщение в чате (трата, доход, уточнение) | `/api/chat`, бот |
| `sim.purchase` | прямой расчёт покупки | `POST /api/v1/finance/simulations` |
| `onboarding.turn`, `onboarding.open` | ход и открытие знакомства | `/api/v1/onboarding*`, бот (текст и кнопки) |
| `llm.intent` | операция разбора намерения через LLM (только когда regex не уверен): итог, код, задержка всей цепочки; попытки, токены и стоимость — в `ai_usage` | `lib/llm/client.ts` из `answer()` |
| `llm.stt` | распознавание голоса через учёт LLM (вложенно в `stt` или `bot.voice`) | `lib/llm/stt.ts` |
| `llm.explain`, `llm.compare`, `llm.goal`, `llm.review`, `llm.onboarding` | будущие AI-ответы (объяснение, сравнение, цель, недельный разбор, онбординг); типы и бюджет готовы, вызовов пока нет | `lib/llm/client.ts` |
| `stt` | распознавание голоса | `/api/stt` |
| `plan.view`, `plan.save`, `entry.create`, `proposal.read/confirm/reject` | прогноз, план, записи | API и кнопки бота |
| `reminder.send`, `reminder.click` | отправка напоминания и нажатие кнопки | cron, бот |
| `cron.reminders`, `cron.cleanup` | запуск фоновой задачи целиком | `/api/cron/*` |
| `session.*`, `me`, `account.link`, `reminders.settings`, `analytics.batch`, `analytics.consent` | служебные вызовы | API |
| `bot.start`, `bot.command`, `bot.message`, `bot.voice`, `bot.callback` | входящий апдейт бота, если обработчик не уточнил тип | бот |

Ядро продукта для «обращений на DAU» (`CORE_CALL_TYPES` в `lib/service-metrics.ts`): `chat.question`, `chat.message`, `sim.purchase`, `onboarding.turn`, `stt`, `entry.create`, `proposal.confirm`, `proposal.reject`, `plan.save`, `reminder.send`.

Коды LLM: `LLM_HTTP_<статус>`, `LLM_TIMEOUT`, `LLM_NETWORK`, `LLM_BAD_OUTPUT` — сбой модели (`result='error'`, пишется в `service_errors`); `LLM_BUDGET_PROJECT`, `LLM_BUDGET_USER`, `LLM_BUDGET_TOTAL`, `LLM_BUDGET_UNAVAILABLE` — отказ бюджета: ожидаемая деградация в шаблон, `result='ok'` с кодом, без `service_errors`; `STT_HTTP_<статус>`, `STT_TIMEOUT`, `STT_BUDGET` для голоса.

Коды ошибок — стабильные строки: коды `ApiError` (`RATE_LIMITED`, `INVALID_INPUT`, `UNAUTHORIZED`, `FORBIDDEN_ORIGIN`, `PAYLOAD_TOO_LARGE`, `STALE_PROPOSAL` …), `INTERNAL` (5xx без класса), `DB_UNAVAILABLE`, `STT_UNAVAILABLE`, `STT_FAILED`, `TG_<код Telegram>` и `SEND_UNCERTAIN` для напоминаний, имя исключения в `UPPER_SNAKE` для бота и cron (`TYPE_ERROR`). Ожидаемые `UNAUTHORIZED` и `ONBOARDING_NOT_ACTIVE` считаются в `service_calls`, но не пишутся в `service_errors`.

Как подключено: `apiRoute(type, handler)` (`lib/service-log.ts`) оборачивает все маршруты `/api/*` кроме `/api/health` и вебхука; пользователь берётся из `requireUserId()`, код — из `errorJson`/`handleError` без разбора тела; запись идёт после ответа (`next/server` `after`). Бот: middleware на каждое сообщение и нажатие кнопки (`withCall`), обработчики уточняют тип. Cron и напоминания пишут свои обращения и ошибки. Помощники никогда не бросают исключений; `SERVICE_LOGS_ENABLED=0` выключает запись.

Источник трафика:
- веб: при создании сессии клиент отправляет `utm_source`, `utm_medium`, `utm_campaign` и `document.referrer`; сервер оставляет домен реферера (свой домен — не реферер). Без меток: известные домены → `google`, `yandex`, `telegram`, `vk` …, иначе `referral`; без реферера → `direct`;
- бот: `https://t.me/sber_fin_app_bot?start=src_<источник>__<канал>__<кампания>` (или `?start=<источник>`); `link_*` — привязка, не источник;
- Mini App: `https://t.me/sber_fin_app_bot/<app>?startapp=src_<источник>__<канал>__<кампания>` — `start_param` берётся из подписанного `initData`.

Команда и тесты: `INTERNAL_TELEGRAM_IDS` (бот и Mini App помечают при первом обращении), `INTERNAL_USER_IDS` (uuid из `/api/v1/me`), `INTERNAL_INVITE_CODE` (открыть сайт с `?team=<код>`), cron `/api/cron/cleanup` синхронизирует списки, `scripts/mark-internal.ts` помечает или снимает пометку вручную. При пометке флаг копируется в уже записанные события и журналы (по псевдонимам всех эпох), поэтому исключение действует и задним числом. Бот-аккаунты Telegram не могут писать боту, поэтому в `users` не попадают; синтетика дашборда помечена `demo`.

### Рефералы (миграция 008)

```sql
ALTER TABLE users ADD COLUMN ref_code text;              -- личный код, 8 символов [2-9a-z без i,l,o], UNIQUE, создаётся лениво
CREATE TABLE referrals (
  id bigserial PRIMARY KEY,
  referrer_user_id uuid NOT NULL,                        -- пригласивший
  referee_user_id  uuid NOT NULL UNIQUE,                 -- приглашённый: одна атрибуция, первое касание
  code text NOT NULL, channel text NOT NULL,             -- web | bot | miniapp
  status text NOT NULL,                                  -- attributed | activated | held (всплеск) | rejected
  risk_reasons text[], created_at timestamptz, activated_at timestamptz,
  reward_status text, reward_id bigint, demo boolean     -- disabled | pending | limit | held | none | granted | revoked
);
CREATE TABLE referral_rewards (                          -- награды (выключены флагом REFERRAL_REWARDS_ENABLED)
  id bigserial PRIMARY KEY, referral_id bigint UNIQUE,   -- одна награда на приглашение (идемпотентность)
  user_id uuid, kind text DEFAULT 'plus_days', amount int DEFAULT 7,
  period text,                                           -- YYYY-MM по Москве, лимит 4 в месяц
  status text DEFAULT 'pending', eligible_at timestamptz,-- +48 ч проверки после активации друга
  granted_at, expires_at, revoked_at timestamptz, demo boolean
);
CREATE VIEW user_referral_flags AS SELECT user_id, referred, referral_reward_received ...;  -- признаки для строгого отчёта
```

Правила (`lib/referrals.ts`):
- Вход: бот `/start ref_<код>`, Mini App `startapp=ref_<код>` (из подписанного `initData`), веб `?ref=<код>` → `POST /api/v1/session {ref}` (код переживает перезагрузку в `sessionStorage`, из адресной строки убирается). Формат `ref_<код>[__<кампания>]`, ≤ 64 символов `[A-Za-z0-9_-]`. Первое касание в `user_sources`: `source=referral, medium=invite`; код туда не пишется.
- Засчитывается только новый аккаунт: создан этим входом, не старше `REFERRAL_NEW_USER_MINUTES` (60) и без плана. Самоприглашение, команда/тесты с любой стороны, повторная ссылка (`already`) и неизвестный код не записываются; итог виден в `invite_opened.result`. Больше `REFERRAL_DAILY_LIMIT` (5) атрибуций по коду за 24 ч — `status=held`, `risk_reasons={velocity}`, без награды.
- Активация (`activated_at`): друг завершил знакомство (чат, бот, форма — первый прогноз) или получил первый ответ «Можно?» (чат, бот, `POST /api/v1/finance/simulations`) — то же определение «первой пользы», что в активации дашборда.
- Награды: при `REFERRAL_REWARDS_ENABLED=1` активация друга создаёт строку `pending` в `referral_rewards` (+`REFERRAL_REWARD_DAYS`=7 дней Плюса пригласившему, не больше `REFERRAL_MONTHLY_REWARDS`=4 за месяц, `eligible_at` = активация + `REFERRAL_REWARD_HOLD_HOURS`=48 ч). С миграцией 010 шаг `/api/cron/cleanup` превращает созревшие `pending` в период Плюса (`entitlements.source=referral`, один раз на награду; в бете — после `BETA_ENDS_AT`), награды с неактивированным другом или командой отзываются. С выключенным флагом `reward_status=disabled`, задним числом при включении ничего не начисляется. Приглашённый бонуса не получает.
- Слияние аккаунтов при `/link`: приглашение между двумя аккаунтами одного человека удаляется, приглашённые и награды переходят к оставшемуся аккаунту, код сохраняется.
- Признаки для конкурсного отчёта: `referred` (пришёл по приглашению, не `rejected`) и `referral_reward_received` (есть награда `pending`/`granted`) — вид `user_referral_flags`, колонки в `users_summary.csv` и `referrals_log.csv`.

Карточка «Приглашения друзей» на дашборде (раздел 7): «Нажали «пригласить»» (`invite_shared`, в боте — запрос ссылки `/invite`), делились и открыли, пришли по ссылке, начали пользоваться, «на ручной проверке», «Пришедших на активного» (раньше «K-фактор») ≈ пришедших по приглашениям / активных за период, топ-5 пригласивших по псевдониму (8 символов того же HMAC), разрез по каналам и состояние наград. Значения меньше `ANALYTICS_MIN_COHORT` показаны как «<5»; команда и тесты исключены (обе стороны), `?int=1` включает.

### Тарифы и AI-ответы (миграция 010)

```sql
CREATE TABLE entitlements (        -- периоды Плюса: referral | manual (paid — зарезервировано, кода оплаты нет)
  id uuid PK, user_id, plan ('beta_plus'|'plus'), source, starts_at, ends_at, referral_reward_id UNIQUE, idempotency_key UNIQUE, note, revoked_at, demo);
CREATE TABLE ai_token_buckets (    -- счётчики: day | window (30 дн.) | voice_day | voice_window (секунды); дни по Москве
  user_id, period_kind, period_start date, used, reserved, demo, PRIMARY KEY (user_id, period_kind, period_start));
CREATE TABLE ai_token_ledger (     -- 1 строка на AI-ответ: reserved → consumed | released; request_id = request_id в ai_usage
  request_id PK, user_id, plan, purpose, day, window_start, status, created_at, settled_at, demo);
CREATE TABLE plus_interest (       -- заявка «Хочу Плюс»: одна на пользователя, повтор обновляет цену (updates+1)
  user_id PK, price_choice NULL, offered_price, variant, channel, created_at, updated_at, updates, demo);
CREATE VIEW user_plan_flags AS ... -- ever_paid (всегда false на этапе 1), entitlement_source (paid > referral > manual), plus_interest
```

- Бета-Плюс — вычисляется в коде (`PLANS_MODE=beta`), строк в `entitlements` нет.
- Списание атомарное: `INSERT … ON CONFLICT DO UPDATE … WHERE used+reserved+1 <= limit` сначала окна, потом дня, в одной транзакции; ответ модели — списание, сбой или неверный ответ — возврат; зависшие резервы (`PLANS_RESERVATION_TTL_SEC`) возвращаются в запросе и в cron.
- События (закрытый список, без сумм и текстов): `plus_viewed {surface: counter|menu|exhausted|answer|bot}` (клиент и бот), `plus_interest {price: 149…699|none, repeat}`, `tokens_exhausted {plan, scope: day|window}` (не больше одного на человека за день и лимит), `ai_answer_consumed {purpose, plan}`.
- Хранение: `ai_token_buckets` 90 дней, `ai_token_ledger` 180 дней (`lib/retention.ts`).

Раздел 9 дашборда «Плюс и AI-ответы»: открыли «Плюс» (люди и просмотры, где открывали), «Оставили заявку» и конверсия (заявки / открывшие), «Последний выбор цены» (группы меньше `ANALYTICS_MIN_COHORT` — «<5»), AI-ответов и на DAU в день, доля активных, упёршихся в лимит, на что тратят, AI-ответы по дням. Команда и тесты исключены (`?int=1` включает). Код: `lib/plans/metrics.ts`.

## 3. Псевдонимы и приватность

- В событиях нет `user_id`, Telegram ID, IP, user-agent, текстов и сумм. Значение свойства вне перечисления отклоняет всё событие.
- `subject = HMAC-SHA256(ANALYTICS_SECRET, "subject:<user_id>:<epoch>")`. Без `ANALYTICS_SECRET` в production аналитика выключена. `ANALYTICS_ENABLED=0` выключает принудительно.
- Отказ (`/privacy` в боте, тумблер в настройках, `PUT /api/v1/analytics/consent`) удаляет события текущего псевдонима и увеличивает `analytics_epoch`.
- Удаление аккаунта удаляет события по всем эпохам (`forgetAnalytics`).
- На дашборде группы меньше `ANALYTICS_MIN_COHORT` (5) скрыты.
- Журналы `service_calls` и `service_errors` используют тот же псевдоним. Отказ от статистики обнуляет `subject` в журналах (строки остаются для подсчёта нагрузки) и удаляет `user_sources`; новые строки пишутся без псевдонима. Кэш псевдонимов журнала живёт 60 секунд на инстанс.
- В `service_errors.message` — только шаблонный текст наших `ApiError` или имя/код исключения; дополнительно вырезаются числа, e-mail, URL и токены. Текст исключений PG и SDK не сохраняется: он может содержать ввод пользователя.

## 4. Определения метрик

| Метрика | Определение | Источник |
|---|---|---|
| DAU | `count(DISTINCT subject)` по `user_active` за UTC-день (по всем каналам или по одному) | `analytics_events` |
| WAU | то же за 7 дней | `analytics_events` |
| Сессий на DAU | `session_started` / DAU | `analytics_events` |
| Вопросов «Можно?» на DAU (на дашборде — «Вопросов «Можно?» на активного в неделю», см. ANALYTICS.md) | `purchase_result` / DAU | `analytics_events` |
| Вызовов LLM на DAU | операций (`count(DISTINCT request_id)` без `budget_denied`) / сумма дневных DAU. Старое приближение — `purchase_result` с `engine='llm'` / DAU | `ai_usage`, `analytics_events` |
| Стоимость LLM на DAU | `sum(ai_usage.cost_microrub) / 10^6` за день / DAU того же дня (SQL — [LLM-COST.md §7](LLM-COST.md#7-как-измеряется-фактический-расход)); дашборд — за период / сумма дневных DAU | `ai_usage`, `analytics_events` |
| Доля резервной модели (на дашборде — «Ответы запасной модели») | операций, ответ которых дала не первая модель цепочки (`status='fallback'`) / успешных операций | `ai_usage` |
| Отказы бюджета LLM (на дашборде — «Отказы по бюджету») | строки `status='budget_denied'` по `error_code` (проект, пользователь, весь бюджет) | `ai_usage` |
| Обращений к движку на DAU | `purchase_result` (все `engine`) / DAU. Пересчёты прогноза при открытии экрана не логируются, см. пробелы | `analytics_events` |
| Обращений к боту на DAU (Telegram) | события канала `telegram` / DAU telegram | `analytics_events` |
| Фоновых задач на DAU | `reminder_sent` / DAU; ошибки — `reminder_log.status='failed'` | `analytics_events`, `reminder_log` |
| Вызовов API за сутки | сумма `rate_limits.count` по виду (`chat`, `sim`, `write`, `an`, `plan`, `stt`, `session`) | `rate_limits` |
| Ошибки вебхука Telegram | `inbox.last_error IS NOT NULL` или необработанные после 3 попыток | `inbox` |
| Ошибки API (4xx/5xx), бота, cron | `service_errors` по дням, каналам, кодам; доля ошибок — `service_calls.result='error'` / все обращения | `service_errors`, `service_calls` |
| Вызовов ядра на DAU (на дашборде — «Вызовов на активного/день») | `service_calls` с типом из `CORE_CALL_TYPES` / сумма дневных DAU | `service_calls`, `analytics_events` |
| Задержка p50/p95 | `percentile_cont` по `latency_ms` за день и тип | `service_calls` |
| Источники трафика | `user_sources` по `source/medium/campaign` и каналу первого касания | `user_sources` |
| Реальные пользователи | активные (`user_active`) без `internal`; всего — `users` без `is_internal` и удалённых | `analytics_events_real`, `users` |

## 5. SQL для подключения

Подключение: любая Postgres-совместимая BI (Metabase, DataLens, Superset, Grafana) к read-only роли Neon. Пример создания роли (выполняет владелец БД):

```sql
CREATE ROLE metrics_ro LOGIN PASSWORD '<задать>';
GRANT USAGE ON SCHEMA public TO metrics_ro;
GRANT SELECT ON analytics_events, analytics_events_real, reminder_log, inbox, rate_limits, service_calls, service_errors TO metrics_ro;
-- источники: без user_id, только агрегат
CREATE VIEW user_sources_agg AS SELECT date_trunc('day', s.first_seen_at) AS day, s.channel, s.source, s.medium, s.campaign, s.referrer_host, count(*) AS users
  FROM user_sources s JOIN users u ON u.id = s.user_id WHERE NOT u.is_internal AND NOT s.demo GROUP BY 1, 2, 3, 4, 5, 6;
GRANT SELECT ON user_sources_agg TO metrics_ro;
```

Роли нужен доступ только к этим таблицам: `decisions`, `books`, `ledger_entries` содержат финансовые данные пользователей, а `user_sources` — `user_id` (поэтому наружу только вид-агрегат).

Во всех запросах ниже команда и тесты исключаются условием `NOT internal` (или чтением `analytics_events_real`).

DAU по дням и каналам:

```sql
SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, channel,
       count(DISTINCT subject) AS dau
FROM analytics_events
WHERE name = 'user_active' AND NOT demo AND NOT internal AND occurred_at >= now() - interval '30 days'
GROUP BY 1, 2 ORDER BY 1, 2;
```

Обращения на DAU:

```sql
WITH d AS (
  SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
         count(DISTINCT subject) FILTER (WHERE name = 'user_active')            AS dau,
         count(*) FILTER (WHERE name = 'session_started')                         AS sessions,
         count(*) FILTER (WHERE name = 'purchase_result')                         AS engine_checks,
         count(*) FILTER (WHERE name = 'purchase_result' AND props->>'engine' = 'llm') AS llm_calls,
         count(*) FILTER (WHERE channel = 'telegram')                             AS bot_events,
         count(*) FILTER (WHERE name = 'reminder_sent')                           AS reminders
  FROM analytics_events WHERE NOT demo AND occurred_at >= now() - interval '30 days'
  GROUP BY 1)
SELECT day, dau,
       round(sessions::numeric / NULLIF(dau,0), 2)      AS sessions_per_dau,
       round(engine_checks::numeric / NULLIF(dau,0), 2) AS engine_per_dau,
       round(llm_calls::numeric / NULLIF(dau,0), 2)     AS llm_per_dau,
       round(bot_events::numeric / NULLIF(dau,0), 2)    AS bot_events_per_dau,
       round(reminders::numeric / NULLIF(dau,0), 2)     AS reminders_per_dau
FROM d ORDER BY day;
```

Распределение частоты вопросов «Можно?» за 7 дней (сколько пользователей спросили 1, 2-3, 4+ раз):

```sql
SELECT CASE WHEN n = 1 THEN '1' WHEN n <= 3 THEN '2-3' ELSE '4+' END AS bucket, count(*) AS users
FROM (SELECT subject, count(*) n FROM analytics_events
      WHERE name = 'purchase_asked' AND NOT demo AND occurred_at >= now() - interval '7 days'
      GROUP BY subject) t
GROUP BY 1 ORDER BY 1;
```

Ошибки фоновых задач и вебхука:

```sql
SELECT local_day, kind, status, count(*) FROM reminder_log
WHERE created_at >= now() - interval '30 days' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

SELECT (received_at AT TIME ZONE 'UTC')::date AS day,
       count(*) FILTER (WHERE last_error IS NOT NULL) AS failed,
       count(*) FILTER (WHERE processed_at IS NULL)   AS pending,
       count(*)                                       AS total
FROM inbox GROUP BY 1 ORDER BY 1;
```

Обращения, ошибки и задержка по дням и типам (журнал `service_calls`):

```sql
SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, channel, call_type,
       count(*) AS calls,
       count(*) FILTER (WHERE result = 'error') AS errors,
       round(count(*) FILTER (WHERE result = 'error')::numeric / count(*), 4) AS error_rate,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
FROM service_calls
WHERE NOT internal AND NOT demo AND occurred_at >= now() - interval '30 days'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

Обращений к ядру на DAU:

```sql
WITH c AS (SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS core_calls FROM service_calls
           WHERE NOT internal AND NOT demo AND call_type IN ('chat.question','chat.message','sim.purchase','onboarding.turn','stt',
                 'entry.create','proposal.confirm','proposal.reject','plan.save','reminder.send') GROUP BY 1),
     d AS (SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, count(DISTINCT subject) AS dau FROM analytics_events_real
           WHERE name = 'user_active' AND NOT demo GROUP BY 1)
SELECT d.day, d.dau, c.core_calls, round(c.core_calls::numeric / NULLIF(d.dau, 0), 2) AS core_calls_per_dau
FROM d LEFT JOIN c USING (day) ORDER BY d.day;
```

Ошибки по кодам за 7 дней:

```sql
SELECT code, http_status, channel, route, count(*) AS n, max(occurred_at) AS last_seen
FROM service_errors WHERE NOT internal AND NOT demo AND occurred_at >= now() - interval '7 days'
GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 20;
```

Источники первого касания и активация по источнику (из-под владельца БД: нужен `users`):

```sql
SELECT s.channel, s.source, coalesce(s.medium, '') AS medium, coalesce(s.campaign, '') AS campaign, count(*) AS users
FROM user_sources s JOIN users u ON u.id = s.user_id
WHERE NOT u.is_internal AND NOT s.demo AND s.first_seen_at >= now() - interval '30 days'
GROUP BY 1, 2, 3, 4 ORDER BY users DESC;
```

Реальные пользователи (без команды и тестов):

```sql
SELECT count(*) FILTER (WHERE NOT is_internal) AS real_users, count(*) FILTER (WHERE is_internal) AS team_and_test
FROM users WHERE deleted_at IS NULL;
```

Вызовы API за последние сутки по видам (из счётчиков лимитов; пользователь в выборку не попадает):

```sql
SELECT date_trunc('hour', window_start) AS hour, split_part(key, ':', 1) AS kind, sum(count) AS requests
FROM rate_limits WHERE key LIKE '%:u:%' GROUP BY 1, 2 ORDER BY 1, 2;
```

## 6. Выгрузка в CSV

```bash
DATABASE_URL=postgres://... npx tsx scripts/export-metrics.ts --days 30 --out ./metrics-export
# локально без DATABASE_URL читается PGlite из .data/pglite; --include-demo — включить синтетику
```

Скрипт пишет `daily_activity.csv`, `daily_calls.csv`, `events_by_name.csv`, `background_jobs.csv`, `telegram_inbox.csv`, `api_calls_recent.csv`, а с миграциями 007-009 ещё:

| Файл | Содержимое |
|---|---|
| `calls_daily.csv` | день, канал, тип обращения, обращений, ошибок, доля ошибок, p50/p95 задержки (мс), DAU канала, обращений на DAU |
| `errors_daily.csv` | день, канал, маршрут/тип, код ошибки, HTTP-статус, количество |
| `sources.csv` | день первого касания, канал, `source`, `medium`, `campaign`, домен реферера, пользователей |
| `users_summary.csv` | всего пользователей, реальных, команды/тестов, новых реальных за период, реальных с известным источником, пришедших по приглашению (`referred`), с наградой (`referral_reward_received`) |
| `llm_daily.csv` | день бюджета (МСК), канал, назначение, модель: операций, попыток, `ok` / `fallback` / ошибок / таймаутов / отказов бюджета, токены вход/выход, секунды голоса, строк с оценкой токенов, стоимость в ₽ и копейках, p50/p95 (мс), DAU канала, ₽ на DAU канала за день (миграция 009) |
| `plus_interest.csv` | день заявки (МСК), канал, показанная цена, вариант, выбранная цена (пусто — «не знаю»), заявок, меняли выбор (миграция 010) |
| `tokens_daily.csv` | день (МСК), тариф, назначение: AI-ответов списано / возвращено, пользователей; DAU дня, AI-ответов на DAU, упёрлись в лимит (миграция 010) |
| `referrals.csv` | день приглашения, канал (`web`/`bot`/`miniapp`), статус, пришло, начали пользоваться, наград в ожидании, упёрлись в лимит, пригласивших |

По умолчанию в файлах только агрегаты, без псевдонимов и идентификаторов. Флаг `--raw` добавляет построчные журналы с псевдонимом (тот же HMAC, что в событиях; `user_id`, тексты и суммы в файлы не попадают): `calls_log.csv` (время UTC, псевдоним, канал, тип, итог, код, HTTP-статус, задержка), `errors_log.csv` (время, псевдоним, канал, маршрут, код, статус, короткое сообщение), `sources_log.csv` (время первого касания, псевдоним, канал, источник), `referrals_log.csv` (время, псевдонимы пригласившего и приглашённого, канал, статус, риск, активация, награда, признаки `referred` / `referral_reward_received`), `ai_usage_log.csv` (каждая попытка вызова LLM: время, день бюджета, `request_id`, попытка, псевдоним, канал, назначение, провайдер, модель, токены, аудио, стоимость в µ₽ и копейках, резерв, версия цены, задержка, итог, код, `fallback_from`, `ai_answer`). Для `sources_log.csv` нужен тот же `ANALYTICS_SECRET`, что у приложения.

Команда и тесты исключены везде; `--include-internal` включает их, `--include-demo` — синтетику.

```bash
DATABASE_URL=postgres://... ANALYTICS_SECRET=... npx tsx scripts/export-metrics.ts --days 30 --out ./metrics-export --raw
```

Скрипт проверен на локальной базе нагрузочного теста ([LOAD-TEST.md](LOAD-TEST.md)) и на демо-базе журналов (18.10.2026: 13 файлов, `calls_log.csv` ~14 тыс. строк за 30 дней).

Дашборд `/internal/analytics` (доступ по `ANALYTICS_ADMIN_SECRET`, admin-cookie на 12 часов) показывает DAU/WAU, активацию, воронку знакомства, когорты D1/D7/D14/D30, частоту «Можно?», CTR напоминаний, разрез по каналам, раздел 7 «Сервис и привлечение» (карточка «Ошибки и вызовы»: «Вызовы с ошибкой», «Вызовов на активного/день» — только вызовы ядра; p50/p95, ошибки по дням и частые коды, карточка «Откуда приходят пользователи»: первый канал, источники первого касания — `referral` с `medium=invite` подписан «Приглашения друзей», остальные `referral` — «Другие сайты», — и «Активных без команды») и раздел 8 «Модели и расходы» (расход сегодня к дневному потолку, весь бюджет 50/75 тыс. ₽, «₽ на активного/день», «Токены модели», вызовы по моделям, «Ответы запасной модели», «Отказы по бюджету», p95 ответа модели) и раздел 9 «Плюс и AI-ответы» (интерес к Плюсу, последний выбор цены, AI-ответы на активного, «Достигли лимита AI-ответов»). Команда и тесты исключены везде; ссылка в карточке источников (`?int=1`) включает их. Графики: серверный SVG и ECharts (лениво загружаемый модуль `live-echarts.ts`).

## 7. Пробелы: что закрыто в 007-009 и что осталось

| # | Пробел | Статус | Что сделано / что осталось |
|---|---|---|---|
| 1 | Ошибки API, бота и cron не пишутся в БД | **закрыт** | `service_errors`: время, псевдоним, канал, маршрут, код, HTTP-статус, короткое сообщение. Пишет `apiRoute` (все маршруты `/api/*`), бот, вебхук, cron, отправка напоминаний. Выбрана построчная таблица вместо агрегата по минутам: нужен псевдоним для связи с DAU. |
| 2 | Нет журнала вызовов LLM | **закрыт (009)** | `ai_usage`: каждая попытка вызова — назначение, провайдер, модель, токены из `usage` ответа (или оценка с флагом), стоимость по таблице цен, резерв, задержка, итог (`ok/fallback/error/timeout/budget_denied`), код, `fallback_from`. Плюс `service_calls` (`llm.intent`, `llm.stt`, …) на операцию. Стоимость на DAU теперь измеряется: раздел 8 дашборда, `llm_daily.csv`, SQL в [LLM-COST.md §7](LLM-COST.md#7-как-измеряется-фактический-расход). Пока ключ акселератора не получен, журнал пуст (LLM не вызывается). |
| 3 | Нет источника трафика | **закрыт** | `user_sources`: UTM и домен реферера при первом визите в веб, `/start src_…` в боте, `startapp` в Mini App. Одна строка на пользователя. |
| 4 | Нет флага команды и тестов | **закрыт** | `users.is_internal` + копия `internal` в событиях и журналах; `INTERNAL_TELEGRAM_IDS`, `INTERNAL_USER_IDS`, `INTERNAL_INVITE_CODE`, `scripts/mark-internal.ts`. Исключены по умолчанию на дашборде (вид `analytics_events_real`) и в выгрузке (`--include-internal`). |
| 5 | Пересчёты прогноза не считаются как обращения | **закрыт в основном** | Открытие экрана (`/api/profile`, `/api/v1/finance/snapshot`) → `plan.view`, команды бота → `bot.command`. Отдельно не выделен показ предварительного прогноза в знакомстве: он внутри `onboarding.turn`. |
| 6 | Итог запуска cron не хранится | **частично** | Каждый запуск — строка `cron.reminders` / `cron.cleanup` с итогом и задержкой, каждая отправка — `reminder.send` с кодом Telegram. Счётчики запуска (`users/sent/failed`) целиком не сохраняются (нет `job_runs.stats`). |
| 7 | Задержки API не хранятся | **закрыт** | `service_calls.latency_ms` на каждое обращение; p50/p95 на дашборде и в `calls_daily.csv`. Задержка — время обработчика, без сети до клиента. |

Остаётся вне кода: read-only роль Neon для BI (SQL выше) и Vercel Log Drain как резервный поток, если нужен.
