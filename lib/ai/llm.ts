// Совместимость: прежний модуль LLM. Вся логика теперь в lib/llm (единый клиент с бюджетами и журналом ai_usage).
// Расчёты по-прежнему делает только lib/engine.
export { llmEnabled, parseIntentLLM, type LlmIntent } from "../llm";
export { transcribeAudio, sttEnabled } from "../llm";
