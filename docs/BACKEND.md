# Backend «Можно?»: путь «Сегодня» (шаги 1–6 из ARCHITECTURE.md)

Статус: реализовано и проверено локально (`npm test`: 96 тестов после исправлений по ревью, см. docs/REVIEW-GPT.md; `npm run build`, smoke-тест dev-сервера). Ничего не деплоилось и не пушилось.

## Что сделано

### 1. Типы, деньги, даты (`lib/engine/money.ts`, `dates.ts`, `types.ts`)
- Деньги в копейках (`bigint`), в Postgres `bigint`, в API десятичные строки копеек (`*Minor`). Округление только при показе (`formatRub`, рубли вниз).
- Строгие календарные даты (`isValidDate`: 31.02, 29.02 невисокосного года и 13-й месяц отклоняются).
- «Сегодня» вычисляется сервером в зоне пользователя (`users.timezone`, по умолчанию Europe/Moscow), а не в UTC. Дату `today` от клиента `/api/chat` игнорирует.
- `monthlyDates`: платёж 31-го переносится на последний день короткого месяца, следующий месяц снова считается от якоря; високосный февраль учтён.

### 2. Движок по контрольным точкам (`lib/engine/forecast.ts`, `purchase.ts`, `legacy.ts`)
Формулы из §4.3–4.9: C(k), slack(k), safeDaily = min floor(dailySlack/n), три отдельных сигнала (кассовый разрыв на обязательства, разрыв с учётом повседневных трат, затрагивание резерва или цели). Исправлены все пункты §5:

| Проблема §5 | Как теперь |
|---|---|
| `number` / `Math.round` | `bigint` копейки, `floorDiv` |
| `toDate` / `validateProfile` без проверки дат | `assertDate`, строгая `validateProfile` |
| `todayISO()` в UTC | `localDate(now, tz)` |
| `Math.max(1, daysToIncome)` | Прошедший неподтверждённый доход исключается (`INCOME_OVERDUE`), горизонт — явный период планирования |
| Просроченные неоплаченные платежи игнорировались | Ложатся на сегодня, флаг `overdue` |
| Платёж в день дохода выпадал | Внутридневной порядок: платежи, покупка, дневные траты, затем доход |
| `snapshot()` проверял одну точку | Минимум по всем контрольным точкам горизонта |
| `goalSetAside` мог превысить остаток цели | Q(k) = floor(L·min(e,N)/N) ≤ L |
| `goalDelay()` выдумывал срок | `goalImpact.delayDays = null`, причина `FUTURE_SAVING_CAPACITY_UNKNOWN` / `HORIZON_EXCEEDED`; в старом поле `goalDelayDays` всегда 0 |
| `period = 30` после дохода | Сценарий «после дохода» идёт до следующего известного дохода или явного периода с пометкой `HORIZON_ASSUMED` |
| `balAtIncome` по максимальному safeDaily | Тот же согласованный сценарий трат во всех вариантах |
| `safeDaily * days` | Считаем по точным суммам |
| `Infinity` проходил `price > 0` | `assertPositiveAmount` + верхняя граница 10 млрд ₽ |
| `risk` / `verdict` смешивали причины | `Assessment`: `fits_plan`, `reduces_daily_margin`, `touches_protected_money`, `cash_gap`; «подождать» только если сценарий после дохода реально лучше (`waitIsBetter`) |

Парсер (`lib/parse.ts`): «iPhone 15 за 80 000» → 80 000 (кандидаты сумм, приоритет после «за/по/стоит», затем с единицей), отрицательные суммы не становятся положительными, невозможные даты → `null`, «10-го» после 10-го числа даёт следующий месяц, даты вырезаются одинаково везде (`stripDates`), `parsePaymentLines` возвращает ошибки по строкам вместо молчаливого отбрасывания. Новые намерения: `expense` («потратил 500 на кофе»), `income` («зарплата пришла»), `amount_only` («15 тысяч» после вопроса о цене; черновик предмета хранится в `conversation_state`).

