// Серверная шторка drill-down этапа воронки. Без JS — обычный раздел (#drill); с JS DrillModal делает её модальной.
import Link from "next/link";
import type { CSSProperties } from "react";
import { DWELL_BUCKETS, GONE_AFTER_DAYS, type Drill } from "../../../lib/analytics-drill";
import { ATTEMPT_HORIZON_DAYS, MIN_COHORT } from "../../../lib/analytics-metrics";
import { CHANNEL_LABEL, int, mins, pct } from "../../../lib/analytics-insights";
import { COLOR, Donut, Histogram, NB } from "./charts";
import { DrillModal } from "./drill-modal";
import { deltaText } from "./live-format";

/** Малые ячейки не раскрываем точным числом (как и когорты < MIN_COHORT). */
const cnt = (n: number) => (n > 0 && n < MIN_COHORT ? `<${MIN_COHORT}` : int(n));

function Mix({ rows, total }: { rows: { label: string; n: number; color: string; hint?: string }[]; total: number }) {
  return (
    <ul className="ia-mix">
      {rows.map((r, i) => (
        <li key={r.label} style={{ "--c": r.color, "--i": i } as CSSProperties}>
          <span className="l"><i aria-hidden="true" />{r.label}{r.hint && <small>{r.hint}</small>}</span>
          <span className="b" aria-hidden="true"><i style={{ width: `${total ? ((r.n > 0 && r.n < MIN_COHORT ? MIN_COHORT / 2 : r.n) / total) * 100 : 0}%` }} /></span>
          <span className="v"><b>{!total ? "—" : r.n === 0 ? pct(0) : r.n >= MIN_COHORT ? pct(r.n / total) : "—"}</b><small>{cnt(r.n)}</small></span>
        </li>
      ))}
    </ul>
  );
}

