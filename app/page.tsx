"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import OnboardingChat from "./onboarding-chat";
import RemindersSettings from "./reminders-settings";
import { flushSync } from "react-dom";
import { trackClient, wireAnalytics, firstVisitBody, pendingRef, clearPendingRef } from "./analytics-client";
import { AnswerShareMenu, GiftIcon, InviteCard, InviteSheet, ShareResultSheet, safeItem } from "./invite";
import { chipQuery, showStarterChips } from "./suggest-chips";
import { shouldShowVerdictActions, smartSuggestionFor, type SmartSuggestion } from "./verdict-actions";
import { ExplainBubble, ExplainButton, PlusCard, PlusSheet, TokenCounter, usePlan, type ExplainView, type PlusSurface } from "./plus";

/** Онбординг-чат вместо формы. По умолчанию включён; NEXT_PUBLIC_CHAT_ONBOARDING=0 возвращает старую форму. */
const CHAT_ONBOARDING = process.env.NEXT_PUBLIC_CHAT_ONBOARDING !== "0";
type ObState = { phase: string; mode: string; planSaved: boolean; progress: number } | null;

type Payment = { name: string; amount: number; date: string };
type PlanBar = { balance: number; payments: number; reserve: number; goal: number; life: number };
type Snapshot = { daysToIncome: number; freeMoney: number; safeDaily: number; mandatoryBeforeIncome: number; goalSetAside: number; upcomingPayments: Payment[]; cashGap?: { date: string; amount: number } | null; limitations?: string[]; freeMoneyKnown?: boolean; horizonEnd?: string; planBar?: PlanBar };
type Profile = { balance: number; reserve: number; nextIncome: { date: string; amount: number }; payments: Payment[]; goal?: { name: string; amount: number; date: string; saved?: number } | null };
type Decision = { at: string; question: string; item: string; price: number; verdict: string; freeAfter: number };
type State = { id: string; profile: Profile | null; snapshot: Snapshot | null; history: Decision[]; llm: boolean; storage: string };

const rub = (n: number) => `${(Math.floor(Math.abs(n) * 100 + 1e-6) / 100 * Math.sign(n)).toLocaleString("ru-RU", { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2 }).replace(/\s/g, "\u00a0")}\u00a0₽`;
const LIMITS: Record<string, string> = {
  ESSENTIAL_SPENDING_UNKNOWN: "Повседневные траты пока не учтены. Можно добавить их в плане.",
  INCOME_OVERDUE: "Дата дохода прошла. Обновите её, когда будет время.",
  HORIZON_ASSUMED: "Следующий доход неизвестен, считаем на 30 дней.",
};
const uuid = () => (crypto as any).randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const post = (url: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ok: r.ok, j: await r.json().catch(() => ({})) }));
/** Same-origin GET with cookies — required in Telegram Mini App iframe (third-party context). */
const apiGet = (url: string) => fetch(url, { credentials: "include" });
type Proposal = { id: string; revision: number; status: string; payload: { direction: string; amountMinor: string; description?: string; date: string } };

function ProposalCard({ initial, onApplied }: { initial: Proposal; onApplied: () => void }) {
  const [p, setP] = useState(initial);
  const [state, setState] = useState<"idle" | "pending" | "done" | "rejected" | "error">(initial.status === "applied" ? "done" : initial.status === "rejected" ? "rejected" : "idle");
  const [note, setNote] = useState("");
  const key = useRef<string>(uuid());
  const amount = Number(p.payload.amountMinor) / 100;
  async function confirm() {
    setState("pending"); setNote(""); tap();
    try {
      const r = await post(`/api/v1/proposals/${p.id}/confirm`, { revision: p.revision }, { "Idempotency-Key": key.current });
      if (r.ok) { setState("done"); onApplied(); return; }
      const code = r.j?.error?.code;
      if (r.status === 409 && r.j?.proposal) { setP(r.j.proposal); key.current = uuid(); setNote("План успел измениться. Проверьте обновлённую запись."); setState("idle"); return; }
      setNote(code === "PROPOSAL_EXPIRED" ? "Предложение устарело. Напишите трату ещё раз." : "Не получилось записать. Попробуйте ещё раз."); setState("error");
    } catch { setNote("Нет связи. Нажмите ещё раз, повтор безопасен."); setState("error"); }
  }
  async function reject() {
    tap(); setState("pending"); setNote("");
    const r = await post(`/api/v1/proposals/${p.id}/reject`).catch(() => null);
    if (r?.ok && r.j?.proposal?.status === "applied") { setState("done"); setNote("Эта запись уже сохранена."); return; }
    if (r?.ok) { setState("rejected"); return; }
    setNote(r ? "Не получилось отменить. Попробуйте ещё раз." : "Нет связи. Попробуйте ещё раз."); setState("error");
  }
  return (
    <div className={"proposal-card" + (state === "done" ? " is-done" : "")}>
      <div className="proposal-row">
        <span className="proposal-glyph" aria-hidden="true">{p.payload.direction === "income" ? "+" : "−"}</span>
        <span className="proposal-main"><strong>{p.payload.description || (p.payload.direction === "income" ? "Доход" : "Расход")}</strong><small>{shortDate(p.payload.date)}</small></span>
        <strong className="proposal-amount">{p.payload.direction === "income" ? "+" : "−"}{rub(amount)}</strong>
      </div>
      {note && <p className="proposal-note">{note}</p>}
      {state === "done" ? <p className="proposal-status"><Icon name="check" /> Записано, план обновлён</p>
        : state === "rejected" ? <p className="proposal-status muted">Хорошо, не записываем</p>
        : (
          <div className="proposal-actions">
            <button type="button" className="button-primary" disabled={state === "pending"} onClick={confirm}>{state === "pending" ? "Записываем…" : state === "error" ? "Повторить" : "Записать"}</button>
            <button type="button" className="button-secondary" disabled={state === "pending"} onClick={reject}>Не записывать</button>
          </div>
        )}
    </div>
  );
}

/** «✓ Купил» (aria: «Купил — записать») под ответом «Можно?»: сервер готовит предложение на товар и цену из расчёта, дальше — обычная ProposalCard. */
function BoughtButton({ decisionId, onProposal }: { decisionId: string; onProposal: (r: { reply: string; proposal: Proposal }) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <>
      <button type="button" className="va-bought" aria-label="Купил — записать" title="Купил — записать" disabled={busy} onClick={async () => {
        setBusy(true); setErr("");
        const tg = tgWebApp() as any;
        if (tg?.HapticFeedback?.impactOccurred) tg.HapticFeedback.impactOccurred("light");
        try {
          const r = await post("/api/v1/proposals", { type: "from_decision", decisionId });
          if (r.ok && r.j?.proposal) { onProposal({ reply: r.j.reply || "Проверьте запись и подтвердите.", proposal: r.j.proposal }); return; }
          setErr(r.j?.error?.message || "Не получилось подготовить запись. Попробуйте ещё раз.");
        } catch { setErr("Нет связи. Попробуйте ещё раз."); }
        finally { setBusy(false); }
      }}><Icon name="check" />{busy ? "…" : "Купил"}</button>
      {err && <p className="proposal-note va-err" role="alert">{err}</p>}
    </>
  );
}

function TelegramLink({ linked, onLinked }: { linked: boolean; onLinked: () => void }) {
  const [link, setLink] = useState<{ id: string; command: string; deepLink: string | null } | null>(null);
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!link || status === "approved" || status === "done") return;
    const t = setInterval(async () => {
      const r = await apiGet(`/api/v1/account-links/${link.id}`).then((r) => r.json()).catch(() => null);
      if (r?.status) setStatus(r.status);
      if (r?.status === "expired") clearInterval(t);
    }, 2500);
    return () => clearInterval(t);
  }, [link, status]);
  async function start() { tap(); setErr(""); const r = await post("/api/v1/account-links"); if (r.ok) { setLink(r.j); setStatus("pending"); } else setErr("Не получилось создать код. Попробуйте позже."); }
  async function confirm() {
    tap(); const r = await post(`/api/v1/account-links/${link!.id}/confirm`);
    if (r.ok) { setStatus("done"); onLinked(); }
    else setErr(r.j?.error?.code === "LINK_CONFLICT" ? "У этого Telegram уже есть свой план. Объединять автоматически не будем." : "Не получилось подтвердить. Создайте новый код.");
  }
  return (
    <section className="tg-card glass" aria-labelledby="tg-title">
      <div className="tg-head"><span className="tg-glyph" aria-hidden="true"><Icon name="send" /></span><div><h3 id="tg-title">Telegram</h3>
        <p className="muted">{linked || status === "done" ? "Связан. План общий в боте и здесь." : "Спрашивайте «Можно?» прямо в мессенджере."}</p></div></div>
      {linked || status === "done" ? null : !link ? (
        <button type="button" className="button-secondary full-width" onClick={start}>Связать с Telegram</button>
      ) : status === "approved" ? (
        <button type="button" className="button-primary full-width" onClick={confirm}>Подтвердить связь</button>
      ) : status === "expired" ? (
        <button type="button" className="button-secondary full-width" onClick={() => { setLink(null); setStatus(""); }}>Код истёк, создать новый</button>
      ) : (
        <div className="tg-steps">
          {link.deepLink ? (
            <a className="button-primary full-width" href={link.deepLink} target="_blank" rel="noreferrer">Открыть Telegram</a>
          ) : (
            <>
              <p className="tg-hint">Отправьте боту эту команду:</p>
              <div className="tg-code"><code>{link.command}</code>
                <button type="button" className="chip" onClick={() => { tap(); navigator.clipboard?.writeText(link.command).then(() => setCopied(true)); }}>{copied ? "Скопировано" : "Копировать"}</button></div>
            </>
          )}
          <p className="tg-wait"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>Ждём, пока вы нажмёте «Разрешить» в боте…</p>
        </div>
      )}
      {err && <p className="proposal-note">{err}</p>}
    </section>
  );
}
const VERDICT: Record<string, string> = {
  yes: "можно",
  careful: "аккуратно",
  wait: "лучше подождать",
  no: "пока не стоит",
};