### 3. Postgres (`db/migrations/001_core.sql`, `lib/db.ts`, `scripts/migrate.ts`)
- Драйвер `pg` при `DATABASE_URL`/`POSTGRES_URL`, TLS с проверкой сертификата (`rejectUnauthorized: false` убран), пул `DATABASE_POOL_MAX` (5).
- Локально и в тестах — **PGlite** (настоящий Postgres в WASM): `.data/pglite` или `memory://`. В production без БД сервер **не** откатывается на файл: `DbUnavailableError` → 503, `/api/health` → 503.
- Миграции: `npm run db:migrate` (таблица `schema_migrations`). PGlite мигрирует сам; для Postgres авто-миграция только при `MOZHNO_AUTO_MIGRATE=1`.
- JSON-хранилище удалено (fallback не понадобился). Тест проверяет, что данные переживают перезапуск.

### 4. Сессии и `/link` (`lib/auth.ts`, `lib/session.ts`)
- Веб: случайный 256-битный токен в cookie `mozhno_sid` (HttpOnly, SameSite=Lax, Secure в production), в БД только sha256. Анонимный аккаунт создаётся при первом запросе (как раньше).
- Изменяющие запросы проверяют `Origin` / `Sec-Fetch-Site` (CSRF).
- Привязка Telegram: `POST /api/v1/account-links` → одноразовый код (10 минут, хранится хешем) + секрет браузера в HttpOnly-cookie `mozhno_link` → пользователь отправляет боту `/start link_<код>` (deep link) или `/link <код>` → бот отмечает подтверждение от `ctx.from.id` → тот же браузер вызывает `POST /api/v1/account-links/:id/confirm`. Знание чужого ID ничего не даёт; использованный или просроченный код отклоняется.
- Если бюджеты есть у обоих аккаунтов → 409 `LINK_CONFLICT`, без автоматического объединения. Если данные только в Telegram, веб-сессия переходит в Telegram-аккаунт; если только в вебе, Telegram-identity переносится в веб.

### 5. Предложения и подтверждение (`lib/proposals.ts`, `app/api/v1/proposals/...`)
- Чат и бот создают `create_entry` (расход/доход), запись появляется только после подтверждения. Свободное «да» ничего не применяет.
- Подтверждение по §9.1: ключ `Idempotency-Key` (PRIMARY KEY, без SELECT→INSERT) → `SELECT … FOR UPDATE` строки `books` → блокировка proposal → проверки (владелец, TTL 12 ч, ревизия, версия) → одна запись в `ledger_entries` → `finance_version + 1` → `finance_events` → сохранённый ответ. Повтор (тот же ключ, другой ключ, параллельно, двойное нажатие кнопки в боте) возвращает первый результат и не создаёт второй операции. Защита дублируется уникальным индексом `ledger_one_per_proposal`.
- Изменилась версия бюджета → 409 `STALE_PROPOSAL`, предложение получает новую ревизию; старая кнопка → 409 `PROPOSAL_REVISION_MISMATCH`.
- Оплата планового платежа («оплатил аренду 10000») подхватывает обязательство по названию; частичная оплата уменьшает остаток обязательства без двойного счёта. «Зарплата пришла» без суммы предлагает ожидаемый доход и закрывает его.
- Проверка покупки пишет `decisions` и **не** меняет `finance_version`.

### 6. Веб и бот через один сервисный слой (`lib/finance-service.ts`, `lib/coach.ts`, `lib/bot.ts`)
- `answer()` общий для `/api/chat` и бота; ответы с числами формируются шаблонами из результата движка. LLM (если есть ключ) только классифицирует намерение и может добавить короткое вступление без цифр. Сумма от LLM принимается, только если её текст есть в сообщении. Тайм-аут 8 с, при ошибке — regex и шаблоны.
- Бот: финансы только в личном чате; `/start` у существующего пользователя не сбрасывает план (`/setup` — заново, `/cancel` — остановить); онбординг получил шестой необязательный вопрос про необходимые траты в день («не знаю» допустимо); кнопки «Записать» / «Не нужно» у предложений; чужая кнопка не работает.
- Webhook: секрет обязателен в production; повторный `update_id` отбрасывается (`inbox`); при ошибке обработки отметка снимается, чтобы повтор Telegram обработался.
- `/api/health` больше не вызывает `getMe` и не раскрывает настройки; `/api/stt` требует сессию, ограничивает размер (10 МБ) и MIME и не возвращает текст ошибки провайдера.

