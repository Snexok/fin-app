# Можно? — MVP (v0.1)

Личный финансовый коуч: отвечает на вопрос "можно ли позволить эту покупку сейчас?".
Финансовые расчёты делает только детерминированный модуль `lib/engine`. LLM разбирает намерение
(структурированный вывод через Vercel AI SDK `generateObject`) и объясняет уже посчитанные числа.
Без ключа работает fallback: regex-парсер + шаблонное объяснение.

## Структура
- `lib/engine/index.ts` — чистые функции: `snapshot()` (свободные деньги до дохода, безопасно в день), `purchaseImpact()` (остаток, новая сумма в день, риск кассового разрыва, сдвиг цели, сценарии "сейчас" / "после дохода", вердикт yes/careful/wait/no).
- `lib/parse.ts` — разбор сумм ("15к", "50 000", "1,5 млн"), дат ("25.10", "5 ноября", "через 10 дней") и намерения.
- `lib/ai/llm.ts` — LLM (OpenAI по умолчанию, `LLM_BASE_URL` для совместимых провайдеров) и STT.
- `lib/coach.ts` — общий сценарий ответа и пошаговый онбординг (веб + Telegram).
- `lib/db.ts` — Postgres при `DATABASE_URL`/`POSTGRES_URL`, локально PGlite. Привязка Telegram: одноразовый код из веба + подтверждение кнопкой «Разрешить» в боте (см. docs/BACKEND.md).
- `lib/bot.ts` — grammY-бот: `/start` (онбординг), `/status`, `/link`, текст, голосовые (STT при ключе).
- `app/` — Next.js: `/` (онбординг, дашборд, чат с голосом через Web Speech API или запись + `/api/stt`), API `/api/profile`, `/api/chat`, `/api/stt`, `/api/telegram` (webhook).
- `scripts/bot-polling.ts` — локальный бот в режиме polling.
- `tests/` — vitest (движок, парсер, онбординг + чат без ключа).

## Запуск
```bash
npm install
npm test
npm run dev          # http://localhost:3000
npm run build && npm start
TELEGRAM_BOT_TOKEN=... npm run bot:poll   # бот локально
```
Проверка API без ключа:
```bash
curl -c j -b j -X POST localhost:3000/api/profile -H 'content-type: application/json' \
  -d '{"balance":60000,"reserve":10000,"nextIncome":{"date":"2026-10-25","amount":80000},"payments":[{"name":"Аренда","amount":30000,"date":"2026-10-20"}]}'
curl -c j -b j -X POST localhost:3000/api/chat -H 'content-type: application/json' -d '{"message":"Можно купить наушники за 15 000?"}'
```

## Деплой на Vercel
1. Импортировать репозиторий, фреймворк Next.js, без доп. настроек.
2. Добавить Postgres (Vercel Postgres/Neon) — `POSTGRES_URL` подхватится; таблица `mozhno_users` создаётся автоматически. Без БД данные живут в `/tmp` и теряются между инстансами (только демо).
3. Env: `OPENAI_API_KEY` (опц.), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`.
4. Вебхук: `curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://<домен>/api/telegram&secret_token=$TELEGRAM_WEBHOOK_SECRET"`

## Переменные окружения
См. `.env.example`. Все необязательны для демо.

## Ограничения v0.1
Нет авторизации (аккаунт = cookie), нет учёта операций, напоминаний, импорта документов, озвучки ответов и регулярных платежей (платёж задаётся датой). Сценарий "после дохода" считает период 30 дней и тратит до дохода безопасную сумму в день.
