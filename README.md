# Можно? — личный финансовый коуч

Sber500 x DISRUPT, трек 1, гипотеза «Личный финансовый коуч».

**Прод:** https://mozhno-mvp.vercel.app · **Telegram:** [@sber_fin_app_bot](https://t.me/sber_fin_app_bot) (бот и Mini App) · **Презентация:** [PDF](presentation.pdf), [PowerPoint](presentation.pptx), [аниме-версия, PDF](presentation-product-anime.pdf)

«Можно?» отвечает на вопрос, который человек задаёт себе перед покупкой: «Могу ли я сейчас купить телефон за 60 000 рублей?». Ответ учитывает остаток, ближайший доход, обязательные платежи, резерв и цель: сколько свободных денег останется, как изменится безопасная сумма на день, не будет ли кассового разрыва до дохода и не станет ли лучше, если подождать. Решение остаётся за пользователем.

Все финансовые числа считает детерминированный движок (`lib/engine`, деньги в копейках). LLM, если она включена, только разбирает запрос; ответ с цифрами строится шаблоном из результата движка. Без ключа LLM сервис полностью работает на regex-парсере и шаблонах.

Контекст заявки (команда, аудитория, план программы) перенесён без изменений в [docs/APPLICATION.md](docs/APPLICATION.md). Образ результата MVP: [docs/MVP-OUTCOME.md](docs/MVP-OUTCOME.md).

## Core Product Loop

1. **Знакомство** (один раз, чат в вебе или в боте): остаток, ближайший доход, обязательные платежи, резерв, траты на необходимое в день, цель. После минимума (остаток + доход или период) сразу показывается предварительный прогноз.
2. **Сегодня:** сколько можно тратить в день до дохода (на еду, транспорт и покупки) и сколько остаётся на покупки до дохода. «Как считаем» показывает расчёт: на карте − платежи до дохода − резерв − на цель = на жизнь до дохода.
3. **«Можно?»** перед покупкой: текстом или голосом. Ответ: вердикт («Можно: <что> за <цену> — в рамках плана»), блок «Если купить · до <даты>» — «Можно тратить в день» и «На покупки до дохода» было → станет, сценарий «после дохода».
4. **Запись** трат и доходов («потратил 500 на кофе», «зарплата пришла»): бот предлагает запись, она применяется только после кнопки «Записать», план пересчитывается.
5. **Мягкие напоминания** в Telegram: платёж завтра, день дохода, незавершённое знакомство (по желанию: записать траты, план недели, утро). Не больше одного сообщения в день.
6. Пользователь возвращается к шагу 2-3.

## Что реализовано

| Возможность | Где в коде |
|---|---|
| Детерминированный движок: прогноз по контрольным точкам, безопасная сумма на день, кассовый разрыв, резерв и цель, симуляция покупки и альтернатив, подписки | `lib/engine/*` |
| Чат-знакомство (общий для веба и бота), правка одного слота, предварительный прогноз | `lib/onboarding/*`, `app/onboarding-chat.tsx`, `/api/v1/onboarding` |
| Вопрос «Можно?» в чате и структурированный API | `lib/coach.ts`, `/api/chat`, `/api/v1/finance/simulations` |
| Разбор сумм и дат («15к», «1,5 млн», «5 ноября», «через 10 дней») | `lib/parse.ts` |
| LLM-слой (опционально): единый OpenAI-совместимый клиент, цепочка моделей, атомарные бюджеты, журнал стоимости `ai_usage`; regex первым, LLM только при неуверенном разборе; STT для голоса через тот же учёт | `lib/llm/*`, `/api/stt`, раздел 8 `/internal/analytics` |
| Предложения записей с подтверждением и идемпотентностью | `lib/proposals.ts`, `/api/v1/proposals` |
| Telegram-бот: `/start`, `/setup`, `/status`, `/reminders`, `/privacy`, `/link`, `/cancel`, текст и голос | `lib/bot.ts`, `/api/telegram` |
| Mini App: вход по `initData` с проверкой HMAC | `/api/v1/session/telegram` |
| Привязка веба к Telegram: одноразовый код + подтверждение кнопкой в боте | `lib/auth.ts`, `/api/v1/account-links` |
| Напоминания по cron, настройки, тихие часы, дедуп | `lib/reminders.ts`, `/api/cron/reminders`, `/api/v1/reminders` |
| Продуктовая аналитика в собственной БД, псевдонимы, opt-out, дашборд | `lib/analytics*.ts`, `/api/v1/analytics`, `/internal/analytics` |
| Retention данных, лимиты запросов в Postgres | `lib/retention.ts`, `lib/rate-limit.ts`, `/api/cron/cleanup` |