## API: совместимость и новые поля для UI

Старые маршруты работают с прежней формой ответа; новые поля только добавлены.

- `GET /api/profile`: прежние `id, profile (рубли), history, snapshot, llm, storage` + **новые** `forecast` (копейки строками, полный прогноз), `meta` (CalculationMeta: `financeVersion`, `horizonEnd`, `completeness`, `limitations`…), `entries` (последние операции), `account.telegramLinked`. `profile` получил `essentialDaily`, `goal.savedInBalance`; `payments[]` теперь показывает непогашенный остаток, а не исходную сумму.
- `snapshot` (и `impact.snapshot`) получил `horizonEnd`, `horizonKind`, `freeMoneyKnown`, `discretionaryDaily`, `cashGap {date, amount}`, `protectedShortfall`, `overdueIncome`, `limitations`; в `upcomingPayments[]` может быть `overdue: true`. Значения могут содержать копейки (`1818.18`).
- **Изменения смысла**: `daysToIncome` теперь включает день дохода (15→25 октября = 11 дней, было 10). При неизвестном или прошедшем доходе это явный период (30 дней). Если повседневный минимум не задан, `freeMoney` — это сумма до учёта повседневных трат (`freeMoneyKnown: false`).
- `POST /api/profile`: принимает прежнее тело + необязательные `essentialDaily`, `goal.saved`, `goal.savedInBalance` или строки `*Minor`. Ошибки по-прежнему `{ errors: [...] }` со статусом 400.
- `POST /api/chat`: прежние `reply, mode, impact, snapshot, needsOnboarding` + **новые** `proposal`, `simulation`, `forecast`, `meta`, `decisionId`. В `impact` добавлены `assessment`, `waitIsBetter`; `scenarios.afterIncome` может быть `null`.
- **Нужно в UI (делает UI-воркер):**
  1. Если в ответе чата есть `proposal`, показать кнопки «Записать» → `POST /api/v1/proposals/{id}/confirm` с телом `{ "revision": proposal.revision }` и заголовком `Idempotency-Key` (один UUID на нажатие, повторять при retry); «Не нужно» → `POST /api/v1/proposals/{id}/reject`. Ответ confirm содержит свежие `snapshot`/`forecast`/`meta`. При 409 `STALE_PROPOSAL` показать `proposal` из ответа с новой ревизией.
  2. Вместо «Код для Telegram: `/link {st.id}`» (небезопасная схема больше не работает) — кнопка «Связать с Telegram»: `POST /api/v1/account-links` → показать `deepLink` (или `command`), опрашивать `GET /api/v1/account-links/{id}` до `status: "approved"`, затем кнопка «Подтвердить» → `POST /api/v1/account-links/{id}/confirm`.
  3. Желательно: вопрос «Сколько нужно в день на еду и транспорт?» → поле `essentialDaily` в `POST /api/profile`.

Новые маршруты: `GET /api/v1/me`, `GET /api/v1/finance/snapshot`, `POST /api/v1/finance/simulations` (цена/даты/альтернативы/подписка), `GET /api/v1/entries`, `POST /api/v1/proposals`, `GET /api/v1/proposals/:id`, `POST /api/v1/proposals/:id/confirm|reject`, `POST /api/v1/account-links`, `GET /api/v1/account-links/:id`, `POST /api/v1/account-links/:id/confirm`, `POST /api/v1/chat/messages` (= `/api/chat`). Ошибки: `{ error: { code, message, requestId } }`, `Cache-Control: no-store`.

## Отклонения от плана

