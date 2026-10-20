"use client";
// v26: «Плюс» и AI-ответы. Этап 1 — без оплаты: всем Бета-Плюс, цена «после беты» видна заранее,
// «Хочу Плюс» — только заявка (POST /api/v1/plan/interest, ничего не списывается). Ядро «Можно?» всегда бесплатно.
import { useEffect, useState } from "react";
import { trackClient } from "./analytics-client";

export type Tokens = { plan: string; label: string; left: number | null; limit: number | null; scope: "day" | "window" | null; exhausted: boolean; low: boolean; resetAt: string; resetLabel: string };
export type PlanState = {
  mode: "beta" | "live"; plan: "beta_plus" | "free" | "plus"; label: string; endsAt: string | null; betaEndsAt: string | null; plusUntil: string | null;
  tokens: Tokens;
  prices: { free: 0; plusRub: number; periodDays: number; autoRenew: false; afterBeta: boolean; options: number[]; variant: string };
  quotas: { beta: { perDay: number }; free: { perDay: number; perWindow: number; voiceMin: number }; plus: { perDay: number; perWindow: number; voiceMin: number } };
  interest: { priceChoice: number | null } | null;
};
export type PlusSurface = "counter" | "menu" | "exhausted" | "answer";

const tg = () => (typeof window !== "undefined" ? (window as unknown as { Telegram?: { WebApp?: { initData?: string; HapticFeedback?: { impactOccurred?: (s: string) => void; notificationOccurred?: (s: string) => void } } } }).Telegram?.WebApp : undefined);
const tap = () => { try { const h = tg()?.HapticFeedback; if (h?.impactOccurred) h.impactOccurred("light"); else navigator.vibrate?.(8); } catch {} };
const rub = (n: number) => `${n.toLocaleString("ru-RU")}\u00a0₽`;
/** «1 AI-ответ», «3 AI-ответа», «12 AI-ответов». */
export function answersWord(n: number) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? "AI-ответ" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "AI-ответа" : "AI-ответов";
}