Чего пока нет: подключённой LLM-политики онбординга (`LlmPolicy` — заглушка, работает `RulePolicy`), LLM-объяснений (ответы шаблонные; назначения `explain`/`compare`/`goal_chat`/`weekly_review` и бюджет под них готовы), квот AI-ответов (хуки `setLlmHooks` готовы), импорта чеков и выписок, нативных приложений iOS/Android, регулярных правил `recurrence_rules`. Полный список хвостов: [docs/BACKEND.md](docs/BACKEND.md#что-осталось-шаги-7-и-хвосты).

## Каналы

| Канал | Как работает |
|---|---|
| Веб | https://mozhno-mvp.vercel.app, анонимная сессия (`POST /api/v1/session`, cookie `mozhno_sid`) |
| Telegram-бот | @sber_fin_app_bot, webhook `/api/telegram` с секретом, durable inbox с повторами |
| Telegram Mini App | та же веб-страница внутри Telegram, сессия Telegram-аккаунта |
| Общий аккаунт | веб привязывается к Telegram через `/link`, данные общие |

## Стек

Next.js 15 (App Router) · React 19 · TypeScript · Postgres (Neon) через `pg` в production, PGlite (Postgres в WASM) локально и в тестах · grammY · Vercel AI SDK (`ai`, `@ai-sdk/openai`) · zod · ECharts (дашборд) · vitest · ESLint · Vercel (хостинг, Cron) · GitHub Actions (CI).

## Быстрый старт

Нужен Node.js 22 (как в CI; на Node 20 сборка и тесты тоже проходят).

```bash
npm install
npm test                 # vitest, без сети и ключей
npm run dev              # http://localhost:3000, данные в PGlite (.data/pglite)
```

Production-сборка локально:

```bash
npm run build && npm start                     # порт 3000
NEXT_DIST_DIR=.next-build npm run build        # отдельный каталог сборки, не мешает next dev
```

Бот локально (polling, без вебхука):

```bash
TELEGRAM_BOT_TOKEN=<токен тестового бота> npm run bot:poll
```

Проверка API без ключей:

```bash
curl -c j -b j -X POST localhost:3000/api/v1/session -H 'Origin: http://localhost:3000'
curl -c j -b j -X POST localhost:3000/api/profile -H 'Origin: http://localhost:3000' -H 'content-type: application/json' \
  -d '{"balance":60000,"reserve":10000,"nextIncome":{"date":"2026-10-30","amount":80000},"payments":[{"name":"Аренда","amount":30000,"date":"2026-10-25"}]}'
curl -c j -b j -X POST localhost:3000/api/chat -H 'Origin: http://localhost:3000' -H 'content-type: application/json' \
  -d '{"message":"Можно купить наушники за 15 000?"}'
```

Демо-данные для дашборда аналитики (только локальный PGlite под /tmp): см. [docs/ANALYTICS.md](docs/ANALYTICS.md#дашборд).

## Переменные окружения

Шаблон: [.env.example](.env.example). Значения в репозиторий не коммитятся.

| Переменная | Обязательна | Назначение |
|---|---|---|
| `DATABASE_URL` (или `POSTGRES_URL`) | production | Postgres. Без неё в production `/api/health` и API отвечают 503 |
| `DATABASE_SSL` | нет | `disable` для локального Postgres без TLS, `require` — форсировать TLS |
| `DATABASE_POOL_MAX` | нет | размер пула на инстанс, по умолчанию 5 |
| `MOZHNO_AUTO_MIGRATE` | нет | `1` — применять миграции при первом подключении |
| `MOZHNO_DB`, `PGLITE_DIR` | нет | явный PGlite и его каталог (`memory://` для тестов) |
| `APP_ORIGIN` | рекомендуется | разрешённые Origin через запятую |
| `TRUST_PROXY` | нет | `vercel` (по умолчанию на Vercel), число доверенных прокси или `none` |
| `TELEGRAM_BOT_TOKEN` | для бота | токен бота |
| `TELEGRAM_BOT_USERNAME` | рекомендуется | имя бота без @ для deep link привязки |
| `TELEGRAM_WEBHOOK_SECRET` | production для бота | секрет вебхука, без него вебхук отвечает 503 |
| `CRON_SECRET` | для cron | включает `/api/cron/cleanup` и `/api/cron/reminders` |
| `REMINDERS_RUNNER` | нет | `hourly`, если настроен почасовой внешний вызов cron |
| `LLM_API_KEY` (или `OPENAI_API_KEY`) | нет | ключ LLM; без него regex-парсер и шаблоны |
| `LLM_BASE_URL` | нет | OpenAI-совместимый шлюз (прокси акселератора `https://shared1.multitool.works:4000/v1`); без него — OpenAI |
| `LLM_MODEL_PRIMARY` (прежнее `LLM_MODEL`), `LLM_MODEL_FALLBACKS`, `LLM_MODEL_INTENT` | нет | основная модель, резервные через запятую, малая модель для разбора намерения. Со шлюзом по умолчанию `gigachat3.5-432b-a28b` → `qwen3.5-397b-a17b,deepseek-v4-pro`; без шлюза `gpt-4o-mini` без резерва |
| `LLM_ENABLED` | нет | `0` — выключатель: ни одного вызова модели, ответы шаблонные |
| `LLM_DAILY_BUDGET_RUB`, `LLM_USER_DAILY_SOFT_CAP_RUB`, `LLM_TOTAL_BUDGET_RUB`, `LLM_TOTAL_BUDGET_MAX_RUB`, `LLM_BUDGET_START` | нет | потолок проекта в день по Москве (2850), мягкий лимит пользователя в день (3, `0` — без лимита), весь бюджет (50000) и расширенный для показа (75000), дата начала бюджета |
| `LLM_TIMEOUT_MS`, `LLM_TOTAL_TIMEOUT_MS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_MAX_INPUT_CHARS`, `LLM_JSON_MODE` | нет | таймаут попытки (8000) и цепочки (15000), потолок `max_tokens` (800), длина входа (6000), `0` — без `response_format` |
| `LLM_PRICES`, `LLM_PRICE_MARKUP`, `LLM_PROVIDER` | нет | переопределение цен (JSON, коп. за 1 млн токенов с НДС), коэффициент комиссии прокси, метка провайдера в журнале |
| `STT_API_KEY`, `STT_BASE_URL`, `STT_MODEL`, `STT_TIMEOUT_MS`, `STT_PRICE_KOP_PER_SEC`, `STT_ENABLED` | нет | распознавание речи (по умолчанию `whisper-1`, 0,61 коп./с); при одном `LLM_API_KEY` голос идёт в `LLM_BASE_URL`; `STT_ENABLED=0` выключает только голос |
| `ANALYTICS_SECRET` | production для аналитики | ключ HMAC псевдонимов (≥16 символов); без него в production аналитика выключена |
| `ANALYTICS_ENABLED` | нет | `0` — выключить аналитику |
| `ANALYTICS_ADMIN_SECRET` | для дашборда | ключ входа в `/internal/analytics`; без него маршрут отвечает 404 |
| `ANALYTICS_MIN_COHORT` | нет | минимальный размер группы на дашборде, по умолчанию 5 |
| `SERVICE_LOGS_ENABLED` | нет | `0` — не писать журналы обращений и ошибок (`service_calls`, `service_errors`) |
| `INTERNAL_TELEGRAM_IDS` | нет | Telegram ID команды и тестеров через запятую: помечаются `users.is_internal` и исключаются из метрик |
| `INTERNAL_USER_IDS` | нет | id пользователей (uuid) команды и тестеров через запятую, например веб-тестеры |
| `INTERNAL_INVITE_CODE` | нет | код (≥12 символов): открыть сайт с `?team=<код>` один раз, и текущий веб-пользователь помечен как команда |
| `REFERRAL_REWARDS_ENABLED` | нет | `1` — включить награды пригласившему: созревшая запись `pending` в `referral_rewards` превращается в +7 дней Плюса (`entitlements`, шаг `/api/cron/cleanup`). По умолчанию выключено |
| `PLANS_MODE` | нет | `beta` (по умолчанию) — у всех Бета-Плюс, цены только показываются «после беты»; `live` — Free/Плюс по правам (`entitlements`). Оплаты нет в обоих режимах |
| `BETA_ENDS_AT` | нет | `YYYY-MM-DD` последний день беты (МСК): показывается в «Плюсе»; дни Плюса за друзей начинаются после него |
| `BETA_AI_ANSWERS_PER_DAY`, `BETA_AI_ANSWERS_PER_30D` | нет | AI-ответов в бете: 15 в день, без 30-дневного лимита (`0` — без лимита) |
| `FREE_AI_ANSWERS_PER_DAY`, `FREE_AI_ANSWERS_PER_30D`, `FREE_VOICE_MIN_PER_30D`, `FREE_VOICE_MIN_PER_DAY` | нет | Free после беты: не больше 10 в день и 60 за 30 дней, голос 2 мин за 30 дней (в день без лимита) |
| `PLUS_AI_ANSWERS_PER_DAY`, `PLUS_AI_ANSWERS_PER_30D`, `PLUS_VOICE_MIN_PER_30D`, `PLUS_VOICE_MIN_PER_DAY` | нет | Плюс (и голос беты): 30 в день, 300 за 30 дней, голос 30 мин за 30 дней и 3 мин в день |
| `PLANS_WINDOW_DAYS` | нет | длина окна «за 30 дней» (30); окна идут от дня регистрации или начала периода Плюса, по Москве |
| `PLUS_PRICE_RUB`, `PLUS_PERIOD_DAYS` | нет | цена Плюса после беты (399) за период (30 дней), без автопродления — только показ |
| `PLUS_PRICE_OPTIONS`, `PLUS_PRICE_EXPERIMENT` | нет | варианты «честной цены» в заявке (`299,399,499`, только из 149…699); `1` — показывать каждому стабильно одну из них (вариант `p<цена>`) |
| `PLANS_RESERVATION_TTL_SEC`, `PLANS_LOW_THRESHOLD` | нет | через сколько секунд незавершённый резерв AI-ответа возвращается (120); с какого остатка показывать «осталось N» (3) |
| `REFERRAL_DAILY_LIMIT` | нет | атрибуций по одному коду за сутки, сверх — `held` (ручная проверка), по умолчанию 5 |
| `REFERRAL_MONTHLY_REWARDS`, `REFERRAL_REWARD_DAYS`, `REFERRAL_REWARD_HOLD_HOURS` | нет | лимит наград в месяц (4), дней Плюса за друга (7), проверка перед выдачей в часах (48) |
| `REFERRAL_NEW_USER_MINUTES` | нет | окно «нового пользователя» для атрибуции, по умолчанию 60 минут |
| `TELEGRAM_MINIAPP_SHORT_NAME` | нет | короткое имя Mini App: включает ссылку `t.me/<бот>/<имя>?startapp=ref_<код>` |
| `NEXT_PUBLIC_CHAT_ONBOARDING` | нет | `0` — вернуть старую форму вместо чата знакомства |
| `NEXT_DIST_DIR` | нет | отдельный каталог сборки |
| `TELEGRAM_BOT_ID`, `TELEGRAM_BOT_KEY`, `TELEGRAM_BOT_KEY2`, `TELEGRAM_BOT_TOKEN_B64` | нет | временный старый формат токена, читается только без `TELEGRAM_BOT_TOKEN`; удалить |

## Реферальная программа

Сейчас только атрибуция и «поделиться»; награды собраны, но выключены флагом `REFERRAL_REWARDS_ENABLED` (Монетизация.md §3).

- Ссылки: бот `https://t.me/sber_fin_app_bot?start=ref_<код>`, Mini App `https://t.me/sber_fin_app_bot/<app>?startapp=ref_<код>` (при `TELEGRAM_MINIAPP_SHORT_NAME`), веб `https://mozhno-mvp.vercel.app/?ref=<код>`. Код — 8 случайных символов `[2-9a-z]` без `i l o`, не раскрывает id. К payload можно добавить `__<кампания>` (всё ≤ 64 символов, алфавит Telegram). Формат `src_…` продолжает работать; ref-ссылка ставит первым касанием `source=referral, medium=invite`.
- Атрибуция: один раз и только новому аккаунту (first touch). Самоприглашение, команда/тесты (`users.is_internal`), уже существующие аккаунты не засчитываются; больше `REFERRAL_DAILY_LIMIT` за сутки по коду — `held`. При `/link` два аккаунта одного человека сливаются, приглашение между ними снимается.
- Активация: друг завершил знакомство (первый прогноз) или получил первый ответ «Можно?».
- Интерфейс: «Пригласить друга» в шапке и в «Плане» (ссылка, «Отправить» через `navigator.share` или `t.me/share/url`, «Скопировать», счётчики «пришли по ссылке / начали пользоваться»); под ответом «Можно?» — «Поделиться результатом» (карточка «Мне бот сказал: можно ✅» без сумм, картинка PNG собирается в браузере). В боте `/invite` и кнопка «Поделиться ответом» под ответом.
- API: `GET /api/v1/referrals/me`, `POST /api/v1/referrals/share`. Метрики: карточка «Приглашения друзей» на `/internal/analytics`, `referrals.csv` в выгрузке. Подробнее: [docs/METRICS-AND-LOGS.md](docs/METRICS-AND-LOGS.md#рефералы-миграция-008).

## Тарифы, AI-ответы и «Плюс» (этап 1, без оплаты)

- Сейчас у всех **Бета-Плюс** (`PLANS_MODE=beta`). Цены видны заранее: Бесплатно 0 ₽, Плюс 399 ₽ за 30 дней без автопродления «после беты». «Хочу Плюс» — только заявка (`plus_interest`, можно выбрать честную цену 299/399/499 или «не знаю»): ничего не списывается, карта не нужна. Кода оплаты нет; `ever_paid` в виде `user_plan_flags` всегда `false`, `entitlement_source` — для конкурсного отчёта.
- **Всегда бесплатно и не блокируется:** «Можно?», «сколько можно сегодня», кассовый разрыв, запись трат, напоминания, шаблонные ответы.
- **AI-ответы** (1 = одно объяснение «почему», сравнение, разговор о цели, разбор недели/месяца): бета 15 в день; после беты Free 60 за 30 дней (до 10 в день), Плюс 300 (до 30 в день). Голос: Free 2 мин, Плюс и бета 30 мин за 30 дней. Разбор фразы, распознавание голоса и неудачные вызовы не списываются. Списание атомарное (резерв до вызова модели → списание после ответа или возврат), дни и окна — по Москве.
- **Когда ответы закончились** — тот же ответ шаблоном с числами движка, мягкая строка «AI-ответы на сегодня закончились — новые завтра в 00:00 по Москве».
- Первый потребитель — «Почему так? ✦» под ответом «Можно?» (веб, Mini App, бот, текст «почему?»): модель получает только Evidence движка, каждое число ответа сверяется, иначе шаблон (`lib/explain.ts`).
- Интерфейс: счётчик «✦ Осталось 12 AI-ответов» у чата («AI-ответы закончились · снова …», когда лимит исчерпан), лист «Плюс» (счётчик, профиль, «закончились»), карточка в «Плане»; в боте `/plus`, кнопки «Хочу Плюс» → цена → «Спасибо, записали». Mini App использует веб-интерфейс.
- Награды за друзей (`REFERRAL_REWARDS_ENABLED=1`): созревшая награда → +7 дней Плюса, идемпотентно, в бете — после `BETA_ENDS_AT`.
- API: `GET /api/v1/plan`, `POST /api/v1/plan/interest` (`{ price, channel }` → `charged:false`), `POST /api/v1/explain` (`{ decisionId }`). Код: `lib/plans/*`, миграция `010_plans.sql`. Метрики: раздел 9 «Плюс и токены» дашборда, `plus_interest.csv`, `tokens_daily.csv`.

## Тесты и проверки

```bash
npm run typecheck
npm run lint
npm test                 # 21 файл vitest (302 теста, 1 пропущен): движок, парсер, онбординг, предложения, auth и привязка, бот, напоминания, аналитика, журналы обращений и ошибок, рефералы, LLM, тарифы и AI-ответы, HTTP-маршруты
```

Каждый тестовый файл получает свою PGlite в памяти; сеть и ключи не нужны. CI (`.github/workflows`) запускает `npm ci`, typecheck, lint, тесты, `npm audit --audit-level=high` и сборку на каждый push.

## Деплой

Production развёрнут на Vercel (проект `mozhno-mvp`) с Postgres в Neon.

Статус на 17.10.2026: онбординг-чат, напоминания, аналитика и дашборд (миграции 004-006) пока есть только в рабочей копии и в проде не выложены: `/api/v1/onboarding`, `/api/v1/reminders`, `/api/v1/analytics`, `/internal/analytics` отвечают 404. Подробнее: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#1-контекст).

1. Переменные окружения в Vercel: как минимум `DATABASE_URL`, `APP_ORIGIN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`, `ANALYTICS_SECRET`, `ANALYTICS_ADMIN_SECRET`.
2. Миграции: `MOZHNO_AUTO_MIGRATE=1` или `npm run db:migrate` с `DATABASE_URL`. Известная проблема: `npm run db:migrate` через `tsx` падает с ошибкой top-level await в CJS (проверено на Node 20.19 17.10.2026). Пока надёжнее `MOZHNO_AUTO_MIGRATE=1`.
   Миграция 007 (журналы обращений и ошибок, источники, флаг команды) нужна ДО выкладки кода: без неё `track()` не сможет писать события (колонка `analytics_events.internal`), а дашборд — читать вид `analytics_events_real`. С `MOZHNO_AUTO_MIGRATE=1` она применится при первом подключении.
   Миграция 010 (тарифы: `entitlements`, `ai_token_buckets`, `ai_token_ledger`, `plus_interest`, вид `user_plan_flags`) — до выкладки кода: на неё опираются хук квот LLM, `/api/v1/plan`, `/plus` в боте и cron очистки. Без неё резерв AI-ответа падает «закрыто» и ответы уходят шаблоном, а «Можно?» работает как раньше.
   Миграция 008 (рефералы: `users.ref_code`, `referrals`, `referral_rewards`, вид `user_referral_flags`) — тоже до выкладки кода: на неё опираются `/start ref_…`, вход Mini App, `POST /api/v1/session` с `ref` и ответ «Можно?» (активация). Награды остаются выключенными, пока не задан `REFERRAL_REWARDS_ENABLED=1`.
3. Cron (`vercel.json`): `/api/cron/cleanup` в 03:00 UTC, `/api/cron/reminders` в 07:00 UTC; Vercel передаёт `Authorization: Bearer $CRON_SECRET`.
4. Вебхук бота: `setWebhook` на `https://<домен>/api/telegram` с `secret_token=$TELEGRAM_WEBHOOK_SECRET`.
5. Проверка: `GET /api/health` → `{"ok":true}`.

## Документация

| Документ | О чём |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | архитектура, диаграммы (контекст, компоненты, «Можно?», онбординг, cron, аналитика, LLM-слой); PNG в [docs/img](docs/img) |
| [docs/LOAD-TEST.md](docs/LOAD-TEST.md) | нагрузочный тест: 10 RPS на сервис, стресс до 150 RPS, RPS/TPM, p50/p95/p99, узкие места |
| [docs/METRICS-AND-LOGS.md](docs/METRICS-AND-LOGS.md) | где хранятся DAU, обращения и ошибки, SQL, выгрузка `scripts/export-metrics.ts`, пробелы |
| [docs/LLM-COST.md](docs/LLM-COST.md) | стоимость LLM на DAU по тарифам Cloud.ru, 3 сценария, 1000 DAU, сравнение с бюджетом |
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | события, приватность, дашборд |
| [docs/BACKEND.md](docs/BACKEND.md) | устройство backend, API, решения и хвосты |
| [docs/MVP-OUTCOME.md](docs/MVP-OUTCOME.md) | образ результата MVP |
| [docs/APPLICATION.md](docs/APPLICATION.md) | контекст заявки Sber500xDisrupt |
| [docs/REVIEW-GPT.md](docs/REVIEW-GPT.md) | внешнее код-ревью |
| [README_MVP.md](README_MVP.md) | исторический README версии 0.1 |

## Соответствие критериям технической приёмки

| Критерий | Где |
|---|---|
| 1. Нагрузочный тест до 10 RPS на сервис, TPM, TPS, стресс | [docs/LOAD-TEST.md](docs/LOAD-TEST.md), `scripts/load/` |
| 2. Детальная визуализированная архитектура | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/img](docs/img) |
| 3. README | этот файл |
| 4. Хранилище метрик и логов с подключением и выгрузкой | [docs/METRICS-AND-LOGS.md](docs/METRICS-AND-LOGS.md), `scripts/export-metrics.ts` |
| 5. Стоимость LLM на DAU | [docs/LLM-COST.md](docs/LLM-COST.md) |
| 6. Сервис не на localhost | https://mozhno-mvp.vercel.app (`/api/health` → 200), @sber_fin_app_bot; новые функции ещё нужно выкатить (см. «Деплой») |
