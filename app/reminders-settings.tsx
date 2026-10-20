"use client";
// Настройки мягких напоминаний: стеклянные переключатели, время и тихие часы. Сохраняется сразу.
import { useEffect, useRef, useState } from "react";

type Kind = { id: string; label: string };
type Settings = { enabled: boolean; kinds: Record<string, boolean>; sendHour: number; quietStart: number; quietEnd: number; nudgeEveryDays: number; blockedAt: string | null; timezone: string };
type View = { settings: Settings; telegramLinked: boolean; kinds: Kind[] };

const HINT: Record<string, string> = {
  payment_due: "Накануне, одним сообщением",
  payday: "В день дохода: «деньги поступили?»",
  onboarding: "Один раз, если настройка не закончена",
  log_nudge: "Если неделю не было записей",
  weekly: "По воскресеньям: две строки о неделе",
  morning: "Каждое утро: сколько можно сегодня",
};
const hours = Array.from({ length: 24 }, (_, h) => h);

export default function RemindersSettings() {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/v1/reminders", { credentials: "include" })
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); setV(await r.json()); })
      .catch(() => setErr("Не удалось загрузить настройки"));
  }, []);
  // Сохранения идут по очереди (без гонок PUT); сервер обновляет только переданные поля.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const save = (patch: Record<string, unknown>) => {
    setV((cur) => cur && { ...cur, settings: { ...cur.settings, ...patch, kinds: { ...cur.settings.kinds, ...((patch.kinds as object) ?? {}) } } as Settings });
    queue.current = queue.current.then(async () => {
      const r = await fetch("/api/v1/reminders", { method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
      if (r?.ok) { setV(await r.json()); setErr(null); }
      else {
        setErr("Не сохранилось, попробуйте ещё раз");
        const g = await fetch("/api/v1/reminders", { credentials: "include" }).catch(() => null);
        if (g?.ok) setV(await g.json());
      }
    });
  };
  if (!v) return <div className="sheet-body"><p className="muted">{err ?? "Загружаем…"}</p></div>;
  const s = v.settings;
  const off = !s.enabled || !!s.blockedAt;
  return (
    <div className="sheet-body rem">
      <p className="sheet-hint muted">Редко и по делу: не больше одного сообщения в день. Приходят в Telegram.</p>
      {!v.telegramLinked && <p className="soft-note">Telegram пока не подключён — напоминания начнут приходить после «Связать с Telegram».</p>}
      <label className="rem-row rem-master">
        <span><b>Напоминания</b><small>{s.blockedAt ? "Приостановлены: бот был заблокирован" : off ? "Выключены" : "Включены"}</small></span>
        <input type="checkbox" role="switch" className="rem-switch" checked={!off} onChange={(e) => save({ enabled: e.target.checked })} />
      </label>
      <div className={"rem-list" + (off ? " is-off" : "")} role="group" aria-label="Какие напоминания">
        {v.kinds.map((k) => (
          <label key={k.id} className="rem-row">
            <span><b>{k.label}</b><small>{HINT[k.id]}</small></span>
            <input type="checkbox" role="switch" className="rem-switch" disabled={off} checked={!!s.kinds[k.id]} onChange={(e) => save({ kinds: { [k.id]: e.target.checked } })} />
          </label>
        ))}
      </div>
      <div className={"rem-times" + (off ? " is-off" : "")}>
        <label className="rem-time"><span>Присылать после</span>
          <select disabled={off} value={s.sendHour} onChange={(e) => save({ sendHour: Number(e.target.value) })}>{hours.map((h) => <option key={h} value={h}>{h}:00</option>)}</select>
        </label>
        <label className="rem-time"><span>Тихие часы с</span>
          <select disabled={off} value={s.quietStart} onChange={(e) => save({ quietStart: Number(e.target.value) })}>{hours.map((h) => <option key={h} value={h}>{h}:00</option>)}</select>
        </label>
        <label className="rem-time"><span>до</span>
          <select disabled={off} value={s.quietEnd} onChange={(e) => save({ quietEnd: Number(e.target.value) })}>{hours.map((h) => <option key={h} value={h}>{h}:00</option>)}</select>
        </label>
      </div>
      <p className="rem-foot muted">Часовой пояс: {s.timezone === "Europe/Moscow" ? "Москва" : s.timezone}. В Telegram то же самое — команда /reminders.</p>
      {err && <p className="ob-error" role="alert">{err}</p>}
      <StatsConsent />
    </div>
  );
}

/** Отказ от анонимной статистики: без текстов, сумм и имён; при выключении накопленное удаляется. */
function StatsConsent() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/v1/analytics/consent", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((j) => setOn(j ? !!j.enabled : null)).catch(() => {});
  }, []);
  if (on == null) return null;
  const set = async (v: boolean) => {
    setOn(v);
    const r = await fetch("/api/v1/analytics/consent", { method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: v }) }).catch(() => null);
    if (!r?.ok) setOn(!v);
  };
  return (
    <label className="rem-row rem-privacy">
      <span><b>Анонимная статистика</b><small>{on ? "Только факты действий, без текстов и сумм. Помогает улучшать приложение" : "Выключена — ничего не записываем"}</small></span>
      <input type="checkbox" role="switch" className="rem-switch" checked={on} onChange={(e) => set(e.target.checked)} />
    </label>
  );
}