let cache: Promise<PlanState | null> | null = null;
export function loadPlan(refresh = false): Promise<PlanState | null> {
  if (!cache || refresh) cache = fetch("/api/v1/plan", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return cache;
}
/** План и счётчик; tick — перечитать (после ответа в чате). */
export function usePlan(enabled: boolean, tick = 0) {
  const [p, setP] = useState<PlanState | null>(null);
  useEffect(() => { if (enabled) loadPlan(tick > 0).then((x) => x && setP(x)); }, [enabled, tick]);
  return [p, setP] as const;
}

const Spark = () => <span className="pl-spark" aria-hidden="true">✦</span>;

/** Пилюля у чата: «✦ Осталось 12 AI-ответов» / «✦ AI-ответы закончились · снова завтра в 00:00». Нажатие — лист «Плюс» с пояснением. */
export function TokenCounter({ plan, onOpen }: { plan: PlanState | null; onOpen: () => void }) {
  if (!plan) return null;
  const t = plan.tokens;
  const text = t.left == null ? "AI-ответы без лимита" : t.exhausted ? `AI-ответы закончились · снова ${t.resetLabel}` : `Осталось ${t.left} ${answersWord(t.left)}`;
  return (
    <button type="button" className={"pl-counter" + (t.exhausted ? " is-out" : t.low ? " is-low" : "")} onClick={() => { tap(); onOpen(); }}
      aria-label={`${text}. Вопросы «Можно?» — бесплатно и без лимита. Что такое Плюс`}>
      <Spark />{text}
    </button>
  );
}

/** Карточка в профиле/плане. */
export function PlusCard({ plan, onOpen }: { plan: PlanState | null; onOpen: () => void }) {
  const beta = plan?.mode === "beta";
  return (
    <section className="tg-card glass pl-card" aria-labelledby="pl-card-title">
      <div className="tg-head"><span className="tg-glyph pl-glyph" aria-hidden="true">✦</span><div>
        <h3 id="pl-card-title">{plan ? plan.label : "Плюс"}{beta && <span className="pl-badge">бета</span>}</h3>
        <p className="muted">{beta ? "Сейчас всё бесплатно. Расскажем заранее, что будет после беты." : plan?.plan === "plus" ? "Больше AI-ответов и голоса." : "Главное всегда бесплатно."}</p></div></div>
      {plan && <p className="pl-card-line">✦ {plan.tokens.left == null ? "AI-ответы без лимита" : `Осталось ${plan.tokens.left} из ${plan.tokens.limit} ${answersWord(plan.tokens.limit ?? 0)} ${plan.tokens.scope === "window" ? "на 30 дней" : "на сегодня"}`}</p>}
      <button type="button" className="button-secondary full-width" onClick={() => { tap(); onOpen(); }}>Что даёт Плюс</button>
    </section>
  );
}

function Sheet({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet pl-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head"><h3>{title}</h3><button type="button" className="sheet-close" onClick={onClose} aria-label="Закрыть">×</button></div>
        <div className="sheet-body">{children}</div>
        {actions && <div className="sheet-actions">{actions}</div>}
      </div>
    </div>
  );
}

const FREE_FOREVER = ["Вопросы «Можно?» — без лимита", "Сколько можно тратить в день", "Предупредим, если до дохода может не хватить", "Запись трат и напоминания"];

/** Лист «Плюс»: бета, что всегда бесплатно, что в Плюсе, цена после беты, «Хочу Плюс» (без оплаты). */
export function PlusSheet({ plan, surface, onClose, onChanged }: { plan: PlanState | null; surface: PlusSurface; onClose: () => void; onChanged?: (p: PlanState) => void }) {
  const [p, setP] = useState<PlanState | null>(plan);
  const [price, setPrice] = useState<number | null>(plan?.interest?.priceChoice ?? plan?.prices.plusRub ?? null);
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(plan?.interest ? "done" : "idle");
  const [edit, setEdit] = useState(false);
  useEffect(() => { trackClient({ name: "plus_viewed", props: { surface } }); }, [surface]);
  useEffect(() => { loadPlan(true).then((x) => { if (x) { setP(x); if (!plan) setPrice(x.interest?.priceChoice ?? x.prices.plusRub); if (x.interest && !plan) setState("done"); } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return <Sheet title="Плюс" onClose={onClose}><p className="muted">Загружаем…</p></Sheet>;
  const beta = p.mode === "beta", t = p.tokens, pr = p.prices, Q = p.quotas;
  async function want() {
    tap(); setState("busy");
    const r = await fetch("/api/v1/plan/interest", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ price, channel: tg()?.initData ? "miniapp" : "web" }) }).catch(() => null);
    if (!r?.ok) { setState("error"); return; }
    try { tg()?.HapticFeedback?.notificationOccurred?.("success"); } catch {}
    setState("done"); setEdit(false);
    const x = await loadPlan(true); if (x) { setP(x); onChanged?.(x); }
  }
  const done = state === "done" && !edit;
  return (
    <Sheet title={done ? "Спасибо!" : "Плюс"} onClose={onClose} actions={done ? (
      <div className="inv-actions">
        <button type="button" className="button-primary full-width" onClick={() => { tap(); onClose(); }}>Хорошо</button>
        <button type="button" className="button-secondary full-width" onClick={() => { tap(); setEdit(true); }}>Поменять цену</button>
      </div>
    ) : (
      <div className="inv-actions">
        <button type="button" className="button-primary full-width" disabled={state === "busy"} onClick={want}><Spark />{state === "busy" ? "Записываем…" : "Хочу Плюс"}</button>
        <p className="pl-fine">Это не покупка: ничего не списываем и карту не просим.</p>
        {state === "error" && <p className="pl-fine" role="alert">Не получилось сохранить. Попробуйте ещё раз.</p>}
      </div>
    )}>
      {done ? (
        <div className="pl-thanks" role="status">
          <span className="pl-thanks-glyph" aria-hidden="true">✦</span>
          <p><strong>Записали ваш интерес к Плюсу{p.interest?.priceChoice ? ` — ${rub(p.interest.priceChoice)}` : ""}.</strong></p>
          <p className="muted">Сейчас бета, и всё уже работает бесплатно. Перед стартом Плюса напомним заранее — без автосписаний и сюрпризов.</p>
        </div>
      ) : (<>
        {beta && (
          <div className="pl-beta">
            <span className="pl-badge">Бета: всё бесплатно</span>
            <p><strong>Сейчас в бете всё бесплатно.</strong> {t.left == null ? "AI-ответы без лимита." : `Вам доступно до ${Q.beta.perDay} ${answersWord(Q.beta.perDay)} в день — осталось ${t.left}.`}</p>
          </div>
        )}
        {!beta && <div className="pl-beta"><span className="pl-badge">{p.label}</span><p>✦ Осталось {t.left ?? "∞"} {answersWord(t.left ?? 5)} · новые {t.resetLabel}</p></div>}
        <div className="pl-cols">
          <div className="pl-col">
            <div className="pl-col-head"><strong>Бесплатно</strong><span className="pl-price">0&nbsp;₽</span></div>
            <ul className="pl-list">{FREE_FOREVER.map((x) => <li key={x}>{x}</li>)}<li>{Q.free.perWindow} AI-ответов за 30 дней</li><li>Голос — {Q.free.voiceMin} мин</li></ul>
            <p className="pl-col-note">Всегда, без ограничений по главному</p>
          </div>
          <div className="pl-col pl-col-plus">
            <div className="pl-col-head"><strong><Spark />Плюс</strong><span className="pl-price">{rub(pr.plusRub)}</span></div>
            <ul className="pl-list"><li>Всё из бесплатного</li><li>{Q.plus.perWindow} AI-ответов за 30 дней</li><li>«Почему так?», сравнения, разговор о цели</li><li>Разборы недели и месяца</li><li>Голос — {Q.plus.voiceMin} мин</li></ul>
            <p className="pl-col-note">{pr.afterBeta ? "после беты · " : ""}{pr.periodDays} дней, без автопродления</p>
          </div>
        </div>
        {pr.options.length > 1 && (
          <div className="pl-fair">
            <p className="question-label">Какая цена вам подходит?</p>
            <div className="chips" role="group" aria-label="Какая цена вам подходит">
              {pr.options.map((o) => <button key={o} type="button" className={"chip" + (price === o ? " is-on" : "")} aria-pressed={price === o} onClick={() => { tap(); setPrice(o); }}>{rub(o)}</button>)}
              <button type="button" className={"chip chip-ghost" + (price == null ? " is-on" : "")} aria-pressed={price == null} onClick={() => { tap(); setPrice(null); }}>Не знаю</button>
            </div>
          </div>
        )}
        <p className="pl-fine">AI-ответ — объяснение «Почему так?», сравнение или разговор о цели. Вопросы «Можно?» — бесплатно и без лимита. Понимание вашей фразы, распознавание голоса и неудачные ответы не считаются.</p>
      </>)}
    </Sheet>
  );
}

/** «Почему так? ✦» под вердиктом: AI-объяснение или шаблон с теми же числами; мягкая строка, если ответы закончились. */
export type ExplainView = { reply: string; mode: "ai" | "template"; note: string | null; exhausted: boolean };
export function ExplainButton({ decisionId, fallback = [], onResult }: { decisionId: string; fallback?: string[]; onResult: (r: ExplainView) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="chip chip-share pl-why" disabled={busy} onClick={async () => {
      tap(); setBusy(true);
      try {
        const r = await fetch("/api/v1/explain", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisionId }) });
        const j = await r.json().catch(() => null);
        if (r.ok && j?.reply) { onResult({ reply: j.reply, mode: j.mode, note: j.note ?? null, exhausted: !!j.tokens?.exhausted && j.reason === "quota" }); return; }
        throw new Error("explain");
      } catch {
        // Сервер недоступен или расчёт не найден — показываем строки расчёта из самого ответа, ничего не теряем.
        onResult({ reply: fallback.length ? ["Почему так:", ...fallback].join("\n") : "Не получилось объяснить. Спросите «Можно?» ещё раз.", mode: "template", note: null, exhausted: false });
      } finally { setBusy(false); }
    }}>{busy ? "Объясняем…" : <>Почему так? <Spark /></>}</button>
  );
}
export function ExplainBubble({ r, onPlus }: { r: ExplainView; onPlus: () => void }) {
  return (
    <div className={"bubble bot pl-explain" + (r.mode === "ai" ? " is-ai" : "")}>
      {r.reply.split("\n").filter(Boolean).map((l, i) => <p key={i}>{l}</p>)}
      {r.note && (
        <div className={"pl-note" + (r.exhausted ? " is-out" : "")}>
          <span>{r.note}</span>
          {r.exhausted && <button type="button" className="pl-note-link" onClick={() => { tap(); onPlus(); }}>Что такое Плюс</button>}
        </div>
      )}
    </div>
  );
}
