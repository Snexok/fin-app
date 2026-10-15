import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // Каждый файл тестов — свой процесс и своя БД PGlite в памяти. Без сети и ключей.
    env: { MOZHNO_DB: "pglite", PGLITE_DIR: "memory://", OPENAI_API_KEY: "", LLM_API_KEY: "", DATABASE_URL: "", POSTGRES_URL: "", TELEGRAM_BOT_USERNAME: "mozhno_test_bot" },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