const VERDICT_ICON: Record<string, string> = { yes: "check", careful: "wave", wait: "clock", no: "pause" };
const SHORT: Record<string, string> = { balance: "На карте", incomeAmount: "Доход", incomeDate: "Дата дохода", payments: "Платежи", reserve: "Резерв", essentialDaily: "На каждый день", goal: "Цель" };
const isoIn = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const isoDay = (day: number) => { const d = new Date(); if (d.getDate() >= day) d.setMonth(d.getMonth() + 1); d.setDate(day); return d.toISOString().slice(0, 10); };
const daysUntil = (iso: string) => Math.round((new Date(iso + "T00:00:00").getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
const shortDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(" ", "\u00a0");
const untilDate = (iso: string) => {
  const n = daysUntil(iso);
  const label = new Date(iso + "T00:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  if (n <= 0) return "Сегодня";
  if (n === 1) return "До завтра";
  return `До\u00a0${label}`; // «До» не отрывается от числа; месяц может перенестись на узкой карточке
};
const capName = (s: string) => { const t = (s || "").trim(); return t ? t.charAt(0).toLocaleUpperCase("ru-RU") + t.slice(1) : t; };
const QUICK: Record<string, { label: string; value: () => string; add?: boolean }[]> = {
  balance: [10000, 30000, 50000, 100000].map((n) => ({ label: rub(n), value: () => String(n) })),
  incomeAmount: [40000, 60000, 80000, 120000].map((n) => ({ label: rub(n), value: () => String(n) })),
  incomeDate: [
    { label: "Через неделю", value: () => isoIn(7) },
    { label: "Через 2 недели", value: () => isoIn(14) },
    { label: "1-го числа", value: () => isoDay(1) },
    { label: "15-го числа", value: () => isoDay(15) },
  ],
  payments: [
    { label: "+ Аренда", value: () => `Аренда 30000 ${isoIn(5)}`, add: true },
    { label: "+ Интернет", value: () => `Интернет 900 ${isoIn(3)}`, add: true },
    { label: "+ Связь", value: () => `Связь 600 ${isoIn(10)}`, add: true },
    { label: "+ Кредит", value: () => `Кредит 15000 ${isoIn(12)}`, add: true },
  ],
  essentialDaily: [{ label: "Не знаю", value: () => "" }, ...[500, 1000, 1500, 2000].map((n) => ({ label: rub(n), value: () => String(n) }))],
  reserve: [0, 5000, 10000, 20000].map((n) => ({ label: n ? rub(n) : "Без резерва", value: () => String(n) })),
  goal: [
    { label: "Без цели", value: () => "" },
    { label: "Отпуск 60 000 за полгода", value: () => `Отпуск 60000 ${isoIn(182)}` },
    { label: "Подушка 100 000 за год", value: () => `Подушка 100000 ${isoIn(365)}` },
  ],
};
const CATS = [
  { label: "Продукты", want: "продукты", bought: "Купил продукты" },
  { label: "Кафе", want: "обед в кафе", bought: "Потратил {sum} на кафе" },
  { label: "Транспорт", want: "такси", bought: "Потратил {sum} на транспорт" },
  { label: "Одежда", want: "одежду", bought: "Купил одежду" },
  { label: "Подарок", want: "подарок", bought: "Купил подарок" },
];
const SUGGEST = ["Можно купить кофе за 300?", "Наушники за 15 000?", "Сколько можно тратить в день?", "Куртка за 8 000?"];
const replyVerdict = (t: string) => /^Пока не стоит/.test(t) ? "no" : /^Лучше подождать/.test(t) ? "wait" : /^Можно, но/.test(t) ? "careful" : /^Можно[:.]/.test(t) ? "yes" : "";

const tgWebApp = () => (typeof window !== "undefined" ? (window as any).Telegram?.WebApp : null);
const tap = () => {
  try {
    const tg = tgWebApp();
    if (tg?.HapticFeedback?.impactOccurred) tg.HapticFeedback.impactOccurred("light");
    else navigator.vibrate?.(8);
  } catch {}
};
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const longDate = (v: string) => v ? new Date(v + "T00:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" }) : "";

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head"><h3>{title}</h3><button type="button" className="sheet-close" onClick={onClose} aria-label="Закрыть">×</button></div>
        {children}
      </div>
    </div>
  );
}

function CalendarSheet({ value, onPick, onClose }: { value: string; onPick: (v: string) => void; onClose: () => void }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const base = value ? new Date(value + "T00:00:00") : today;
  const [m, setM] = useState(new Date(base.getFullYear(), base.getMonth(), 1));
  const lead = (m.getDay() + 6) % 7;
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(m.getFullYear(), m.getMonth(), i + 1))];
  const canPrev = m > new Date(today.getFullYear(), today.getMonth(), 1);
  return (
    <Sheet title="Когда придёт доход" onClose={onClose}>
      <div className="cal-nav">
        <button type="button" className="cal-arrow" disabled={!canPrev} onClick={() => setM(new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="Предыдущий месяц">‹</button>
        <strong>{MONTHS[m.getMonth()]} {m.getFullYear()}</strong>
        <button type="button" className="cal-arrow" onClick={() => setM(new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Следующий месяц">›</button>
      </div>
      <div className="cal-grid" role="grid">
        {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => <span key={d} className="cal-dow">{d}</span>)}
        {cells.map((d, i) => d ? (
          <button key={i} type="button" disabled={d < today}
            className={"cal-day" + (iso(d) === value ? " is-on" : "") + (iso(d) === iso(today) ? " is-today" : "")}
            onClick={() => { tap(); onPick(iso(d)); }}>{d.getDate()}</button>
        ) : <span key={i} />)}
      </div>
    </Sheet>
  );
}

/** Строки расчёта после заголовка ответа (для запасного объяснения, если «Почему так?» не смог ответить). */
const replyDetails = (text: string) => text.split("\n").filter(Boolean).slice(1);

const VERDICT_TAG: Record<string, string> = { yes: "Можно", careful: "Можно, но аккуратно", wait: "Лучше подождать", no: "Пока не стоит" };
const dayMonth = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "long" }).replace(" ", "\u00a0");

/** Строка «было → станет»: подпись слева (тап — подсказка), значения справа. «Было» серым, «станет» жирным. */
function DiffRow({ label, hint, before, after, warn = false }: { label: string; hint: string; before: string | null; after: string; warn?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"vc-row" + (warn ? " is-warn" : "") + (open ? " is-open" : "")}>
      <button type="button" className="vc-label" aria-expanded={open} onClick={() => { tap(); setOpen(!open); }}>
        <span>{label}</span><span className="vc-i" aria-hidden="true">i</span>
      </button>
      <span className="vc-vals" aria-label={before ? `было ${before}, станет ${after}` : after}>
        {before && <><span className="vc-before">{before}</span><span className="vc-arrow" aria-hidden="true">→</span></>}
        <strong className="vc-after">{after}</strong>
      </span>
      {open && <p className="vc-hint">{hint}</p>}
    </div>
  );
}

/**
 * Карточка вердикта. Заголовок — первая строка ответа движка («Можно: X за N ₽ — в рамках плана.»; цена уже в нём,
 * отдельной строки цены нет). Ниже — «Если купить · до <дата>»: было → станет для дневной суммы и «На покупки до дохода».
 * Объяснение — только кнопкой «Почему так? ✦» (explainable); без неё строки расчёта видны сразу.
 */
