"use client";
// «Пригласить друга» и карточка результата «Мне бот сказал: можно ✅» (без сумм).
// Ссылки и счётчики — GET /api/v1/referrals/me; факт «поделился» — POST /api/v1/referrals/share (только перечисления).
// В Mini App делимся через Telegram (t.me/share/url), в браузере — системным меню (navigator.share) или копированием.
import { useEffect, useState } from "react";

export type ReferralMe = { code: string; links: { bot: string; miniapp: string | null; web: string; telegramShare: string }; invited: number; active: number; rewards: { enabled: boolean; pending: number; days: number; monthlyLimit: number } };
type Method = "copy" | "native" | "telegram" | "image";
type Surface = "answer" | "menu" | "card";

const tg = () => (typeof window !== "undefined" ? (window as unknown as { Telegram?: { WebApp?: { initData?: string; openTelegramLink?: (u: string) => void; HapticFeedback?: { impactOccurred?: (s: string) => void } } } }).Telegram?.WebApp : undefined);
const inMiniApp = () => !!tg()?.initData;
const tap = () => { try { const h = tg()?.HapticFeedback; if (h?.impactOccurred) h.impactOccurred("light"); else navigator.vibrate?.(8); } catch {} };

let cache: Promise<ReferralMe | null> | null = null;
/** Ссылка и счётчики (кэш на время страницы; refresh — перечитать). */
export function loadReferral(refresh = false): Promise<ReferralMe | null> {
  if (!cache || refresh) cache = fetch("/api/v1/referrals/me", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return cache;
}
export function useReferral(enabled = true) {
  const [me, setMe] = useState<ReferralMe | null>(null);
  useEffect(() => { if (enabled) loadReferral().then(setMe); }, [enabled]);
  return me;
}
/** Ссылка для текущего канала: в Mini App — Telegram (Mini App, если настроено), в браузере — сайт. */
export const inviteUrl = (me: ReferralMe) => (inMiniApp() ? me.links.miniapp ?? me.links.bot : me.links.web);

function report(method: Method, surface: Surface) {
  fetch("/api/v1/referrals/share", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, surface, channel: inMiniApp() ? "miniapp" : "web" }) }).catch(() => {});
}
const shareUrl = (url: string, text: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
function openTelegramShare(url: string, text: string) {
  const u = shareUrl(url, text), w = tg();
  if (w?.openTelegramLink) w.openTelegramLink(u); else window.open(u, "_blank", "noopener");
}
/** Системное «Поделиться» (браузер), иначе — Telegram. Возвращает способ, которым поделились, или null при отмене. */
async function shareLink(url: string, text: string, files?: File[]): Promise<Method | null> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (!inMiniApp() && typeof nav.share === "function") {
    const data: ShareData = files && nav.canShare?.({ files }) ? { files, text: `${text} ${url}` } : { title: "Можно?", text, url };
    try { await nav.share(data); return data.files ? "image" : "native"; } catch (e) { if ((e as Error)?.name === "AbortError") return null; }
  }
  openTelegramShare(url, text);
  return "telegram";
}
async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok; } catch { return false; }
  }
}

function Sheet({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head"><h3>{title}</h3><button type="button" className="sheet-close" onClick={onClose} aria-label="Закрыть">×</button></div>
        <div className="sheet-body inv-sheet">{children}</div>
        {actions && <div className="sheet-actions">{actions}</div>}
      </div>
    </div>
  );
}

const GiftIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 11h16v9H4ZM3 7h18v4H3Zm9 0v13M12 7c-1.5-3.5-6-3.5-5.5-.5.3 1.7 3 .5 5.5.5Zm0 0c1.5-3.5 6-3.5 5.5-.5-.3 1.7-3 .5-5.5.5Z" /></svg>
);
export { GiftIcon };
const ShareIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" /></svg>
);