- **Доход из онбординга сохраняется как `committed`** (пользователь сам назвал дату и сумму), иначе основной прогноз всегда шёл бы без дохода. Сценарий `expected` в движке есть, в UI не выведен.
- **Повседневный минимум неизвестен → вердикт не `insufficient_data`**: оценка считается по сумме до повседневных трат с ограничением `ESSENTIAL_SPENDING_UNKNOWN` и пометкой в тексте. Иначе почти каждый вопрос текущих пользователей упирался бы в «не хватает данных».
- В `identities.provider` добавлен `anonymous` (веб-сессия до привязки). Добавлены `goals.saved_outside_minor` (накопления вне остатка, по умолчанию цель из старой формы считается накопленной вне остатка), `ledger_entries.proposal_id` + уникальный индекс, таблица `conversation_state`. В `occurrences` пока нет FK на `recurrence_rules` (таблица — шаг 7).
- Повторное сохранение плана через форму — это сброс точки отсчёта: новый начальный остаток, старые плановые события отменяются, операции остаются в истории и в баланс не входят (`created_at > opening_as_of`). Отдельной сверки остатка (`reconcile_balance`) пока нет.
- Вход из браузера через Telegram (`login`-challenge) и Mini App не делались: веб остаётся анонимной сессией плюс привязка.
- Telegram webhook пока обрабатывается синхронно с дедупликацией по `inbox`, без очереди `jobs` (шаг 9).
- `POST /api/v1/proposals` пока принимает только `create_entry`.
- Конкурентные тесты идут на PGlite (одно соединение, транзакции сериализуются). Логика под настоящий Postgres та же (PK идемпотентности + `FOR UPDATE`), но параллельный прогон на реальном Postgres не выполнялся.

## Что осталось (шаги 7+ и хвосты)

- Шаг 7: `recurrence_rules` и генерация occurrences (утилита `monthlyDates` и подписки в симуляции уже есть).
- Шаг 8: полная Evidence-модель для LLM и `lib/ai/schemas.ts`; выдача `clarify`.
- Шаг 9: `002_jobs.sql`, outbox/worker, обработка Telegram update из job.
- Шаг 10: утренний и вечерний обзоры, `app/api/cron`, `vercel.json`, `CRON_SECRET`.
- Шаг 11: базовые лимиты уже есть (`002_rate_limits.sql`); осталось ограничение длительности аудио в вебе, потоковые лимиты тела, `lib/config.ts`.
- Открытые пункты из ревью GPT перечислены в конце docs/REVIEW-GPT.md.
- Скрипт переноса старого `.data/users.json` (dry run, отчёт, резервная копия по §12): старые JSON-профили автоматически **не** переносятся, после выкладки пользователям нужно заново пройти онбординг.
- Сторно и исправление операций (`correct_entry`), сверка остатка, отвязка канала, удаление данных.
- UI: кнопки подтверждения, новая привязка Telegram, поле `essentialDaily` (см. выше).
- Перед выкладкой: создать Postgres для проекта Vercel `mozhno-mvp`, задать переменные, выполнить `npm run db:migrate`, задать `TELEGRAM_WEBHOOK_SECRET` и заново вызвать `setWebhook` с `secret_token`.

## Переменные окружения

| Переменная | Где | Назначение |
|---|---|---|
| `DATABASE_URL` или `POSTGRES_URL` | production — обязательно | Postgres |
| `DATABASE_SSL` | опционально | `disable` / `require` |
| `DATABASE_POOL_MAX` | опционально | размер пула (5) |
| `MOZHNO_AUTO_MIGRATE` | опционально | `1` — миграции при старте |
| `MOZHNO_DB`, `PGLITE_DIR` | локально/тесты | явный PGlite, каталог или `memory://` |
| `TELEGRAM_BOT_TOKEN` | для бота | |
| `TELEGRAM_WEBHOOK_SECRET` | production — обязательно для бота | без него webhook отвечает 503 |
| `TELEGRAM_BOT_USERNAME` | рекомендуется | deep link привязки |
| `OPENAI_API_KEY` / `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `STT_*` | опционально | LLM и STT |
| `NEXT_DIST_DIR` | опционально | отдельный каталог сборки (чтобы не мешать запущенному `next dev`) |

## Проверка

```bash
npm test                      # 96 тестов: движок (§13 1–12 + инварианты), парсер, сервис, предложения, auth/link, бот
NEXT_DIST_DIR=.next-build npm run build
npm run dev                   # PGlite в .data/pglite
npm run db:migrate            # для настоящего Postgres
```