function BotReply({ text, impact, explainable = false, highlight = null }: { text: string; impact?: any; explainable?: boolean; highlight?: string | null }) {
  const v = (impact?.verdict && VERDICT_ICON[impact.verdict] ? impact.verdict : "") || replyVerdict(text);
  const lines = text.split("\n").filter(Boolean);
  if (!v) return <div className="bubble bot">{text}</div>;
  const details = lines.slice(1);
  const base = impact?.snapshot as Snapshot | undefined;
  const until: string | undefined = impact?.scenarios?.now?.horizonEnd ?? base?.horizonEnd;
  const foodKnown = base?.freeMoneyKnown !== false;
  const free = (n: number) => (n < 0 ? `не хватит ${rub(-n)}` : rub(n));
  return (
    <div className={"verdict-card vc-" + v}>
      <span className="vc-tag">{VERDICT_TAG[v]}</span>
      <div className="verdict-head">
        <span className={"verdict-dot v-" + v} aria-hidden="true"><Icon name={VERDICT_ICON[v]} /></span>
        <strong>{lines[0]}</strong>
      </div>
      {impact && (typeof impact.safeDailyAfter === "number" || typeof impact.freeAfter === "number") && (
        <div className="vc-diff" aria-label="Если купить">
          <div className="vc-diff-head"><span>Если купить{until ? <> · до {dayMonth(until)}</> : null}</span>{base && <span className="vc-cols" aria-hidden="true">было → станет</span>}</div>
          {typeof impact.safeDailyAfter === "number" && (
            <DiffRow label="Можно тратить в день" before={base ? rub(base.safeDaily) : null} after={rub(impact.safeDailyAfter)}
              hint="На всё: еду, транспорт и покупки. Платежи, резерв и деньги на цель уже отложены." />
          )}
          {typeof impact.freeAfter === "number" && (
            <DiffRow label="На покупки до дохода" before={base ? free(base.freeMoney) : null} after={free(impact.freeAfter)} warn={impact.freeAfter < 0}
              hint={foodKnown ? "Столько можно потратить разово сверх платежей, резерва, цели и ежедневных трат на еду и транспорт, чтобы хватило до дохода."
                : "Столько можно потратить разово сверх платежей, резерва и цели. Повседневные траты не указаны — из этой суммы нужны и деньги на еду с транспортом."} />
          )}
        </div>
      )}
      {!explainable && details.length > 0 && (
        <ul className="vc-lines">{details.map((l, i) => <li key={i} className={highlight && l === highlight ? "is-suggest" : undefined}>{l}</li>)}</ul>
      )}
    </div>
  );
}

/**
 * «Как считаем» — так, как считает движок (lib/engine/forecast.ts): из остатка откладываем платежи до дохода, резерв и цель;
 * дневная сумма — наименьшая, при которой хватает в КАЖДЫЙ день до дохода (еда и транспорт входят в неё);
 * «На покупки до дохода» — разово сверх ежедневных трат на еду и транспорт.
 */
function HowSheet({ s, income, essential, onClose }: { s: Snapshot; income: string; essential: number | null; onClose: () => void }) {
  const b: PlanBar | undefined = s.planBar;
  const days = s.daysToIncome;
  return (
    <Sheet title="Как считаем" onClose={onClose}>
      <div className="how sheet-body">
        <p className="how-lead">Смотрим на {days}{"\u00a0"}дн. — до дохода {dayMonth(income)}.</p>
        {b && (
          <ol className="how-calc" aria-label="Из чего складывается">
            <li><span>На карте</span><strong>{rub(b.balance)}</strong></li>
            <li><span>− платежи до дохода</span><strong>{rub(b.payments)}</strong></li>
            <li><span>− резерв</span><strong>{rub(b.reserve)}</strong></li>
            <li><span>− на цель</span><strong>{rub(b.goal)}</strong></li>
            <li className="how-total"><span>= на жизнь до дохода</span><strong>{rub(b.life)}</strong></li>
          </ol>
        )}
        <div className="how-step">
          <span className="how-num" aria-hidden="true">1</span>
          <div><strong>Можно тратить в день — {rub(s.safeDaily)}</strong>
            <p>Это наименьшая сумма, при которой денег хватает в каждый день до дохода — даже перед самым крупным платежом. Поэтому она может быть меньше, чем «на жизнь», делённое на {days}{"\u00a0"}дн. Еда, транспорт и покупки входят в неё.</p></div>
        </div>
        <div className="how-step">
          <span className="how-num" aria-hidden="true">2</span>
          <div><strong>На покупки до дохода — {rub(Math.max(0, s.freeMoney))}</strong>
            <p>{s.freeMoneyKnown === false
              ? "Столько можно потратить разово сверх платежей, резерва и цели. Повседневные траты пока не указаны, поэтому из этой суммы нужны и деньги на еду с транспортом."
              : `Столько можно потратить разово сверх платежей, резерва, цели и ежедневных трат на еду и транспорт${essential ? ` (${rub(essential)} в день)` : ""}, чтобы всё равно хватило до дохода.`}</p></div>
        </div>
        <p className="how-fine">{b && b.goal > 0 ? "«На цель» — то, что по плану нужно отложить до дохода, плюс уже накопленное на карте. " : ""}Решение за вами: мы только показываем последствия.</p>
      </div>
    </Sheet>
  );
}

const QUESTIONS = [
  { key: "balance", q: "Сколько сейчас денег на карте, которыми вы пользуетесь?", ph: "45000" },
  { key: "incomeAmount", q: "Сколько придёт в ближайший доход?", ph: "80000" },
  { key: "incomeDate", q: "Когда придёт доход?", type: "date" },
  { key: "payments", q: "Какие обязательные платежи учесть до дохода? Можно пропустить.", ph: "Аренда", area: true },
  { key: "reserve", q: "Сколько хотите всегда держать в резерве?", ph: "10000" },
  { key: "essentialDaily", q: "Сколько нужно в день на еду и транспорт? Можно пропустить.", ph: "1000" },
  { key: "goal", q: "На что копите? Название, сумма и дата — можно пропустить.", ph: "Отпуск 60000 2027-06-01" },
] as const;

const NAV = [
  { id: "home", label: "Главная", icon: "home" },
  { id: "plan", label: "План", icon: "plan" },
  { id: "assistant", label: "Помощник", icon: "orb" },
  { id: "payments", label: "Платежи", icon: "payments" },
  { id: "history", label: "История", icon: "history" },
] as const;

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
    plan: "M5 4h14v17H5ZM9 2v4m6-4v4M9 11h6m-6 4h6",
    payments: "M3 7h18v13H3ZM3 11h18M7 16h3M6 4h12",
    history: "M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2",
    bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
    arrow: "m5 12 14-7-6 14-2-7-6-2Zm6 2 8-9",
    plus: "M12 5v14M5 12h14",
    chevron: "m9 5 7 7-7 7",
    send: "M12 19V5m-6 6 6-6 6 6",
    mic: "M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6",
    stop: "M7 7h10v10H7Z",
    edit: "m14 5 5 5M4 20l5-1L21 7l-5-5L4 14Z",
    check: "m5 12.5 4.5 4.5L19 7.5",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
    wave: "M4 12c2.5-4 5.5-4 8 0s5.5 4 8 0",
    pause: "M9 6v12m6-12v12",
    spark: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6",
  };

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={paths[name] || paths.chevron} />
    </svg>
  );
}

function Orb() {
  return (
    <span className="orb orb-photo" aria-hidden="true">
      <img src="/ill/orb.webp" alt="" draggable={false} />
    </span>
  );
}

function Wallet() {
  return <img className="wallet-art wallet-photo" src="/ill/wallet.webp" alt="" aria-hidden="true" draggable={false} />;
}

function Router() {
  return <img className="mini-art mini-photo router-photo" src="/ill/router.webp" alt="" aria-hidden="true" draggable={false} />;
}

function GoalArt() {
  return <img className="mini-art mini-photo bag-photo" src="/ill/bag.webp" alt="" aria-hidden="true" draggable={false} />;
}

function Money({ value }: { value: number }) {
  const whole = Math.floor(Math.abs(value) + 1e-6);
  const frac = Math.round((Math.abs(value) % 1) * 100);
  return (
    <span className="money">
      {(value < 0 ? "−" : "") + whole.toLocaleString("ru-RU")}
      {frac > 0 && <span className="money-fraction">,{String(frac).padStart(2, "0")}</span>}
      <span className="money-currency"> ₽</span>
    </span>
  );
}

