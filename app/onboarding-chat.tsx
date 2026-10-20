"use client";
// Полноэкранный онбординг-чат (emerald glass). Один вопрос за раз, варианты ответа под вопросом,
// свободный ответ — только в нижнем поле. Нажатие на вариант = обычное сообщение пользователя.
import type { FactChip } from "../lib/onboarding/orchestrator";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type Choice = { id: string; label: string; userText: string };
type Card =
  | { type: "preview"; data: { title: string; amount: string; sub: string }; preliminary?: boolean; caveats?: string[] }
  | { type: "summary"; data: { rows: { slot: string; label: string; value: string; missing: boolean }[] } };
type AMsg = { id: string; role: "assistant"; lead?: string; text: string; cards: Card[]; choices: Choice[]; choiceLayout?: "row" | "stack"; revision: number; placeholder?: string };
type UMsg = { id: string; role: "user"; text: string; via?: string; pending?: boolean };
/** key — устойчивый визуальный ключ (временный пузырь не появляется второй раз); fresh — анимируем только новое, не историю. */
type Msg = (AMsg | UMsg) & { key?: string; fresh?: boolean };

const uuid = () => (globalThis.crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }));
/** Лёгкий тактильный отклик Telegram (только Mini App, не при reduced motion). */
function haptic(kind: "pick" | "success") {
  try {
    if (reduced()) return;
    const h = (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: { selectionChanged?: () => void; notificationOccurred?: (t: string) => void } } } }).Telegram?.WebApp?.HapticFeedback;
    if (kind === "pick") h?.selectionChanged?.(); else h?.notificationOccurred?.("success");
  } catch { /* нет API — тихо */ }
}
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export type OnboardingChatProps = { mode: "initial" | "edit"; slot?: string; onClose: (done: boolean) => void };

