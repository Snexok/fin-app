// Распознавание речи через тот же учёт: бюджет (резерв по максимальной длительности), ai_usage (purpose=voice_transcribe,
// audio_ms, стоимость посекундно), service_calls (llm.stt). Возвращает типизированный результат; при отказе — «напишите текстом».
import { randomUUID } from "node:crypto";
import { budgetDay, llmConfig, sttConfig } from "./config";
import { reserveBudget, settleBudget } from "./budget";
import { sttCostMicro } from "./prices";
import { callWho, recordOperation, writeUsage, type LlmFail, type LlmFailure } from "./client";
import type { LogChannel } from "../service-log";

export interface SttOk { ok: true; text: string; seconds: number; costMicro: number; model: string; requestId: string }
export type SttResult = SttOk | LlmFail;

/** Верхняя оценка длительности по размеру файла: голос в opus/webm — от ~2 КБ/с, поэтому байты / 2000 не занижают. */
export const maxSecondsByBytes = (bytes: number) => Math.max(1, Math.ceil(bytes / 2000));

export function sttEnabled(): boolean { try { return sttConfig().enabled; } catch { return false; } }

export async function transcribeAudio(audio: Blob, o: { filename?: string; durationSec?: number | null; userId?: string | null; channel?: LogChannel; now?: Date } = {}): Promise<SttResult> {
  const t0 = Date.now();
  const fail = (reason: LlmFailure, code: string, extra: Partial<LlmFail> = {}): LlmFail => ({ ok: false, reason, code, requestId: null, attempts: 0, latencyMs: Date.now() - t0, ...extra });
  const cfg = sttConfig();
  const budget = llmConfig();
  if (!cfg.apiKey) return fail("not_configured", "STT_NOT_CONFIGURED");
  if (!cfg.enabled) return fail("disabled", "LLM_DISABLED");
  const who = callWho(o);
  const known = o.durationSec != null && o.durationSec > 0 ? o.durationSec : null;
  const maxSec = known ?? maxSecondsByBytes(audio.size);
  const reserveMicro = sttCostMicro(maxSec);
  const now = o.now ?? new Date();
  const requestId = randomUUID();
  const row = { requestId, attempt: 1, purpose: "voice_transcribe" as const, provider: cfg.provider, model: cfg.model, promptTokens: 0, completionTokens: 0, priceVersion: "stt-0.61kop-s", budgetDay: budgetDay(now), fallbackFrom: null, aiAnswer: false };
  const res = await reserveBudget({ userId: who.userId, micro: reserveMicro, cfg: budget, now });
  if (!res.ok) {
    const code = `LLM_BUDGET_${res.scope.toUpperCase()}`;
    await writeUsage([{ ...row, audioMs: null, usageEstimated: false, reservedMicro: 0, costMicro: 0, latencyMs: 0, status: "budget_denied", errorCode: code }], who);
    await recordOperation({ purpose: "voice_transcribe", userId: who.userId, channel: who.channel, ok: false, code, failed: false, latencyMs: Date.now() - t0 });
    return fail("budget", code, { budgetScope: res.scope, requestId, attempts: 1 });
  }
  let out: SttResult | null = null;
  let costMicro = 0, seconds = maxSec, estimated = known == null, status: "ok" | "error" | "timeout" = "ok", code: string | null = null;
  try {
    const fd = new FormData();
    fd.append("file", audio, o.filename ?? "voice.ogg");
    fd.append("model", cfg.model);
    fd.append("language", "ru");
    const r = await fetch(`${cfg.baseUrl}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: fd, signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); status = "error"; code = `STT_HTTP_${r.status}`; }
    else {
      const j = await r.json() as { text?: unknown; duration?: unknown };
      const d = Number(j?.duration);
      if (Number.isFinite(d) && d > 0) { seconds = d; estimated = false; }
      costMicro = sttCostMicro(seconds);
      if (typeof j?.text !== "string") { status = "error"; code = "STT_BAD_OUTPUT"; }
      else out = { ok: true, text: j.text, seconds, costMicro, model: cfg.model, requestId };
    }
  } catch (e) {
    const name = (e as { name?: string })?.name;
    status = name === "TimeoutError" || name === "AbortError" ? "timeout" : "error";
    code = status === "timeout" ? "STT_TIMEOUT" : "STT_NETWORK";
  }
  await settleBudget(res.reservation, costMicro);
  const latencyMs = Date.now() - t0;
  await writeUsage([{ ...row, audioMs: status === "ok" || costMicro > 0 ? Math.round(seconds * 1000) : null, usageEstimated: estimated, reservedMicro: reserveMicro, costMicro, latencyMs, status, errorCode: code }], who);
  out ??= fail(status === "timeout" ? "timeout" : "error", code ?? "STT_FAILED", { requestId, attempts: 1 });
  await recordOperation({ purpose: "voice_transcribe", userId: who.userId, channel: who.channel, ok: out.ok, code: out.ok ? null : out.code, failed: !out.ok, latencyMs });
  return out;
}
