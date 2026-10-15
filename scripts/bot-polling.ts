// Локальный запуск бота без вебхука: TELEGRAM_BOT_TOKEN=... npm run bot:poll
import { createBot } from "../lib/bot";
import { telegramBotToken } from "../lib/telegram-token";
const token = telegramBotToken();
if (!token) { console.error("Задайте TELEGRAM_BOT_TOKEN в формате <id>:<secret>"); process.exit(1); }
const bot = createBot(token);
await bot.api.deleteWebhook();
console.log("Можно? bot polling...");
bot.start();