export default function OnboardingChat({ mode, slot, onClose }: OnboardingChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [progress, setProgress] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(true);
  // Индикатор «думаю» — только если ответ дольше 120 мс: быстрый ответ без вспышки точек.
  const [thinking, setThinking] = useState(false);
  useEffect(() => { if (!busy) { setThinking(false); return; } const t = setTimeout(() => setThinking(true), 120); return () => clearTimeout(t); }, [busy]);
  const [err, setErr] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);
  // «Уже учтено»: факты с сервера; новый — мягко появляется, исправленный — подсвечивается.
  const [facts, setFacts] = useState<FactChip[]>([]);
  const [flash, setFlash] = useState<Record<string, "new" | "fix">>({});
  const applyFacts = useCallback((next: FactChip[] | undefined, animate: boolean) => {
    if (!next) return;
    setFacts((prev) => {
      if (animate) {
        const pm = new Map(prev.map((f) => [f.slot, f]));
        const fl: Record<string, "new" | "fix"> = {};
        for (const f of next) { const o = pm.get(f.slot); if (!o) fl[f.slot] = "new"; else if (o.value !== f.value) fl[f.slot] = "fix"; }
        if (Object.keys(fl).length) { setFlash(fl); setTimeout(() => setFlash({}), 1800); }
      }
      return next;
    });
  }, []);
  const stick = useRef(true);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Поле ввода над клавиатурой: высота контейнера = visualViewport.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => rootRef.current?.style.setProperty("--ob-vh", `${vv.height}px`);
    fit(); vv.addEventListener("resize", fit);
    return () => vv.removeEventListener("resize", fit);
  }, []);

  useEffect(() => {
    let alive = true;
    post("/api/v1/onboarding", { mode, ...(slot ? { slot } : {}) }).then((r) => {
      if (!alive) return;
      if (r.ok && r.j.skip) { onClose(true); return; }
      if (!r.ok) { setErr(r.j?.error?.message ?? "Не получилось открыть. Попробуйте ещё раз."); setBusy(false); return; }
      { const ms = (r.j.messages ?? []) as Msg[]; const n = ms.length; setMsgs(ms.map((x, i) => (i === n - 1 && x.role === "assistant" ? { ...x, fresh: true } : x))); } /* новое приветствие — мягко, история — статично */ setProgress(r.j.progress ?? 0); applyFacts(r.j.facts, false); setBusy(false);
    }).catch(() => { if (alive) { setErr("Нет связи. Попробуйте ещё раз."); setBusy(false); } });
    return () => { alive = false; };
  }, [mode, slot, onClose, applyFacts]);

  // Автоскролл — только если пользователь уже внизу.
  const onScroll = () => { const el = logRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  useLayoutEffect(() => { const el = logRef.current; if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: reduced() ? "auto" : "smooth" }); }, [msgs, busy]);

  const lastA = [...msgs].reverse().find((m): m is AMsg => m.role === "assistant");
  // Последняя (видимая внизу) карточка расчёта/итога «перетекает» в карточку дня на главной (View Transitions).
  const heroMsg = [...msgs].reverse().find((m): m is AMsg => m.role === "assistant" && !!(m as AMsg).cards?.length);
  const heroId = heroMsg?.id;
  const heroIdx = heroMsg ? heroMsg.cards.length - 1 : -1;

  const send = useCallback(async (text: string, choice?: { msg: AMsg; c: Choice }) => {
    if (busy || (!choice && !text.trim())) return;
    const clientMessageId = uuid();
    const shown = choice ? choice.c.userText : text.trim();
    stick.current = true;
    if (choice) haptic("pick");
    const vkey = "u-" + clientMessageId;
    setMsgs((m) => [...m, { id: "tmp-" + clientMessageId, key: vkey, fresh: true, role: "user", text: shown, pending: true, via: choice ? "choice" : "text" }]);
    setInput(""); setBusy(true); setErr("");
    try {
      const body = { clientMessageId, text: shown, ...(choice ? { selection: { assistantMessageId: choice.msg.id, choiceId: choice.c.id, revision: choice.msg.revision } } : {}) };
      let r = await post("/api/v1/onboarding/turn", body).catch(() => null);
      if (!r) r = await post("/api/v1/onboarding/turn", body).catch(() => null); // повтор безопасен: clientMessageId
      if (!r || !r.ok) {
        setMsgs((m) => m.filter((x) => x.id !== "tmp-" + clientMessageId));
        if (r?.status === 409 && r.j?.error?.code === "ONBOARDING_NOT_ACTIVE") { onClose(true); return; }
        setErr(r ? r.j?.error?.message ?? "Не получилось отправить." : "Нет связи. Попробуйте ещё раз.");
        if (!choice) setInput(text);
        return;
      }
      // Серверный пузырь пользователя наследует ключ временного: без повторного появления.
      const incoming = (r.j.messages as Msg[]).map((x) => (x.role === "user" ? { ...x, key: vkey, fresh: true, via: choice ? "choice" : "text" } : { ...x, fresh: true }));
      setMsgs((m) => [...m.filter((x) => x.id !== "tmp-" + clientMessageId), ...incoming]);
      setProgress(r.j.progress ?? 0);
      applyFacts(r.j.facts, true);
      if (r.j.done) { haptic("success"); setTimeout(() => onClose(true), reduced() ? 250 : 900); }
    } finally { setBusy(false); }
  }, [busy, onClose, applyFacts]);

  return (
    <div className="ob-chat" ref={rootRef} role="dialog" aria-modal="true" aria-label="Знакомство с «Можно?»">
      <header className="ob-top">
        <span className={"ob-mini-orb" + (busy ? " is-thinking" : "")} aria-hidden="true"><img src="/ill/orb.webp" alt="" draggable={false} /></span>
        <div className="ob-progress" role="progressbar" aria-label="Осталось чуть-чуть" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ transform: `scaleX(${Math.max(0.04, Math.min(1, progress))})` }} />
        </div>
        <button type="button" className="ob-later" onClick={() => onClose(false)}>Позже</button>
      </header>
      {facts.length > 0 && (
        <div className="ob-facts" role="list" aria-label="Уже учтено">
          <span className="ob-facts-title">Уже учтено</span>
          {facts.map((f) => (
            <span key={f.slot} role="listitem" className={"ob-fact" + (flash[f.slot] ? " is-" + flash[f.slot] : "")}>
              <b>{f.label}</b>{f.approximate ? "≈ " : ""}{f.value}
            </span>
          ))}
        </div>
      )}
      <div className="ob-log" ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {msgs.map((m, i) => m.role === "user" ? (
          <div key={m.key ?? m.id} className={"ob-row ob-me" + (m.pending ? " is-pending" : "") + (m.fresh ? " is-fresh" : "") + (m.via === "choice" ? " from-choice" : "")}><div className="ob-bubble ob-bubble-me">{m.text}</div></div>
        ) : (
          <div key={m.key ?? m.id} className={"ob-row ob-bot" + (m.fresh ? " is-fresh" : "")}>
            {i === msgs.findIndex((x) => x.role === "assistant") && <span className="ob-orb" aria-hidden="true"><img src="/ill/orb.webp" alt="" draggable={false} /></span>}
            {m.lead && <div className="ob-bubble ob-bubble-bot">{m.lead}</div>}
            {m.cards.map((c, k) => c.type === "preview" ? (
              <section key={k} className={"ob-card ob-preview" + (m.fresh ? " is-materializing" : "")} aria-label="Первый прогноз" style={m.id === heroId && k === heroIdx ? { viewTransitionName: "ob-hero" } : undefined}>
                <div className="ob-card-head"><span>{c.data.title}</span>{c.preliminary && <em>предварительно</em>}</div>
                <strong className="ob-amount">{c.data.amount}</strong>
                <span className="ob-sub">{c.data.sub}</span>
                {!!c.caveats?.length && <p className="ob-caveats">{c.caveats.join(" · ")}</p>}
              </section>
            ) : (
              <section key={k} className="ob-card ob-summary" aria-label="Вот что я понял" style={m.id === heroId && k === heroIdx ? { viewTransitionName: "ob-hero" } : undefined}>
                <h3>Вот что я понял</h3>
                <dl>{c.data.rows.map((r) => <div key={r.slot} className={r.missing ? "is-missing" : ""}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
              </section>
            ))}
            {m.text && <div className="ob-bubble ob-bubble-bot">{m.text}</div>}
            {m.choices.length > 0 && (
              <div className={"ob-choices" + (m.choiceLayout === "stack" ? " is-stack" : "")} role="group" aria-label="Варианты ответа">
                {m.choices.map((c) => {
                  const active = m === lastA && !busy;
                  return (
                    <button key={c.id} type="button" className={"ob-choice" + (c.label === "Готово" ? " is-primary" : "")} disabled={!active}
                      onClick={() => send(c.userText, { msg: m, c })}>{c.label}</button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {busy && thinking && <div className="ob-row ob-bot is-fresh"><div className="ob-typing" role="status" aria-label="Думаю"><i /><i /><i /></div></div>}
        {err && <p className="ob-error" role="alert">{err}</p>}
      </div>
      <form className="ob-composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <label className="sr-only" htmlFor="ob-input">Ответ</label>
        <input id="ob-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder={lastA?.placeholder ?? "Напишите ответ"} autoComplete="off" enterKeyHint="send" />
        <button type="submit" className="ob-send" disabled={busy || !input.trim()} aria-label="Отправить">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
        </button>
      </form>
    </div>
  );
}