type Entry = { id: string; kind: string; amountMinor: string; name?: string; occurredAt: string; reversalOf?: string | null };
type Feed = ({ t: "d"; at: string; d: Decision } | { t: "e"; at: string; e: Entry })[];
const feed = (history: Decision[], entries: Entry[] = []): Feed =>
  [...history.map((d) => ({ t: "d" as const, at: d.at, d })), ...entries.filter((e) => !e.reversalOf).map((e) => ({ t: "e" as const, at: e.occurredAt, e }))]
    .sort((a, b) => +new Date(b.at) - +new Date(a.at));
const hhmm = (at: string) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

function HistoryList({ items, onAsk }: { items: Feed; onAsk?: () => void }) {
  return items.length ? (
    <ul className="decision-list glass">
      {items.map((it, i) => it.t === "e" ? (() => {
        const v = Number(it.e.amountMinor) / 100, inc = v > 0;
        return (
          <li key={"e" + it.e.id} className="decision is-entry">
            <span className={"decision-icon entry-icon" + (inc ? " is-income" : "")} aria-hidden="true">{inc ? "+" : "−"}</span>
            <div className="decision-copy">
              <strong>{capName(it.e.name || (inc ? "Доход" : "Расход"))}</strong>
              <p>{inc ? "Доход" : "Трата"}<span aria-hidden="true"> · </span><time dateTime={it.at}>{hhmm(it.at)}</time></p>
            </div>
            <div className="decision-value">
              <strong>{inc ? "+" : "−"}{rub(Math.abs(v))}</strong>
              <span className="bank-badge badge-recorded">Записано</span>
            </div>
          </li>
        );
      })() : ((h) => (
        <li key={"d" + i} className="decision is-check">
          <span className={"decision-icon v-" + h.verdict} aria-hidden="true">
            <Icon name={VERDICT_ICON[h.verdict] || "spark"} />
          </span>
          <div className="decision-copy">
            <strong>{capName(h.item)}</strong>
            <p>
              Вопрос
              <span aria-hidden="true"> · </span>
              <time dateTime={h.at}>{hhmm(h.at)}</time>
            </p>
            <p className={"decision-remain" + (h.freeAfter < 0 ? " is-warn" : "")}>{h.freeAfter < 0 ? `После покупки не хватило бы ${rub(-h.freeAfter)}` : `На покупки после: ${rub(h.freeAfter)}`}</p>
          </div>
          <div className="decision-value">
            <strong>{rub(h.price)}</strong>
            <span className={"verdict-chip v-" + h.verdict}>{VERDICT_TAG[h.verdict] || h.verdict}</span>
          </div>
        </li>
      ))(it.d))}
    </ul>
  ) : (
    <div className="empty-state glass">
      <Orb />
      <p><strong>Здесь появятся покупки и траты</strong><br />Спросите о покупке или запишите трату.</p>
      {onAsk && <button type="button" className="button-primary empty-action" onClick={onAsk}><Icon name="spark" />Можно?</button>}
    </div>
  );
}

/** Ответы формы из сохранённого профиля (при открытии и после конфликта версий). */
function answersFrom(initial?: Profile | null): Record<string, string> {
  return initial ? ({
    balance: String(initial.balance), incomeAmount: String(initial.nextIncome.amount), incomeDate: initial.nextIncome.date,
    payments: "", reserve: String(initial.reserve), essentialDaily: (initial as any).essentialDaily != null ? String((initial as any).essentialDaily) : "",
    goal: initial.goal ? `${initial.goal.name} ${initial.goal.amount} ${initial.goal.date}` : "" }) as Record<string, string> : {};
}

