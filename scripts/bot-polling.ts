// Локальный запуск бота без вебхука: TELEGRAM_BOT_TOKEN=... npm run bot:poll
import { createBot } from "../lib/bot";
if (!process.env.TELEGRAM_BOT_TOKEN) { console.error("Set TELEGRAM_BOT_TOKEN"); process.exit(1); }
const bot = createBot();
await bot.api.deleteWebhook();
console.log("Можно? bot polling...");
bot.start();
