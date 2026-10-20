// Фейковый OpenAI-совместимый сервер для тестов LLM-слоя (настоящий прокси акселератора не вызывается).
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply { status?: number; delayMs?: number; content?: string; usage?: { prompt_tokens: number; completion_tokens: number } | null; json?: unknown }
export type FakeHandler = (req: { path: string; model: string; body: Record<string, unknown> }) => FakeReply;

export interface FakeLlm { url: string; calls: { path: string; model: string; body: Record<string, unknown> }[]; handler: FakeHandler; close(): Promise<void> }

const read = (req: IncomingMessage) => new Promise<string>((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });

export async function startFakeLlm(handler: FakeHandler = () => ({})): Promise<FakeLlm> {
  const fake = { calls: [] as FakeLlm["calls"], handler } as FakeLlm;
  const server: Server = createServer(async (req, res) => {
    const raw = await read(req);
    const path = (req.url ?? "").replace(/^\/v1/, "");
    let body: Record<string, unknown> = {};
    if ((req.headers["content-type"] ?? "").includes("json")) { try { body = JSON.parse(raw); } catch { /* пусто */ } }
    const model = typeof body.model === "string" ? body.model : (/name="model"\r\n\r\n([^\r\n]+)/.exec(raw)?.[1] ?? "");
    fake.calls.push({ path, model, body });
    const r = fake.handler({ path, model, body });
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    if (res.destroyed) return;
    const status = r.status ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    if (status !== 200) { res.end(JSON.stringify({ error: { message: "fake error" } })); return; }
    const payload = r.json ?? {
      id: "cmpl-fake", object: "chat.completion", model,
      choices: [{ index: 0, message: { role: "assistant", content: r.content ?? "{\"intent\":\"other\"}" }, finish_reason: "stop" }],
      ...(r.usage === null ? {} : { usage: r.usage ?? { prompt_tokens: 700, completion_tokens: 60, total_tokens: 760 } }),
    };
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  fake.close = () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); });
  return fake;
}