function Counters({ me }: { me: ReferralMe | null }) {
  return (
    <div className="inv-stats" aria-live="polite">
      <div><b>{me ? me.invited : "—"}</b><span>пришли по ссылке</span></div>
      <div><b>{me ? me.active : "—"}</b><span>начали пользоваться</span></div>
      <p className="inv-stats-hint">«Начали пользоваться» — прошли знакомство или получили первый ответ «Можно?».</p>
    </div>
  );
}

const INVITE_TEXT = "Проверяю покупки до зарплаты в «Можно?» — бот считает, хватит ли денег до дохода. Попробуй:";

/** Лист «Пригласить друга»: ссылка, «Отправить», «Скопировать», счётчики. */
export function InviteSheet({ onClose, surface = "menu" }: { onClose: () => void; surface?: Surface }) {
  const [me, setMe] = useState<ReferralMe | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { loadReferral(true).then(setMe); }, []);
  const url = me ? inviteUrl(me) : "";
  return (
    <Sheet title="Пригласить друга" onClose={onClose} actions={
      <div className="inv-actions">
        <button type="button" className="button-primary full-width" disabled={!me} onClick={async () => { tap(); const m = await shareLink(url, INVITE_TEXT); if (m) report(m, surface); }}>
          <GiftIcon />{inMiniApp() ? "Отправить в Telegram" : "Отправить ссылку"}
        </button>
        <button type="button" className="button-secondary full-width" disabled={!me} onClick={async () => { tap(); if (await copy(url)) { setCopied(true); report("copy", surface); setTimeout(() => setCopied(false), 1800); } }}>
          {copied ? "Скопировано ✓" : "Скопировать ссылку"}
        </button>
      </div>
    }>
      <div className="inv-hero">
        <span className="inv-glyph" aria-hidden="true"><GiftIcon /></span>
        <p>Поделитесь «Можно?» с тем, кому тоже важно дотянуть до зарплаты. Друг посчитает свои покупки сам — ваших сумм он не увидит.</p>
      </div>
      <div className="inv-link" aria-label="Ваша ссылка">
        <code>{me ? url.replace(/^https?:\/\//, "") : "Готовим ссылку…"}</code>
        {!inMiniApp() && me && <button type="button" className="chip" onClick={() => { tap(); openTelegramShare(url, INVITE_TEXT); report("telegram", surface); }}>Telegram</button>}
      </div>
      <Counters me={me} />
      <p className="inv-note muted">{me?.rewards.enabled
        ? `За каждого друга, который начал пользоваться, — +${me.rewards.days} дней Плюса (до ${me.rewards.monthlyLimit} в месяц).`
        : "Без бонусов и рейтингов: просто удобно поделиться."}</p>
    </Sheet>
  );
}

/** Компактная карточка в «Плане»: счётчики и кнопка. */
export function InviteCard({ onOpen }: { onOpen: () => void }) {
  const me = useReferral();
  return (
    <section className="tg-card glass inv-card" aria-labelledby="inv-title">
      <div className="tg-head"><span className="tg-glyph inv-glyph-sm" aria-hidden="true"><GiftIcon /></span><div><h3 id="inv-title">Пригласить друга</h3>
        <p className="muted">{me && me.invited ? `Пришли по ссылке: ${me.invited} · начали пользоваться: ${me.active}` : "Ссылка в одно касание, без бонусов и спама."}</p></div></div>
      <button type="button" className="button-secondary full-width" onClick={() => { tap(); onOpen(); }}>Пригласить друга</button>
    </section>
  );
}

// ---------- Карточка результата ----------

const VERDICT_LINE: Record<string, { text: string; emoji: string }> = {
  yes: { text: "можно", emoji: "✅" },
  careful: { text: "можно, но аккуратно", emoji: "👌" },
  wait: { text: "лучше подождать", emoji: "⏳" },
  no: { text: "пока не стоит", emoji: "🙅" },
};
/** Покупка без сумм: цифры, валюта и лишние знаки вырезаются, до 32 символов. */
export function safeItem(item: unknown): string | null {
  if (typeof item !== "string") return null;
  const s = item.replace(/[^\p{L}\s-]/gu, " ").replace(/(^|\s)(руб\p{L}*|р|тыс\p{L}*|k|к|млн)(?=\s|$)/giu, " ").replace(/\s+/g, " ").trim().slice(0, 32).trim();
  if (!s || /^покупк/i.test(s)) return null;
  return s.charAt(0).toLocaleUpperCase("ru-RU") + s.slice(1);
}
export const shareResultText = (verdict: string, item: string | null) =>
  `Спросил у «Можно?», хватит ли денег до зарплаты${item ? ` на «${item.toLocaleLowerCase("ru-RU")}»` : ""}. Мне бот сказал: ${VERDICT_LINE[verdict]?.text ?? "можно"} ${VERDICT_LINE[verdict]?.emoji ?? "✅"} Суммы — только у меня. Попробуй:`;

/** PNG 1080×1350 той же карточки (системные шрифты — кириллица и эмодзи без загрузки шрифтов). */
async function cardImage(verdict: string, item: string | null, url: string): Promise<File | null> {
  try {
    const W = 1080, H = 1350, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    if (!x) return null;
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#0b2a20"); g.addColorStop(0.35, "#1d5a44"); g.addColorStop(0.6, "#0f3527"); g.addColorStop(1, "#245f47");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const rg = x.createRadialGradient(W * 0.9, 0, 0, W * 0.9, 0, W * 0.8);
    rg.addColorStop(0, "rgba(185,243,210,.35)"); rg.addColorStop(1, "rgba(185,243,210,0)");
    x.fillStyle = rg; x.fillRect(0, 0, W, H);
    const round = (rx: number, ry: number, rw: number, rh: number, r: number) => { x.beginPath(); x.roundRect(rx, ry, rw, rh, r); };
    round(80, 210, W - 160, 820, 64); x.fillStyle = "rgba(24,69,51,.78)"; x.fill(); x.strokeStyle = "rgba(224,255,236,.22)"; x.lineWidth = 3; x.stroke();
    const font = (w: number, s: number) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    x.fillStyle = "#b9f3d2"; x.font = font(800, 54); x.fillText("Можно?", 80, 140);
    x.fillStyle = "#c0ddcf"; x.font = font(500, 46); x.fillText("Мне бот сказал:", 150, 340);
    const v = VERDICT_LINE[verdict] ?? VERDICT_LINE.yes;
    x.fillStyle = "#f6fbf6"; x.font = font(850, v.text.length > 12 ? 92 : 128);
    const words = v.text.split(" "); let line = "", y = v.text.length > 12 ? 480 : 500;
    for (const w of words) { const t = line ? `${line} ${w}` : w; if (x.measureText(t).width > W - 300 && line) { x.fillText(line, 150, y); y += 110; line = w; } else line = t; }
    x.fillText(`${line} ${v.emoji}`, 150, y);
    if (item) { x.fillStyle = "#b9f3d2"; x.font = font(600, 50); x.fillText(`Покупка: ${item}`.slice(0, 40), 150, y + 140); }
    x.fillStyle = "rgba(246,251,246,.72)"; x.font = font(500, 38);
    x.fillText("Суммы скрыты · считаем", 150, 930); x.fillText("до следующего дохода", 150, 980);
    x.fillStyle = "#e6f5ee"; round(80, 1110, W - 160, 130, 40); x.fill();
    x.fillStyle = "#204a36"; x.font = font(750, 40); x.fillText(url.replace(/^https?:\/\//, "").slice(0, 44), 130, 1188);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/png"));
    return blob ? new File([blob], "mozhno.png", { type: "image/png" }) : null;
  } catch { return null; }
}

/** Лист «Поделиться результатом»: предпросмотр карточки (суммы скрыты всегда, покупку можно убрать), картинка/ссылка/копия. */
export function ShareResultSheet({ verdict, item, onClose }: { verdict: string; item: string | null; onClose: () => void }) {
  const me = useReferral();
  const [showItem, setShowItem] = useState(!!item);
  const [copied, setCopied] = useState(false);
  const url = me ? inviteUrl(me) : "";
  const it = showItem ? item : null;
  const v = VERDICT_LINE[verdict] ?? VERDICT_LINE.yes;
  return (
    <Sheet title="Поделиться результатом" onClose={onClose} actions={
      <div className="inv-actions">
        <button type="button" className="button-primary full-width" disabled={!me} onClick={async () => {
          tap();
          const file = !inMiniApp() && typeof navigator.share === "function" ? await cardImage(verdict, it, url) : null;
          const m = await shareLink(url, shareResultText(verdict, it), file ? [file] : undefined);
          if (m) report(m, "card");
        }}><GiftIcon />Поделиться</button>
        <button type="button" className="button-secondary full-width" disabled={!me} onClick={async () => { tap(); if (await copy(`${shareResultText(verdict, it)} ${url}`)) { setCopied(true); report("copy", "card"); setTimeout(() => setCopied(false), 1800); } }}>
          {copied ? "Скопировано ✓" : "Скопировать текст"}
        </button>
      </div>
    }>
      <figure className={"share-card sc-" + (VERDICT_LINE[verdict] ? verdict : "yes")} aria-label="Предпросмотр карточки">
        <span className="sc-brand">Можно?</span>
        <span className="sc-lead">Мне бот сказал:</span>
        <strong className="sc-verdict">{v.text} <span aria-hidden="true">{v.emoji}</span></strong>
        {it && <span className="sc-item">Покупка: {it}</span>}
        <span className="sc-foot">Суммы скрыты · считаем до следующего дохода</span>
        <span className="sc-link">{me ? url.replace(/^https?:\/\//, "") : "…"}</span>
      </figure>
      {!inMiniApp() && me && (
        <button type="button" className="text-button sc-save" onClick={async () => {
          tap(); const f = await cardImage(verdict, it, url); if (!f) return;
          const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); report("image", "card");
        }}>Сохранить картинку</button>
      )}
      {item && (
        <label className="sc-toggle"><input type="checkbox" checked={showItem} onChange={(e) => { tap(); setShowItem(e.target.checked); }} /> Показывать, что за покупка</label>
      )}
      <p className="inv-note muted">Суммы, остаток и план в карточку не попадают. В ней ваша ссылка-приглашение.</p>
    </Sheet>
  );
}

/** Строка под ответом «Можно?»: поделиться результатом и пригласить друга. Ненавязчиво: две маленькие кнопки. */
/** Компактная кнопка «поделиться» под ответом «Можно?»: круглая иконка → маленькое меню (Поделиться ответом / Пригласить друга). */
export function AnswerShareMenu({ onShare, onInvite }: { onShare: () => void; onInvite: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.(".va-share")) setOpen(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const pick = (f: () => void) => { tap(); setOpen(false); f(); };
  return (
    <div className="va-share">
      <button type="button" className={"va-icon" + (open ? " is-open" : "")} aria-label="Поделиться" aria-haspopup="menu" aria-expanded={open} onClick={() => { tap(); setOpen((o) => !o); }}><ShareIcon /></button>
      {open && (
        <div className="va-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick(onShare)}><ShareIcon />Поделиться ответом</button>
          <button type="button" role="menuitem" onClick={() => pick(onInvite)}><GiftIcon />Пригласить друга</button>
        </div>
      )}
    </div>
  );
}

export function AnswerShareRow({ onShare, onInvite }: { onShare: () => void; onInvite: () => void }) {
  return (
    <div className="answer-share" role="group" aria-label="Поделиться">
      <button type="button" className="chip chip-share" onClick={() => { tap(); onShare(); }} aria-label="Поделиться результатом"><ShareIcon />Поделиться</button>
      <button type="button" className="chip chip-share" onClick={() => { tap(); onInvite(); }}><GiftIcon />Пригласить друга</button>
    </div>
  );
}