export function DrillSheet({ d, closeHref, cmp, idx, range }: { d: Drill; closeHref: string; cmp: boolean; idx: number; range: string }) {
  const id = "drill-title";
  const early = d.prev.matureBase === 0;
  const dt = cmp ? (early ? { text: "рано сравнивать", tone: "na" as const } : deltaText(d.prev.matureRate, d.prev.rate, "pct", d.prev.sig)) : null;
  const typed = d.failedInput.text + d.failedInput.voice, chip = d.failedInput.choice;
  return (
    <DrillModal closeHref={closeHref} stepKey={d.key} labelledBy={id}>
      <Link className="ia-backdrop" href={closeHref} replace scroll={false} aria-hidden="true" tabIndex={-1} />
      <section id="drill" className="ia-sheet" tabIndex={-1} aria-labelledby={id}>
        <span className="grab" aria-hidden="true" />
        <header className="ia-sh-head">
          <div>
            <span className="kicker">Шаг {String(idx + 1).padStart(2, "0")} · после «{d.prevLabel}»</span>
            <h2 id={id}>Почему уходят на шаге «{d.label}»</h2>
          </div>
          <Link className="ia-x" href={closeHref} replace scroll={false} aria-label="Закрыть разбор шага">×</Link>
        </header>

        <div className="ia-sh-hero">
          <b className="big">{d.rate == null ? "—" : d.rate === 0 ? "0 %" : d.rate < 0.005 ? "<1 %" : `−${pct(d.rate)}`}</b>
          <span>ушли на этом шаге<br /><small>{int(d.dropped)} из {int(d.base)} дошедших до «{d.prevLabel}»</small></span>
          {dt && <em className={`chip t-${dt.tone}`}>{dt.text}<small>{early ? `все проходы моложе ${ATTEMPT_HORIZON_DAYS}${NB}дн. — ответ ещё может прийти` : <>{d.prev.matureBase < d.base ? `проходы старше ${ATTEMPT_HORIZON_DAYS}${NB}дн.: ${pct(d.prev.matureRate)} · ` : ""}было {pct(d.prev.rate)} · {range}</>}</small></em>}
        </div>

        <p className={`ia-sh-take t-${d.takeaway.tone}`}><b>Вывод</b>{d.takeaway.text}</p>

        <div className="ia-sh-grid">
          <article className="ia-sh-card">
            <h3>Где теряем: по каналам</h3>
            <ul className="ia-chs">
              {d.channels.map((c) => {
                const cdt = cmp && !early ? deltaText(c.matureRate, c.prevRate, "pct", c.sig) : null;
                return (
                  <li key={c.channel} className={c.small ? "small" : undefined} style={{ "--c": COLOR[c.channel as keyof typeof COLOR] } as CSSProperties}>
                    <span className="l"><i aria-hidden="true" />{CHANNEL_LABEL[c.channel]}<small>ушли {cnt(c.dropped)} из {cnt(c.base)}</small></span>
                    <span className="b" aria-hidden="true"><i style={{ width: `${c.base ? ((c.dropped > 0 && c.dropped < MIN_COHORT ? MIN_COHORT / 2 : c.dropped) / c.base) * 100 : 0}%` }} /></span>
                    <span className="v"><b>{c.base >= MIN_COHORT && (c.dropped === 0 || c.dropped >= MIN_COHORT) ? pct(c.rate) : "—"}</b>{cdt && c.base >= MIN_COHORT && <small className={`t-${cdt.tone}`}>{cdt.text}</small>}</span>
                  </li>
                );
              })}
            </ul>
            <p className="ia-sh-note">Доля ушедших среди дошедших до шага в каждом канале. Канал — по началу знакомства. Бледные — меньше 30 человек.</p>
          </article>

          <article className="ia-sh-card">
            <h3>Что видно в событиях ушедших</h3>
            <div className="ia-sh-donut">
              <Donut small={MIN_COHORT} size={132} center={pct(d.dropped ? d.did.nothing / d.dropped : null)} sub="без событий" parts={[
                { key: "nothing", value: d.did.nothing, color: "#9fb5ab", label: "событий нет" },
                { key: "nu", value: d.did.notUnderstood, color: COLOR.amber, label: "бот ответил «не понял»" },
                { key: "back", value: d.did.wentBack, color: COLOR.sky, label: "вернулись к прошлым вопросам" },
                { key: "other", value: d.did.other, color: "#6f8a80", label: "другие события" },
                { key: "ns", value: d.did.notShown, color: "#b8a8ff", label: "показ шага не записан" },
              ]} />
              <Mix total={d.dropped} rows={[
                { label: d.isStep ? "После показа событий нет" : `После «${d.prevLabel}» событий нет`, n: d.did.nothing, color: "#9fb5ab", hint: "могли читать, отвлечься или закрыть" },
                { label: "Бот ответил «не понял»", n: d.did.notUnderstood, color: COLOR.amber, hint: typed + chip > 0 ? `своими словами ${cnt(typed)} · кнопкой ${cnt(chip)}${d.failedInput.unknown ? ` · не записано ${cnt(d.failedInput.unknown)}` : ""}` : undefined },
                { label: "Вернулись к прошлым вопросам", n: d.did.wentBack, color: COLOR.sky, hint: "исправляли или открывали прошлый шаг" },
                ...(d.did.other ? [{ label: "Другие события", n: d.did.other, color: "#6f8a80" }] : []),
                ...(d.isStep && d.did.notShown ? [{ label: "Показ шага не записан", n: d.did.notShown, color: "#b8a8ff" }] : []),
              ]} />
            </div>
          </article>

          <article className="ia-sh-card">
            <h3>От показа до последнего события</h3>
            <Histogram labels={DWELL_BUCKETS.map((b) => (b === "событий после показа нет" ? "нет событий" : b))} values={d.dwell.buckets} small={MIN_COHORT} highlight={0} color={COLOR.aqua} warnLabel="длительность неизвестна" />
            <p className="ia-sh-note">Медиана у ушедших с событиями — <b>{mins(d.dwell.median)}</b>{d.passDwell.n > 0 && <>; прошедшие отвечали за <b>{mins(d.passDwell.median)}</b></>}. Это не время до ухода: события «закрыл» нет, точность — минута.</p>
          </article>

          <article className="ia-sh-card">
            <h3>Что было потом</h3>
            <Mix total={d.dropped} rows={[
              ...(d.after.resumed ? [{ label: "Продолжили тот же проход позже", n: d.after.resumed, color: COLOR.emerald, hint: `после ${ATTEMPT_HORIZON_DAYS}${NB}дн. — в воронку не попадает` }] : []),
              { label: "Начали знакомство заново", n: d.after.restarted, color: COLOR.mint },
              { label: "Заходили позже, знакомство не продолжили", n: d.after.cameBack, color: COLOR.sky, hint: "сами: открывали, писали, нажимали" },
              { label: "Событий позже нет", n: d.after.gone, color: "#9fb5ab", hint: `прошло ≥${NB}${GONE_AFTER_DAYS}${NB}дн.` },
              { label: "Рано судить", n: d.after.recent, color: "#5e7a70", hint: `ушли меньше ${GONE_AFTER_DAYS}${NB}дн. назад` },
            ]} />
          </article>

          {d.passMix && d.passed > 0 && (
            <article className="ia-sh-card">
              <h3>Как прошли шаг остальные</h3>
              <Mix total={d.passed} rows={[
                { label: "Ответили", n: d.passMix.answered, color: COLOR.emerald },
                { label: "«Не знаю»", n: d.passMix.unknown, color: "#b8a8ff" },
                { label: "Пропустили", n: d.passMix.skipped, color: COLOR.amber },
              ]} />
              <p className="ia-sh-note">Ввод: своими словами {cnt(d.passMix.text)}, кнопкой {cnt(d.passMix.choice)}{d.passMix.voice ? `, голосом ${cnt(d.passMix.voice)}` : ""}.</p>
            </article>
          )}
        </div>

        <details className="ia-sh-untracked">
          <summary>Чего мы не знаем</summary>
          <ul>{d.untracked.map((u) => <li key={u}>{u}</li>)}</ul>
        </details>
        <p className="ia-sh-foot"><Link href={closeHref} replace scroll={false}>← Вернуться к воронке</Link></p>
      </section>
    </DrillModal>
  );
}
