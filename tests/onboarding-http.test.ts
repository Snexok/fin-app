// HTTP-слой онбординг-чата: открытие, ход текстом и выбором, Origin, пропуск при наличии бюджета, слияние при привязке.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { call, jar, newSession, nextHeadersMock, req } from "./http-helpers";
vi.mock("next/headers", () => nextHeadersMock);

import { GET as obGET, POST as obPOST } from "../app/api/v1/onboarding/route";
import { POST as turnPOST } from "../app/api/v1/onboarding/turn/route";
import { POST as profilePOST } from "../app/api/profile/route";
import { runRetention } from "../lib/retention";

beforeEach(() => { jar.clear(); });
const turn = (body: unknown) => call(turnPOST, req("/api/v1/onboarding/turn", { method: "POST", body }));

describe("onboarding HTTP", () => {
  it("open → choice → multi-fact text → preview; reload shows history + resume prompt", async () => {
    await newSession();
    const o = await call(obPOST, req("/api/v1/onboarding", { method: "POST", body: {} }));
    expect(o.status).toBe(200);
    expect(o.body.skip).toBe(false);
    const intro = o.body.messages[0];
    let r = await turn({ clientMessageId: "a1", text: "Начнём", selection: { assistantMessageId: intro.id, choiceId: intro.choices[0].id, revision: intro.revision } });
    expect(r.status).toBe(200);
    r = await turn({ clientMessageId: "a2", text: "45 000, зарплата 80 000 25.11" });
    const a = r.body.messages[1];
    expect(a.cards[0].type).toBe("preview");
    expect(r.body.progress).toBeGreaterThan(0);
    expect(r.body.facts.map((f: { slot: string }) => f.slot)).toEqual(["balance", "income"]);
    const g = await call(obGET, req("/api/v1/onboarding"));
    expect(g.body.state.planSaved).toBe(true);
    expect(g.body.messages.length).toBe(5);
    const again = await call(obPOST, req("/api/v1/onboarding", { method: "POST", body: {} }));
    expect(again.body.messages.at(-1).text).toContain("Продолжим");
  });

  it("rejects cross-origin turns and bad input", async () => {
    await newSession();
    expect((await call(turnPOST, req("/api/v1/onboarding/turn", { method: "POST", body: { clientMessageId: "x", text: "1" }, origin: "https://evil.example" }))).status).toBe(403);
    expect((await turn({ text: "1" })).status).toBe(400);
    expect((await turn({ clientMessageId: "x" })).status).toBe(400);
  });

  it("existing budget: open returns skip; edit requires slot", async () => {
    await newSession();
    await call(profilePOST, req("/api/profile", { method: "POST", body: { balance: 60000, reserve: 0, nextIncome: { amount: 80000, date: "2026-11-25" }, payments: [], goal: null } }));
    expect((await call(obPOST, req("/api/v1/onboarding", { method: "POST", body: {} }))).body.skip).toBe(true);
    expect((await call(obPOST, req("/api/v1/onboarding", { method: "POST", body: { mode: "edit" } }))).status).toBe(400);
    const e = await call(obPOST, req("/api/v1/onboarding", { method: "POST", body: { mode: "edit", slot: "balance" } }));
    expect(e.body.messages[0].text).toContain("Текущее значение: 60\u00a0000\u00a0₽");
  });

  it("retention keeps active sessions", async () => {
    await newSession();
    await call(obPOST, req("/api/v1/onboarding", { method: "POST", body: {} }));
    const r = await runRetention(new Date());
    expect(r.onboardingSessions).toBe(0);
  });
});