function Onboarding({ onDone, initial, baseVersion, onConflict }: { onDone: () => void; initial?: Profile | null; baseVersion?: string | null; onConflict?: () => void }) {
  const version = useRef<string | null>(baseVersion ?? null);
  const [step, setStep] = useState(0);
  const [a, setA] = useState<Record<string, string>>(() => answersFrom(initial));
  const [payList, setPayList] = useState<Payment[]>(() => initial?.payments ? [...initial.payments] : []);
  const [payDraft, setPayDraft] = useState({ name: "", amount: "", date: "" });
  const [err, setErr] = useState("");
  const [cal, setCal] = useState(false);
  const [payCal, setPayCal] = useState(false);
  const cur = QUESTIONS[step];
  const parseLine = (l: string) => { const m = l.trim().match(/^(.*?)\s+(\d[\d\s]*)\s+(\d{4}-\d{2}-\d{2})$/); return m ? { name: m[1], amount: Number(m[2].replace(/\s/g, "")), date: m[3] } : null; };

  function addPayment() {
    const name = payDraft.name.trim();
    const amount = Number(String(payDraft.amount).replace(/\s/g, "").replace(",", "."));
    if (!name || !(amount > 0) || !payDraft.date) { setErr("Укажите название, сумму и дату платежа"); return; }
    setPayList((xs) => [...xs, { name: capName(name), amount, date: payDraft.date }]);
    setPayDraft({ name: "", amount: "", date: "" }); setErr(""); tap();
  }

  async function submit() {
    const payments = payList;
    const g = a.goal?.trim() ? parseLine(a.goal) : null;
    if (a.goal?.trim() && !g) { setErr("Цель не распознана. Формат: Отпуск 60000 2027-06-01"); return; }
    const body = { balance: Number(a.balance), reserve: Number(a.reserve || 0), nextIncome: { amount: Number(a.incomeAmount), date: a.incomeDate }, payments, goal: g, ...(a.essentialDaily?.trim() ? { essentialDaily: Number(a.essentialDaily) } : {}),
      ...(version.current ? { baseFinanceVersion: version.current } : {}) };
    const r = await post("/api/profile", body).catch(() => null);
    if (!r) { setErr("Нет связи. Попробуйте ещё раз."); return; }
    if (r.status === 409 && r.j?.error?.code === "FINANCE_VERSION_CONFLICT") {
      // Мягко: загружаем весь актуальный план (остаток, доход, оставшиеся платежи, цель), чтобы не вернуть уже оплаченное.
      const fresh = await apiGet("/api/profile").then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (fresh?.profile) {
        version.current = fresh.meta?.financeVersion ?? null;
        setA(answersFrom(fresh.profile));
        setPayList([...(fresh.profile.payments ?? [])]);
        setStep(QUESTIONS.length);
      } else version.current = r.j.error.details?.financeVersion ?? null;
      setErr("Пока вы заполняли план, данные изменились (например, записалась трата в Telegram). Мы загрузили актуальные остаток, доход и платежи: проверьте их и нажмите «Сохранить» ещё раз.");
      onConflict?.();
      return;
    }
    if (!r.ok) { setErr(r.j?.error?.message ?? "Не получилось сохранить. Попробуйте ещё раз."); return; }
    onDone();
  }

  const isReview = step >= QUESTIONS.length;

  return (
    <section className="onboarding glass" aria-labelledby="onboarding-title">
      <div className="onboarding-heading">
        <span className="eyebrow">Ваш личный план</span>
        <span className="muted">
          {isReview ? "Итог" : `${step + 1} / ${QUESTIONS.length}`}
        </span>
      </div>
      <div className="step-track" aria-hidden="true">
        {QUESTIONS.map((x, i) => (
          <span key={x.key} className={i <= step ? "step-segment complete" : "step-segment"} />
        ))}
      </div>
      {step === 0 && <div className="onboarding-orb"><Orb /></div>}
      <h2 id="onboarding-title" key={step} className="step-in">{isReview ? "Всё верно?" : step === 0 ? (initial ? "Обновим ваш план" : "Давайте познакомимся") : SHORT[cur.key]}</h2>
      {step === 0 && <p className="onboarding-intro muted">7 коротких вопросов, около минуты. Можно выбрать готовый ответ.</p>}

      {!isReview ? (
        <>
          <div className="onboarding-question">
            <label className="question-label" htmlFor="setup-value">{cur.q}</label>
            {cur.key === "payments" ? (
              <div className="pay-fields">
                {payList.length > 0 && (
                  <ul className="pay-draft-list">
                    {payList.map((p, i) => (
                      <li key={i}>
                        <span><strong>{p.name}</strong> · {rub(p.amount)} · {shortDate(p.date)}</span>
                        <button type="button" className="text-button" onClick={() => setPayList(payList.filter((_, j) => j !== i))} aria-label="Удалить">×</button>
                      </li>
                    ))}
                  </ul>
                )}
                <label className="field-label" htmlFor="pay-name">Название</label>
                <input id="pay-name" placeholder="Аренда" value={payDraft.name} onChange={(e) => setPayDraft({ ...payDraft, name: e.target.value })} />
                <label className="field-label" htmlFor="pay-amount">Сумма</label>
                <input id="pay-amount" inputMode="decimal" placeholder="30000" value={payDraft.amount} onChange={(e) => setPayDraft({ ...payDraft, amount: e.target.value })} />
                <label className="field-label">Дата</label>
                <button type="button" className={"date-field" + (payDraft.date ? " has-value" : "")} onClick={() => { tap(); setPayCal(true); }}>
                  <Icon name="clock" />
                  <span>{payDraft.date ? longDate(payDraft.date) : "Выберите дату"}</span>
                </button>
                <button type="button" className="button-secondary full-width pay-add" onClick={addPayment}>Добавить платёж</button>
                {payCal && <CalendarSheet value={payDraft.date || ""} onClose={() => setPayCal(false)} onPick={(v) => { setPayDraft({ ...payDraft, date: v }); setPayCal(false); }} />}
              </div>
            ) : cur.key === "incomeDate" ? (
              <button id="setup-value" type="button" className={"date-field" + (a.incomeDate ? " has-value" : "")} onClick={() => { tap(); setCal(true); }}>
                <Icon name="clock" />
                <span>{a.incomeDate ? longDate(a.incomeDate) : "Выберите дату"}</span>
                {a.incomeDate && <em>{untilDate(a.incomeDate)}</em>}
              </button>
            ) : (
              <input
                id="setup-value"
                type="text"
                placeholder={"ph" in cur ? cur.ph : ""}
                value={a[cur.key] || ""}
                inputMode={"type" in cur || cur.key === "goal" ? undefined : "numeric"}
                onChange={(e) => setA({ ...a, [cur.key]: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && setStep(step + 1)}
              />
            )}
            {cur.key !== "payments" && (
            <div className="chips" role="group" aria-label="Быстрый выбор">
              {(QUICK[cur.key] || []).map((q) => {
                const v = q.value();
                const on = q.add ? false : (a[cur.key] || "") === v;
                return (
                  <button key={q.label} type="button" className={"chip" + (on ? " is-on" : "")} aria-pressed={on}
                    onClick={() => { tap(); setA({ ...a, [cur.key]: v }); }}>
                    {q.label}
                  </button>
                );
              })}
              {cur.key === "incomeDate" && <button type="button" className="chip chip-ghost" onClick={() => setCal(true)}>Другая дата…</button>}
            </div>
            )}
            {cur.key === "payments" && (
            <div className="chips" role="group" aria-label="Быстрый выбор">
              {(QUICK.payments || []).map((q) => {
                const parsed = parseLine(q.value());
                const on = parsed ? payList.some((p) => p.name === parsed.name) : false;
                return (
                  <button key={q.label} type="button" className={"chip" + (on ? " is-on" : "")} aria-pressed={on}
                    onClick={() => { tap(); if (!parsed || on) return; setPayList((xs) => [...xs, parsed]); }}>
                    {q.label}
                  </button>
                );
              })}
            </div>
            )}
          </div>
          {cal && <CalendarSheet value={a.incomeDate || ""} onClose={() => setCal(false)} onPick={(v) => { setA({ ...a, incomeDate: v }); setCal(false); }} />}
          <div className="onboarding-actions">
            <button type="button" className="button-primary onboarding-next" onClick={() => { tap(); setStep(step + 1); }}>
              {(cur.key === "goal" || cur.key === "essentialDaily") && !(a[cur.key] || "").trim() || (cur.key === "payments" && payList.length === 0 && !payDraft.name.trim()) ? "Пропустить" : "Дальше"} <Icon name="chevron" />
            </button>
            {step > 0 && (
              <button type="button" className="text-button back-link" onClick={() => setStep(step - 1)}>Назад</button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="review-intro muted">Нажмите на строку, чтобы поправить.</p>
          <ul className="review-list">
            {QUESTIONS.map((x, i) => (
              <li key={x.key}>
                <button type="button" className="review-answer" onClick={() => setStep(i)}>
                  <span>
                    <span className="review-label">{SHORT[x.key]}</span>
                    <strong>{x.key === "payments" ? (payList.length ? payList.map((p) => `${p.name} ${rub(p.amount)}`).join(", ") : "Нет") : (a[x.key] || "").trim() ? (/^\d+$/.test(a[x.key]) ? rub(Number(a[x.key])) : a[x.key]) : x.key === "essentialDaily" ? "Не знаю" : "Нет"}</strong>
                  </span>
                  <span className="review-edit"><Icon name="edit" /><span className="sr-only">Изменить</span></span>
                </button>
              </li>
            ))}
          </ul>
          <div className="onboarding-actions">
            <button type="button" className="button-primary" onClick={submit}>Готово, посчитать <Icon name="chevron" /></button>
          </div>
        </>
      )}
      {err && <p className="error-message" role="alert">{err}</p>}
    </section>
  );
}

export default function Home() {
  const [st, setSt] = useState<State | null>(null);
  const [authErr, setAuthErr] = useState("");
  const [edit, setEdit] = useState(false);
  // Держим чат на экране, пока грузится главная: смена экрана — одним коммитом внутри View Transition.
  const [holdChat, setHoldChat] = useState(false);
  const [remOpen, setRemOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [invite, setInvite] = useState<null | "answer" | "menu">(null);
  const [shareRes, setShareRes] = useState<null | { verdict: string; item: string | null }>(null);
  const [chat, setChat] = useState<null | { mode: "initial" | "edit"; slot?: string; from?: string }>(null);
  const [ob, setOb] = useState<ObState>(null);
  const [later, setLater] = useState(false);
  const [msgs, setMsgs] = useState<{ me: boolean; text: string; impact?: any; proposal?: Proposal; decisionId?: string; explained?: boolean; explain?: ExplainView; bought?: boolean; smartSuggestion?: SmartSuggestion | null }[]>([]);
  const [plusOpen, setPlusOpen] = useState<PlusSurface | null>(null);
  const [planTick, setPlanTick] = useState(0);
  const [plan, setPlan] = usePlan(!!st, planTick);
  const [sMode, setSMode] = useState<"want" | "bought">("want");
  const [sheet, setSheet] = useState(false);
  const [sAmt, setSAmt] = useState("");
  const [sItem, setSItem] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const [tab, setTab] = useState<(typeof NAV)[number]["id"]>("home");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (st) trackClient({ name: "screen_viewed", props: { screen: tab } }); }, [tab, !!st]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = logRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced() ? "auto" : "smooth" }); }, [msgs, busy, tab]);
  // GET не создаёт аккаунт: в Telegram Mini App вход по initData, в браузере — явное создание сессии.
  const load = async (): Promise<void> => {
    let r = await apiGet("/api/profile");
    if (r.status === 401) {
      const init = tgWebApp()?.initData;
      if (init) { const s = await post("/api/v1/session/telegram", { initData: init }); if (!s.ok) { setAuthErr("Не удалось подтвердить вход через Telegram. Откройте приложение из бота ещё раз."); return; } }
      else { await post("/api/v1/session", firstVisitBody()); clearPendingRef(); }
      r = await apiGet("/api/profile");
    } else if (!tgWebApp()?.initData && (new URLSearchParams(window.location.search).has("team") || pendingRef())) {
      // уже есть сессия: только пометка команды по коду; приглашение существующему аккаунту не засчитывается (сервер отметит «existing»)
      await post("/api/v1/session", firstVisitBody()); clearPendingRef();
    }
    if (r.ok) { setSt(await r.json()); wireAnalytics(); }
    if (CHAT_ONBOARDING) apiGet("/api/v1/onboarding").then((x) => (x.ok ? x.json() : null)).then((j) => setOb(j?.state ?? null)).catch(() => {});
  };
  const closeChat = useCallback((done: boolean) => {
    const swap = () => setChat((c) => { if (c?.from) setTab(c.from as (typeof NAV)[number]["id"]); return null; });
    if (!done) { swap(); setLater(true); load(); return; }
    // Итог → карточка дня: сначала данные, затем один синхронный коммит внутри startViewTransition (без рассинхрона React).
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!doc.startViewTransition || calm) { swap(); load(); return; }
    setHoldChat(true);
    // ob-vt: на время перехода гасим входные fadeUp главной, иначе новый снимок захватывается прозрачным.
    load().finally(() => {
      const root = document.documentElement; root.classList.add("ob-vt");
      const t = doc.startViewTransition!(() => flushSync(() => { setHoldChat(false); swap(); }));
      t.finished.finally(() => root.classList.remove("ob-vt"));
    });
  }, []);
  useEffect(() => {
    const tg = tgWebApp();
    if (!tg) return;
    try {
      tg.ready?.();
      tg.expand?.();
      tg.disableVerticalSwipes?.();
      if (tg.setHeaderColor) tg.setHeaderColor("secondary_bg_color");
      if (tg.setBackgroundColor) tg.setBackgroundColor("bg_color");
    } catch {}
  }, []);
  useEffect(() => {
    // В Mini App сначала входим как пользователь Telegram (initData проверяется на сервере), затем грузим план.
    // Если вход не удался, финансовый интерфейс не открываем: иначе остался бы доступен прежний аккаунт из cookie.
    const init = tgWebApp()?.initData;
    if (!init) { load(); return; }
    post("/api/v1/session/telegram", { initData: init }).catch(() => null).then((r) => {
      if (r?.ok) load(); else setAuthErr("Не удалось подтвердить вход через Telegram. Закройте и снова откройте приложение из бота.");
    });
  }, []);
  async function send(text: string) {
    if (!text.trim()) return;
    setMsgs((m) => [...m, { me: true, text }]); setInput(""); setBusy(true);
    try {
      const r = await fetch("/api/chat", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text }) }).then((r) => r.json());
      const ex: ExplainView | undefined = r.explain ? { reply: r.explain.reply, mode: r.explain.mode, note: r.explain.note ?? null, exhausted: !!r.explain.tokens?.exhausted && r.explain.reason === "quota" } : undefined;
      setMsgs((m) => [...m, { me: false, text: r.reply || r.error?.message || "Не получилось ответить. Попробуйте ещё раз.", impact: r.impact, proposal: r.proposal, decisionId: ex ? undefined : r.decisionId, explain: ex, smartSuggestion: smartSuggestionFor(r.impact, r.reply) }]); load();
      if (ex) setPlanTick((x) => x + 1);
    } finally { setBusy(false); }
  }

  function voice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SR) {
      const rec = new SR(); rec.lang = "ru-RU"; rec.interimResults = false;
      rec.onresult = (e: any) => send(e.results[0][0].transcript);
      rec.onend = () => setListening(false); rec.onerror = () => setListening(false);
      setListening(true); rec.start(); return;
    }
    // Fallback: запись и распознавание на сервере (нужен OPENAI_API_KEY)
    if (recRef.current) { recRef.current.stop(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const mr = new MediaRecorder(stream); const chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); recRef.current = null; setListening(false);
        const fd = new FormData(); fd.append("audio", new Blob(chunks, { type: "audio/webm" }), "voice.webm");
        const r = await fetch("/api/stt", { method: "POST", credentials: "include", body: fd }).then((r) => r.json());
        if (r.text) send(r.text); else setMsgs((m) => [...m, { me: false, text: "Голос не распознан: " + (r.error?.message || "") }]);
      };
      recRef.current = mr; mr.start(); setListening(true);
    });
  }

  if (authErr) return (
    <main className="app-shell loading-screen">
      <header className="app-header"><div><p className="brand-caption">Можно?</p><h1>Финансы</h1></div></header>
      <p className="proposal-note" role="alert">{authErr}</p>
    </main>
  );
  if (!st) return (
    <main className="app-shell loading-screen" aria-busy="true">
      <header className="app-header">
        <div><p className="brand-caption">Можно?</p><h1>Финансы</h1></div>
      </header>
      <div className="skel-wrap" role="status" aria-label="Загружаем ваш план">
        <div className="skel skel-hero" /><div className="skel-row"><div className="skel skel-mini" /><div className="skel skel-mini" /></div>
        <div className="skel skel-line" /><div className="skel skel-tile" /><div className="skel skel-tile" />
        <p className="sr-only">Загружаем ваш план…</p>
      </div>
    </main>
  );

  const s = st.snapshot;
  if (CHAT_ONBOARDING && (chat || holdChat || (!st.profile && !later))) {
    return <OnboardingChat key={chat ? `${chat.mode}-${chat.slot ?? ""}` : "initial"} mode={chat?.mode ?? "initial"} slot={chat?.slot} onClose={closeChat} />;
  }
  if (CHAT_ONBOARDING && !st.profile && later) return (
    <main className="app-shell loading-screen">
      <header className="app-header"><div><p className="brand-caption">Можно?</p><h1>Финансы</h1></div></header>
      <section className="ob-later-screen glass">
        <Orb />
        <p><strong>Всё сохранено</strong><br />Осталось пару вопросов, и я посчитаю, сколько можно тратить.</p>
        <button type="button" className="button-primary full-width" onClick={() => { setLater(false); setChat({ mode: "initial" }); }}>Продолжить знакомство</button>
      </section>
    </main>
  );
  const editSlot = (slot: string) => { tap(); setChat({ mode: "edit", slot, from: tab }); };
  const profileIncomplete = CHAT_ONBOARDING && !!ob && ob.mode === "initial" && ob.phase !== "done" && !!st.profile;

  return (
    <main className={"app-shell" + (st.profile && !edit ? " has-navigation" : "")} id="main-content">
      <a className="skip-link" href="#workspace">Перейти к содержимому</a>
      <header className="app-header">
        <div>
          <p className="brand-caption sr-only">Можно?</p>
          <h1>Финансы</h1>
        </div>
        <div className="header-actions">
          {st.profile && (
            <button type="button" className="notification-icon invite-icon" aria-label="Пригласить друга" onClick={() => { tap(); setInvite("menu"); }}>
              <GiftIcon />
            </button>
          )}
          <button type="button" className="notification-icon" aria-label="Напоминания" onClick={() => { tap(); setRemOpen(true); }}>
            <Icon name="bell" />
          </button>
          <button type="button" className="avatar" aria-label="Изменить данные профиля" onClick={() => setEdit(true)}>КД</button>
        </div>
      </header>

      <div id="workspace" className="workspace">
        {!st.profile || edit ? ( // при CHAT_ONBOARDING новые пользователи сюда не попадают (чат выше); форма — «Изменить данные»
          <Onboarding initial={st.profile} baseVersion={(st as any).meta?.financeVersion ?? null} onDone={() => { setEdit(false); load(); }} />
        ) : (
          <>
            <section hidden={tab !== "home"} aria-label="Главная">
              <section className="daily-card" aria-labelledby="daily-title" style={{ viewTransitionName: "ob-hero" }}>
                <Wallet />
                <div className="daily-heading">
                  <h2 id="daily-title">Можно тратить в день</h2>
                  <span className="income-badge" title={"Доход " + st.profile.nextIncome.date}>{untilDate(st.profile.nextIncome.date)} <Icon name="chevron" /></span>
                </div>
                <p className="daily-amount"><Money value={s!.safeDaily} /></p>
                <p className="daily-sub">на еду, транспорт и покупки</p>
                <p className="daily-free">На покупки до дохода: <strong>{rub(Math.max(0, s!.freeMoney))}</strong>{s!.freeMoney < 0 && <> · не хватает {rub(-s!.freeMoney)}</>}</p>
                {s!.freeMoneyKnown === false && <p className="daily-note">Из этой суммы нужны и деньги на еду с транспортом</p>}
                <button type="button" className="calc-how-btn" onClick={() => { tap(); setHowOpen(true); }}>Как считаем <Icon name="chevron" /></button>
                <div className="hero-actions">
                  <button type="button" className="button-primary" onClick={() => { tap(); setTab("assistant"); }}>
                    <Icon name="spark" /><span>Можно?</span>
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => { tap(); setSheet(true); }} aria-label="Добавить трату"
                  >
                    <Icon name="plus" /><span>Трата</span>
                  </button>
                </div>
              </section>

              {profileIncomplete && (
                <button type="button" className="soft-note ob-resume-badge" onClick={() => setChat({ mode: "initial" })}><Icon name="spark" />Профиль не завершён — пара вопросов</button>
              )}
              {s!.cashGap && (
                <p className="soft-note note-amber" role="status"><Icon name="clock" />{shortDate(s!.cashGap.date)} может не хватить {rub(s!.cashGap.amount)} на обязательные платежи. Стоит отложить крупные траты.</p>
              )}
              {(s!.limitations || []).filter((l) => LIMITS[l]).slice(0, 1).map((l) => (
                <button key={l} type="button" className="soft-note" onClick={() => setEdit(true)}><Icon name="spark" />{LIMITS[l]}</button>
              ))}
              <div className="small-cards">
                <section className="mini-card glass" aria-labelledby="next-payment-title">
                  <div className="mini-main">
                    <h2 id="next-payment-title">Ближайший платёж</h2>
                    {s!.upcomingPayments.length ? (
                      <>
                        <p className="mini-amount">{rub(s!.upcomingPayments[0].amount)}</p>
                        <p className="mini-description">
                          {capName(s!.upcomingPayments[0].name)}
                          <span aria-hidden="true"> · </span>
                          <time dateTime={s!.upcomingPayments[0].date}>{untilDate(s!.upcomingPayments[0].date)}</time>
                        </p>
                      </>
                    ) : (
                      <p className="mini-empty">Платежей нет</p>
                    )}
                  </div>
                  <Router />
                </section>
                <section className="mini-card glass" aria-labelledby="home-goal-title">
                  <div className="mini-main">
                    <h2 id="home-goal-title">Цель накопления</h2>
                    {st.profile.goal ? (
                      <>
                        <p className="mini-amount">{rub(st.profile.goal.amount)}</p>
                        <p className="mini-description">{capName(st.profile.goal.name)} · +{rub(s!.goalSetAside)}</p>
                      </>
                    ) : (
                      <p className="mini-empty">Цель не задана</p>
                    )}
                  </div>
                  <GoalArt />
                </section>
              </div>

              <section className="history-section" aria-labelledby="home-history-title">
                <div className="section-heading">
                  <h2 id="home-history-title">Покупки и траты</h2>
                  <button type="button" className="text-button" onClick={() => setTab("history")}>
                    Все <Icon name="chevron" />
                  </button>
                </div>
                <p className="section-caption">Последние</p>
                <HistoryList items={feed(st.history, (st as any).entries).slice(0, 4)} onAsk={() => setTab("assistant")} />
              </section>
            </section>

            <section hidden={tab !== "plan"} aria-labelledby="plan-title">
              <div className="page-heading page-heading-soft"><p id="plan-title" className="page-lead">Как распределены деньги до дохода</p></div>
              {(() => {
                // Части полосы точно складываются в «На карте» (lib/engine/legacy.ts planBar): на жизнь = на карте − платежи − резерв − цель.
                const b: PlanBar = s!.planBar ?? { balance: st.profile!.balance, payments: s!.mandatoryBeforeIncome, reserve: st.profile!.reserve, goal: s!.goalSetAside, life: st.profile!.balance - s!.mandatoryBeforeIncome - st.profile!.reserve - s!.goalSetAside };
                const short = b.life < 0;
                const parts = [
                  { k: "pay", label: "Платежи до дохода", v: b.payments },
                  { k: "res", label: "Резерв", v: b.reserve },
                  { k: "goal", label: "На цель", v: b.goal },
                  { k: "life", label: "На жизнь до дохода", v: Math.max(0, b.life) },
                ];
                const scale = (short ? b.payments + b.reserve + b.goal : b.balance) || 1;
                return (
                  <section className="plan-hero glass" aria-label="Распределение">
                    <div className="plan-hero-top">
                      <span>На карте {CHAT_ONBOARDING && <button type="button" className="edit-link" onClick={() => editSlot("balance")}>Изменить</button>}</span>
                      <span className="plan-chip">{untilDate(st.profile!.nextIncome.date)}</span>
                    </div>
                    <p className="plan-balance">{rub(b.balance)}</p>
                    <div className={"plan-bar" + (short ? " is-short" : "")} aria-hidden="true">
                      {parts.map((p) => p.v > 0 && <span key={p.k} className={"pb-" + p.k} style={{ flexGrow: p.v / scale }} />)}
                      {short && <em className="pb-gap" style={{ left: `${Math.max(0, (b.balance / scale) * 100)}%` }} />}
                    </div>
                    <ul className="plan-legend">
                      {parts.map((p) => (
                        <li key={p.k}><i className={"pb-" + p.k} aria-hidden="true" /><span>{p.label}{CHAT_ONBOARDING && p.k === "res" && <> <button type="button" className="edit-link" onClick={() => editSlot("reserve")}>Изменить</button></>}</span><strong>{rub(p.v)}</strong></li>
                      ))}
                    </ul>
                    {short ? <p className="plan-short" role="status">На всё запланированное не хватает {rub(-b.life)}</p>
                      : <p className="plan-sum">Платежи + резерв + цель + на жизнь = {rub(b.balance)}</p>}
                  </section>
                );
              })()}
              <div className="plan-tiles">
                <section className="plan-tile plan-tile-key glass" aria-label="Можно тратить в день">
                  <span className="tile-label">Можно тратить в день</span>
                  <strong>{rub(s!.safeDaily)}</strong>
                  <span className="tile-sub">на всё · до {shortDate(st.profile.nextIncome.date)}</span>
                </section>
                <section className="plan-tile plan-tile-key glass" aria-label="На покупки до дохода">
                  <span className="tile-label">На покупки до дохода</span>
                  <strong>{rub(Math.max(0, s!.freeMoney))}</strong>
                  <span className="tile-sub">{s!.freeMoney < 0 ? `не хватает ${rub(-s!.freeMoney)}` : s!.freeMoneyKnown === false ? "еда и транспорт не указаны" : "разово, сверх еды и транспорта"}</span>
                </section>
                <section className="plan-tile plan-tile-wide glass" aria-label="Следующий доход">
                  <div><span className="tile-label">Следующий доход</span>
                  <strong>{rub(st.profile.nextIncome.amount)}</strong></div>
                  <span className="tile-sub">{untilDate(st.profile.nextIncome.date)}</span>
                  {CHAT_ONBOARDING && <button type="button" className="edit-link" onClick={() => editSlot("income")}>Изменить</button>}
                </section>
              </div>
              <button type="button" className="calc-how-btn on-dark" onClick={() => { tap(); setHowOpen(true); }}>Как считаем <Icon name="chevron" /></button>
              <section className="plan-goal glass" aria-labelledby="plan-goal-title">
                <div>
                  <span className="tile-label" id="plan-goal-title">Цель</span>
                  {st.profile.goal ? (
                    <>
                      <strong className="plan-goal-name">{st.profile.goal.name} · {rub(st.profile.goal.amount)}</strong>
                      <span className="tile-sub">к {shortDate(st.profile.goal.date)} · откладываем {rub(s!.goalSetAside)} до дохода</span>
                    </>
                  ) : (
                    <span className="tile-sub">Цели пока нет. Добавить можно в любой момент.</span>
                  )}
                  {CHAT_ONBOARDING && <button type="button" className="edit-link" onClick={() => editSlot("goal")}>{st.profile.goal ? "Изменить" : "Добавить цель"}</button>}
                </div>
                <GoalArt />
              </section>
              <button type="button" className="button-secondary full-width" onClick={() => setEdit(true)}>
                <Icon name="edit" />Изменить данные
              </button>
              <TelegramLink linked={!!(st as any).account?.telegramLinked} onLinked={load} />
              <InviteCard onOpen={() => setInvite("menu")} />
              <PlusCard plan={plan} onOpen={() => setPlusOpen("menu")} />
              {!tgWebApp()?.initData && (
                <button type="button" className="button-secondary full-width" onClick={async () => { await post("/api/v1/session/logout"); setSt(null); load(); }}>
                  Выйти на этом устройстве
                </button>
              )}
            </section>

            <section hidden={tab !== "assistant"} className="conversation glass" aria-labelledby="chat-title">
              <header className="panel-heading">
                <div><span className="eyebrow muted">Ваш помощник</span><h2 id="chat-title">Обсудим покупку?</h2>
                  <TokenCounter plan={plan} onOpen={() => setPlusOpen("counter")} /></div>
                <Orb />
              </header>
              <div className="messages" ref={logRef} role="log" aria-label="Разговор о покупке" aria-live="polite" aria-relevant="additions" tabIndex={0}>
                {msgs.length === 0 && (
                  <div className="conversation-start">
                    <span className="message-author">Можно?</span>
                    <div className="bubble bot">
                      <p>Расскажите, что хочется купить и сколько это стоит.</p>
                      <p className="muted">Посмотрим, как покупка повлияет на ваш план.</p>
                    </div>

                  </div>
                )}
                {msgs.map((m, i) => (
                  <div key={i} className={"message " + (m.me ? "message-me" : "message-bot")}>
                    <span className="message-author">{m.me ? "Вы" : "Можно?"}</span>
                    {m.me ? <div className="bubble me">{m.text}</div> : m.explain ? <ExplainBubble r={m.explain} onPlus={() => setPlusOpen("exhausted")} /> : <><BotReply text={m.text} impact={m.impact} explainable={shouldShowVerdictActions(m) && !!m.decisionId} highlight={m.smartSuggestion?.line ?? null} />{m.proposal && <ProposalCard initial={m.proposal} onApplied={load} />}
                      {/* Умный сценарий (прогноз движка) — показываем его строкой в карточке, без кнопок; иначе — демо-строка действий. */}
                      {shouldShowVerdictActions(m) && (() => {
                        const canBuy = !!m.decisionId && !m.bought && Number(m.impact.price) > 0;
                        const canWhy = !!m.decisionId && !m.explained;
                        // Поделиться — пока после ответа не было нового вопроса (объяснение и карточка записи не в счёт).
                        const canShare = msgs.slice(i + 1).every((x) => !x.me);
                        if (!canBuy && !canWhy && !canShare) return null;
                        return (
                          <div className="verdict-actions" role="group" aria-label="Действия с ответом">
                            {canBuy && <BoughtButton decisionId={m.decisionId!} onProposal={(r) => setMsgs((ms) => {
                              const c = ms.map((x, j) => (j === i ? { ...x, bought: true } : x));
                              let at = i + 1; while (c[at] && c[at].explain) at++; // после «Почему так?», если оно уже открыто
                              c.splice(at, 0, { me: false, text: r.reply, proposal: r.proposal });
                              return c;
                            })} />}
                            {canWhy && <ExplainButton decisionId={m.decisionId!} fallback={replyDetails(m.text)} onResult={(r) => { setMsgs((ms) => { const c = ms.map((x, j) => (j === i ? { ...x, explained: true } : x)); c.splice(i + 1, 0, { me: false, text: r.reply, explain: r }); return c; }); setPlanTick((x) => x + 1); }} />}
                            {canShare && <AnswerShareMenu onShare={() => setShareRes({ verdict: m.impact.verdict, item: safeItem(m.impact.item) })} onInvite={() => setInvite("answer")} />}
                          </div>
                        );
                      })()}</>}
                  </div>
                ))}
                {busy && (
                  <div className="reply-status" role="status">
                    <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                    <span>Считаем…</span>
                  </div>
                )}
              </div>
              {/* Демо-подсказки — только пока чат пустой; после первого вопроса строки нет. */}
              {!busy && showStarterChips(msgs) && (
                <div className="chips suggest-chips" role="group" aria-label="Подсказки">
                  {SUGGEST.map((q) => (
                    <button key={q} type="button" className="chip" onClick={() => send(chipQuery(q))}>{q}</button>
                  ))}
                </div>
              )}
              <div className="composer-area">
                {listening && <p className="listening-status" role="status"><span className="status-dot" />Микрофон включён</p>}
                <div className="composer">
                  <label className="sr-only" htmlFor="purchase-question">Вопрос о покупке</label>
                  <input
                    ref={inputRef}
                    id="purchase-question"
                    value={input}
                    placeholder="Что хотите купить?"
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && send(input)}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className={"voice-button" + (listening ? " is-listening" : "")}
                      onClick={voice}
                      title="Голосом"
                      aria-label={listening ? "Управление записью голоса" : "Задать вопрос голосом"}
                      aria-pressed={listening}
                    >
                      <Icon name={listening ? "stop" : "mic"} />
                    </button>
                    <button type="button" className="send-button" disabled={busy || !input.trim()} onClick={() => send(input)} aria-label="Спросить">
                      <Icon name="send" />
                    </button>
                  </div>
                </div>

              </div>
            </section>

            <section hidden={tab !== "payments"} aria-labelledby="payments-title">
              <div className="page-heading"><h2 id="payments-title">Платежи</h2><p className="muted">Уже учтены в плане, ничего делать не нужно</p></div>
              <div className="pay-summary glass">
                <div><span className="tile-label">До дохода</span><strong>{rub(s!.mandatoryBeforeIncome)}</strong></div>
                <div><span className="tile-label">Платежей</span><strong>{s!.upcomingPayments.length}</strong></div>
              </div>
              {s!.upcomingPayments.length ? (
                <ul className="payment-list glass">
                  {s!.upcomingPayments.map((p, i) => {
                    const after = p.date >= st.profile!.nextIncome.date;
                    return (
                      <li key={i} className={"payment" + (after ? " is-after" : "")}>
                        <span className="payment-icon" aria-hidden="true">{p.name.trim().charAt(0).toLocaleUpperCase("ru-RU")}</span>
                        <div className="payment-copy"><strong>{capName(p.name)}</strong><time dateTime={p.date}>{after ? "после дохода" : untilDate(p.date)}</time></div>
                        <strong className="payment-amount">{rub(p.amount)}</strong>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="empty-state glass"><Orb /><p><strong>Платежей нет</strong><br />Все свободные деньги в вашем распоряжении.</p></div>
              )}
              <button type="button" className="button-secondary full-width" onClick={() => setEdit(true)}><Icon name="plus" />Добавить или изменить</button>
            </section>

            <section hidden={tab !== "history"} aria-labelledby="history-title">
              <div className="page-heading"><h2 id="history-title">История</h2><p className="muted">Вопросы о покупках и траты</p></div>
              {st.history.length > 0 && (
                <div className="verdict-summary" aria-label="Итоги">
                  {(["yes", "careful", "wait", "no"] as const).map((v) => {
                    const n = st.history.filter((h) => h.verdict === v).length;
                    return n ? <span key={v} className={"vs-chip v-" + v}><Icon name={VERDICT_ICON[v]} />{VERDICT[v]} · {n}</span> : null;
                  })}
                </div>
              )}
              <HistoryList items={feed(st.history, (st as any).entries)} onAsk={() => setTab("assistant")} />
            </section>
          </>
        )}
      </div>

      <footer className="app-footer">
        <details className="technical-details">
          <summary>О приложении</summary>
          <p>Решение остаётся за вами.</p>
        </details>
      </footer>

      {st.profile && !edit && (
        <nav className="bottom-nav" aria-label="Основная навигация">
          <div className="nav-items">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={"nav-item" + (item.id === "assistant" ? " nav-assistant" : "") + (tab === item.id ? " is-active" : "")}
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => { tap(); setTab(item.id); }}
              >
                {item.id === "assistant" ? <Orb /> : <Icon name={item.icon} />}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="home-indicator" aria-hidden="true" />
        </nav>
      )}
      {remOpen && <Sheet title="Напоминания" onClose={() => setRemOpen(false)}><RemindersSettings /></Sheet>}
      {howOpen && st.profile && s && <HowSheet s={s} income={st.profile.nextIncome.date} essential={(st.profile as any).essentialDaily ?? null} onClose={() => setHowOpen(false)} />}
      {invite && <InviteSheet surface={invite} onClose={() => setInvite(null)} />}
      {plusOpen && <PlusSheet plan={plan} surface={plusOpen} onClose={() => setPlusOpen(null)} onChanged={setPlan} />}
      {shareRes && <ShareResultSheet verdict={shareRes.verdict} item={shareRes.item} onClose={() => setShareRes(null)} />}
      {sheet && (
        <Sheet title="Добавить трату" onClose={() => setSheet(false)}>
          <div className="sheet-body">
            <div className="seg" role="tablist" aria-label="Тип">
              <button type="button" role="tab" aria-selected={sMode === "want"} className={sMode === "want" ? "is-on" : ""} onClick={() => { tap(); setSMode("want"); }}>Хочу купить</button>
              <button type="button" role="tab" aria-selected={sMode === "bought"} className={sMode === "bought" ? "is-on" : ""} onClick={() => { tap(); setSMode("bought"); }}>Уже купил</button>
            </div>
            <p className="sheet-hint muted">{sMode === "want" ? "Посчитаем, как покупка повлияет на план." : "Запишем трату после вашего подтверждения."}</p>
            <label className="sr-only" htmlFor="sheet-amount">Сумма</label>
            <input
              id="sheet-amount"
              className="sheet-amount"
              inputMode="decimal"
              placeholder="0 ₽"
              value={sAmt}
              onChange={(e) => setSAmt(e.target.value.replace(/[^\d.,]/g, "").replace(",", "."))}
              aria-label="Сумма"
            />
            <div className="chips" role="group" aria-label="Сумма">
              {[300, 1000, 3000, 8000, 15000].map((n) => (
                <button key={n} type="button" className={"chip" + (sAmt === String(n) ? " is-on" : "")} aria-pressed={sAmt === String(n)} onClick={() => { tap(); setSAmt(String(n)); }}>{rub(n)}</button>
              ))}
            </div>
            <label className="question-label" htmlFor="sheet-item">На что</label>
            <input id="sheet-item" className="sheet-input" placeholder="Например, кроссовки" value={sItem} onChange={(e) => setSItem(e.target.value)} />
            <div className="chips" role="group" aria-label="Категория">
              {CATS.map((c) => (
                <button key={c.label} type="button" className={"chip" + (sItem === c.label ? " is-on" : "")} aria-pressed={sItem === c.label} onClick={() => { tap(); setSItem(c.label); }}>{c.label}</button>
              ))}
            </div>
          </div>
          <div className="sheet-actions">
            <button type="button" className="button-primary full-width" onClick={() => {
              tap(); setSheet(false); setTab("assistant");
              const c = CATS.find((x) => x.label === sItem), free = (sItem.trim() ? sItem.trim().toLowerCase() : "покупку"), za = sAmt ? " за " + sAmt : "";
              if (sMode === "bought") send(c ? (c.bought.includes("{sum}") ? c.bought.replace(sAmt ? "{sum}" : "{sum} ", sAmt) : c.bought + za) : `Купил ${free}${za}`);
              else setInput(`Можно купить ${c ? c.want : free}${za}?`);
            }}>{sMode === "want" ? "Посчитать в чате" : "Записать трату"} <Icon name="chevron" /></button>
          </div>
        </Sheet>
      )}
    </main>
  );
}
