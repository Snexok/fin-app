// Мягкие напоминания из Telegram-бота («удобно и не напряжно»): мало сообщений, спокойный тон, без упрёков.
// Числа — только из детерминированного движка (getForecast). Выбор — чистая функция selectReminders (тесты).
import { InlineKeyboard } from "grammy";
import { addDays, diffDays, formatRub, isValidTimeZone, localDate, DEFAULT_TZ, type Forecast, type ISODate, type Minor } from "./engine";
import { getDb } from "./db";
import { getForecast } from "./finance-service";
import { humanDate } from "./coach";
import { loadSession } from "./onboarding/session";
import { track } from "./analytics";
import { logServiceError, recordCall } from "./service-log";

export const REMINDER_KINDS = ["payment_due", "payday", "onboarding", "log_nudge", "weekly", "morning"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
export const KIND_LABEL: Record<ReminderKind, string> = {
  payment_due: "Платёж завтра", payday: "День дохода", onboarding: "Продолжить знакомство",
  log_nudge: "Записать траты", weekly: "План недели", morning: "Утро: сколько можно сегодня",
};
/** Консервативные умолчания: только события (платёж, доход, незавершённое знакомство); подсказки — по желанию. */
export const DEFAULT_KINDS: Record<ReminderKind, boolean> = { payment_due: true, payday: true, onboarding: true, log_nudge: false, weekly: false, morning: false };
/** Не больше одного сообщения в день — включая платёж (ревью Codex: в день платежа остальное молчит). */
export const DAILY_CAP = 1;
/** Порядок, если в один день подходят несколько. */
const PRIORITY: ReminderKind[] = ["payment_due", "payday", "onboarding", "weekly", "log_nudge", "morning"];
/** Подсказки без события (неделя, траты, утро) — не больше двух за 7 дней. */
const SOFT: ReminderKind[] = ["weekly", "log_nudge", "morning"];
export const SOFT_PER_WEEK = 2;
/** Ежедневный раннер (Vercel Hobby): sendHour не ждём — запуск один, иначе пользователи с поздним часом не получат ничего. */
export type RunnerMode = "daily" | "hourly";
export const WEEKLY_DAY = 0; // воскресенье (локально)

export interface ReminderSettings {
  enabled: boolean;
  kinds: Record<ReminderKind, boolean>;
  sendHour: number; quietStart: number; quietEnd: number;
  nudgeEveryDays: number;
  blockedAt: string | null;
  timezone: string;
}
export const DEFAULT_SETTINGS: Omit<ReminderSettings, "timezone"> = { enabled: true, kinds: { ...DEFAULT_KINDS }, sendHour: 10, quietStart: 22, quietEnd: 9, nudgeEveryDays: 7, blockedAt: null };

export interface LogRow { kind: ReminderKind; ref: string; day: ISODate; status: string }
export interface SelectInput {
  today: ISODate; hour: number; weekday: number;
  settings: ReminderSettings;
  forecast: Forecast | null;
  onboarding: { phase: string; updatedAt: string; startedAt: string } | null;
  lastExpenseDay: ISODate | null;
  hasEntries: boolean;
  log: LogRow[]; // журнал за ~40 дней + все записи «знакомства» (однократное)
  mode?: RunnerMode;
}
export interface Reminder { kind: ReminderKind; ref: string; text: string; buttons: { text: string; data: string }[][] }

/** Тихие часы [start, end) по местному времени, с переходом через полночь. */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const rub = (m: Minor) => formatRub(m);
const sentLike = (r: LogRow) => r.status === "sent" || r.status === "claimed";

/** Можно ли писать сейчас: не в тихие часы; при почасовом раннере — не раньше sendHour. */
export function sendWindowOpen(hour: number, s: Pick<ReminderSettings, "sendHour" | "quietStart" | "quietEnd">, mode: RunnerMode = "hourly"): boolean {
  if (inQuietHours(hour, s.quietStart, s.quietEnd)) return false;
  return mode === "daily" || hour >= s.sendHour;
}

/** Какое напоминание отправить сейчас (не больше одного в день). Пусто — молчим. */
export function selectReminders(x: SelectInput): Reminder[] {
  const s = x.settings;
  if (!s.enabled || s.blockedAt) return [];
  if (!sendWindowOpen(x.hour, s, x.mode)) return [];
  if (x.log.some((r) => r.day === x.today && sentLike(r))) return []; // сегодня уже писали
  const was = (kind: ReminderKind, ref?: string) => x.log.some((r) => r.kind === kind && (ref === undefined || r.ref === ref) && sentLike(r));
  const weekAgo = addDays(x.today, -6);
  const softThisWeek = x.log.filter((r) => SOFT.includes(r.kind) && r.day >= weekAgo && sentLike(r)).length;
  for (const kind of PRIORITY) {
    if (!s.kinds[kind]) continue;
    if (SOFT.includes(kind) && softThisWeek >= SOFT_PER_WEEK) continue;
    const r = candidate(kind, x, was);
    if (r) return [r];
  }
  return [];
}

function candidate(kind: ReminderKind, x: SelectInput, was: (k: ReminderKind, ref?: string) => boolean): Reminder | null {
  const f = x.forecast;
  switch (kind) {
    case "payment_due": {
      if (!f) return null;
      const tomorrow = addDays(x.today, 1);
      const due = f.payments.filter((p) => p.dueOn === tomorrow && !p.overdue && p.amountMinor > 0n);
      if (!due.length || was("payment_due", tomorrow)) return null;
      const total = due.reduce((a, p) => a + p.amountMinor, 0n);
      // Без обещаний «в день не изменится»: платёж может быть за горизонтом текущего расчёта (ревью Codex).
      const text = due.length === 1
        ? `Завтра по плану «${due[0].name}» — ${rub(due[0].amountMinor)}. Если уже оплатили, можно отметить.`
        : `Завтра по плану платежи: ${due.map((p) => `«${p.name}» ${rub(p.amountMinor)}`).join(", ")} — всего ${rub(total)}.`;
      return {
        kind, ref: tomorrow, text,
        buttons: [[...(due.length === 1 ? [{ text: "Отметить оплату", data: `rm:paid:${due[0].id}` }] : [])], [{ text: "Не напоминать о платежах", data: "rm:off:payment_due" }]].filter((r) => r.length),
      };
    }
    case "payday": {
      if (!f) return null;
      // День дохода или до 2 дней после, пока доход не отмечен. Один раз на каждый доход.
      const inc = f.nextIncome && f.nextIncome.dueOn === x.today ? f.nextIncome
        : f.overdueIncomes.find((i) => diffDays(i.dueOn, x.today) >= 0 && diffDays(i.dueOn, x.today) <= 2) ?? null;
      if (!inc || was("payday", inc.id)) return null;
      const when = inc.dueOn === x.today ? "На сегодня запланирован" : `На ${humanDate(inc.dueOn)} был запланирован`;
      return {
        kind, ref: inc.id,
        text: `${when} доход «${inc.name}» — ${rub(inc.amountMinor)}. Деньги поступили?`,
        buttons: [[{ text: "Отметить поступление", data: `rm:inc:${inc.id}` }, { text: "Пока нет", data: "rm:later:payday" }], [{ text: "Не напоминать о доходе", data: "rm:off:payday" }]],
      };
    }
    case "onboarding": {
      const o = x.onboarding;
      if (f || !o || o.phase === "done" || o.phase === "paused") return null;
      const idle = diffDays(o.updatedAt.slice(0, 10), x.today);
      if (idle < 1 || idle > 14 || was("onboarding")) return null; // один раз за всё время
      return {
        kind, ref: "once",
        text: "Можно продолжить настройку плана с того места, где остановились, — когда будет удобно.",
        buttons: [[{ text: "Продолжить", data: "rm:ob" }, { text: "Не напоминать", data: "rm:off:onboarding" }]],
      };
    }
    case "weekly": {
      if (!f || x.weekday !== WEEKLY_DAY || was("weekly", x.today)) return null;
      const end = addDays(x.today, 7);
      const week = f.payments.filter((p) => !p.overdue && p.dueOn > x.today && p.dueOn <= end);
      const pay = week.length ? `На неделе платежи: ${week.length} на ${rub(week.reduce((a, p) => a + p.amountMinor, 0n))} — уже в плане.` : "Обязательных платежей на неделе нет.";
      return {
        kind, ref: x.today,
        text: `План на неделю: около ${rub(f.safeDailyMinor)} в день${f.nextIncome ? ` до ${humanDate(f.nextIncome.dueOn)}` : ""}.\n${pay}`,
        buttons: [[{ text: "Не присылать план недели", data: "rm:off:weekly" }]],
      };
    }
    case "log_nudge": {
      if (!f || !x.hasEntries) return null; // только тем, кто уже записывал траты сам
      const every = x.settings.nudgeEveryDays;
      const silent = x.lastExpenseDay ? diffDays(x.lastExpenseDay, x.today) : Infinity;
      const lastNudge = x.log.filter((r) => r.kind === "log_nudge" && r.status === "sent").map((r) => r.day).sort().pop();
      if (silent < every || (lastNudge && diffDays(lastNudge, x.today) < every)) return null;
      return {
        kind, ref: x.today,
        text: "Если хотите обновить план, напишите траты одной строкой, например «продукты 1200».",
        buttons: [[{ text: "Записать трату", data: "rm:log" }], [{ text: "Реже", data: "rm:less:log_nudge" }, { text: "Не напоминать", data: "rm:off:log_nudge" }]],
      };
    }
    case "morning": {
      if (!f || was("morning", x.today)) return null;
      return { kind, ref: x.today, text: `Доброе утро! Сегодня можно около ${rub(f.safeDailyMinor)} — на всё.`, buttons: [[{ text: "Не присылать утром", data: "rm:off:morning" }]] };
    }
    default: return null;
  }
}

export const keyboardOf = (r: Reminder) => { const k = new InlineKeyboard(); r.buttons.forEach((row, i) => { row.forEach((b) => k.text(b.text, b.data)); if (i < r.buttons.length - 1) k.row(); }); return k; };

// ---------- Хранение ----------

type Q = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

export async function getSettings(userId: string, q?: Q): Promise<ReminderSettings> {
  const db = (q ?? (await getDb())) as Q;
  const r = await db.query<Record<string, unknown>>(
    "SELECT u.timezone, s.* FROM users u LEFT JOIN reminder_settings s ON s.user_id=u.id WHERE u.id=$1", [userId]);
  const row = r.rows[0] ?? {};
  const tz = typeof row.timezone === "string" && isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TZ;
  if (row.user_id == null) return { ...DEFAULT_SETTINGS, kinds: { ...DEFAULT_KINDS }, timezone: tz };
  const kinds = { ...DEFAULT_KINDS, ...(row.kinds as Partial<Record<ReminderKind, boolean>>) };
  return {
    enabled: !!row.enabled, kinds, sendHour: Number(row.send_hour), quietStart: Number(row.quiet_start), quietEnd: Number(row.quiet_end),
    nudgeEveryDays: Number(row.nudge_every_days), blockedAt: row.blocked_at ? new Date(row.blocked_at as string).toISOString() : null, timezone: tz,
  };
}

export interface SettingsPatch { enabled?: boolean; kinds?: Partial<Record<ReminderKind, boolean>>; sendHour?: number; quietStart?: number; quietEnd?: number; nudgeEveryDays?: number; blocked?: boolean }

export function validatePatch(body: Record<string, unknown>): SettingsPatch {
  const p: SettingsPatch = {};
  const hour = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23 ? (v as number) : undefined);
  if (typeof body.enabled === "boolean") p.enabled = body.enabled;
  if (body.kinds && typeof body.kinds === "object") {
    p.kinds = {};
    for (const k of REMINDER_KINDS) { const v = (body.kinds as Record<string, unknown>)[k]; if (typeof v === "boolean") p.kinds[k] = v; }
  }
  for (const key of ["sendHour", "quietStart", "quietEnd"] as const) { const h = hour(body[key]); if (h !== undefined) p[key] = h; }
  if (Number.isInteger(body.nudgeEveryDays) && (body.nudgeEveryDays as number) >= 2 && (body.nudgeEveryDays as number) <= 30) p.nudgeEveryDays = body.nudgeEveryDays as number;
  return p;
}

/** Атомарно обновляет только переданные поля (kinds сливается в jsonb) — параллельные PUT не затирают друг друга. */
export async function updateSettings(userId: string, patch: SettingsPatch, channel: "web" | "telegram" | "system" = "telegram"): Promise<ReminderSettings> {
  const db = await getDb();
  const before = await getSettings(userId);
  const d = DEFAULT_SETTINGS;
  const blocked = patch.blocked === true ? new Date().toISOString() : null;
  await db.query(
    `INSERT INTO reminder_settings(user_id, enabled, kinds, send_hour, quiet_start, quiet_end, nudge_every_days, blocked_at, updated_at)
     VALUES ($1::uuid, COALESCE($2::boolean, $9::boolean), $10::jsonb || COALESCE($3::jsonb, '{}'::jsonb), COALESCE($4::smallint, $11::smallint), COALESCE($5::smallint, $12::smallint),
             COALESCE($6::smallint, $13::smallint), COALESCE($7::smallint, $14::smallint), $8::timestamptz, now())
     ON CONFLICT (user_id) DO UPDATE SET
       enabled = COALESCE($2::boolean, reminder_settings.enabled),
       kinds = reminder_settings.kinds || COALESCE($3::jsonb, '{}'::jsonb),
       send_hour = COALESCE($4::smallint, reminder_settings.send_hour),
       quiet_start = COALESCE($5::smallint, reminder_settings.quiet_start),
       quiet_end = COALESCE($6::smallint, reminder_settings.quiet_end),
       nudge_every_days = COALESCE($7::smallint, reminder_settings.nudge_every_days),
       blocked_at = CASE WHEN $15::boolean IS NULL THEN reminder_settings.blocked_at ELSE $8::timestamptz END,
       updated_at = now()`,
    [userId, patch.enabled ?? null, patch.kinds ? JSON.stringify(patch.kinds) : null, patch.sendHour ?? null, patch.quietStart ?? null, patch.quietEnd ?? null,
      patch.nudgeEveryDays ?? null, blocked, d.enabled, JSON.stringify(DEFAULT_KINDS), d.sendHour, d.quietStart, d.quietEnd, d.nudgeEveryDays, patch.blocked ?? null]);
  const after = await getSettings(userId);
  // Аналитика: только переходы «включено → выключено».
  if (patch.blocked === true && !before.blockedAt) await track(userId, "reminder_disabled", { scope: "all", reason: "bot_blocked" }, { channel: "system" });
  if (before.enabled && !after.enabled) await track(userId, "reminder_disabled", { scope: "all", reason: "user" }, { channel });
  for (const k of REMINDER_KINDS) if (before.kinds[k] && !after.kinds[k]) await track(userId, "reminder_disabled", { scope: "kind", kind: k, reason: "user" }, { channel });
  return after;
}

/** Удвоить интервал подсказки «записать траты» атомарно (кнопка «Реже»). */
export async function slowerNudge(userId: string): Promise<ReminderSettings> {
  await updateSettings(userId, {});
  await (await getDb()).query("UPDATE reminder_settings SET nudge_every_days = LEAST(30, nudge_every_days * 2), updated_at=now() WHERE user_id=$1", [userId]);
  return getSettings(userId);
}

/** Пользователь снова написал боту — снимаем отметку «бот заблокирован» (дёшево: только если она есть). */
export async function clearBlocked(userId: string) {
  await (await getDb()).query("UPDATE reminder_settings SET blocked_at=NULL WHERE user_id=$1 AND blocked_at IS NOT NULL", [userId]);
}

// ---------- Планировщик ----------

export interface Sender { send(chatId: string, text: string, keyboard: InlineKeyboard): Promise<void> }
export interface RunStats { users: number; sent: number; skipped: number; blocked: number; failed: number }

function localClock(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "Sun");
  return { today: localDate(now, tz), hour, weekday: wd };
}

const codeOf = (e: unknown) => (e as { error_code?: number })?.error_code;

/**
 * Один проход по Telegram-пользователям. Подходит и для ежедневного cron (Vercel Hobby, mode "daily"), и для почасового ("hourly").
 * Гарантии: не больше одного сообщения в день на пользователя — атомарный захват дневного слота (kind '_day');
 * дедуп по событию — PK (user, kind, ref, day). При сомнении в доставке лучше пропустить, чем прислать дубль.
 */
export async function runReminders(sender: Sender, now = new Date(), opts: { limit?: number; mode?: RunnerMode } = {}): Promise<RunStats> {
  const db = await getDb();
  const mode = opts.mode ?? "hourly";
  const stats: RunStats = { users: 0, sent: 0, skipped: 0, blocked: 0, failed: 0 };
  const users = await db.query<{ user_id: string; subject: string }>(
    `SELECT i.user_id, i.subject FROM identities i JOIN users u ON u.id=i.user_id
       LEFT JOIN reminder_settings s ON s.user_id=i.user_id
      WHERE i.provider='telegram' AND u.deleted_at IS NULL AND (s.user_id IS NULL OR (s.enabled AND s.blocked_at IS NULL))
      ORDER BY i.user_id LIMIT $1`, [opts.limit ?? 2000]);
  for (const u of users.rows) {
    stats.users++;
    try {
      const r = await remindOne(db as unknown as Q, sender, u.user_id, u.subject, now, mode, stats);
      if (r === "rate_limited") break; // 429: остальных — в следующий запуск
    } catch (e) {
      stats.failed++; console.error("reminder user error", { name: (e as Error)?.name }); // ошибка одного не останавливает проход
      await logServiceError({ channel: "cron", route: "reminder.user", userId: u.user_id, error: e });
    }
  }
  return stats;
}

async function remindOne(db: Q, sender: Sender, userId: string, chatId: string, now: Date, mode: RunnerMode, stats: RunStats): Promise<"ok" | "rate_limited"> {
  const settings = await getSettings(userId);
  const clock = localClock(now, settings.timezone);
  if (!sendWindowOpen(clock.hour, settings, mode)) { stats.skipped++; return "ok"; }
  const day = await db.query("SELECT 1 FROM reminder_log WHERE user_id=$1 AND kind='_day' AND local_day=$2", [userId, clock.today]);
  if (day.rows.length) { stats.skipped++; return "ok"; }
  const view = await getForecast(userId, now);
  const s = view ? null : await loadSession(userId);
  const last = await db.query<{ d: string | null; n: string }>(
    "SELECT max(occurred_at)::text AS d, count(*)::text AS n FROM ledger_entries WHERE user_id=$1 AND kind='expense' AND source <> 'reconciliation'", [userId]);
  const log = await db.query<LogRow>(
    "SELECT kind, ref, local_day::text AS day, status FROM reminder_log WHERE user_id=$1 AND kind <> '_day' AND (local_day >= $2::date OR kind = 'onboarding')", [userId, addDays(clock.today, -40)]);
  const [r] = selectReminders({
    ...clock, mode, settings, forecast: view?.forecast ?? null,
    onboarding: s ? { phase: s.phase, updatedAt: s.updatedAt, startedAt: s.startedAt } : null,
    lastExpenseDay: last.rows[0]?.d ? localDate(new Date(last.rows[0].d), settings.timezone) : null,
    hasEntries: Number(last.rows[0]?.n ?? 0) > 0, log: log.rows,
  });
  if (!r) { stats.skipped++; return "ok"; }
  // Атомарно: дневной слот пользователя + событие. Параллельный проход получит конфликт и промолчит.
  const slot = await db.query("INSERT INTO reminder_log(user_id, kind, ref, local_day) VALUES ($1,'_day','',$2) ON CONFLICT DO NOTHING RETURNING 1", [userId, clock.today]);
  if (!slot.rows.length) { stats.skipped++; return "ok"; }
  const ev = await db.query("INSERT INTO reminder_log(user_id, kind, ref, local_day) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1", [userId, r.kind, r.ref, clock.today]);
  const release = () => db.query("DELETE FROM reminder_log WHERE user_id=$1 AND local_day=$2 AND ((kind='_day' AND ref='') OR (kind=$3 AND ref=$4))", [userId, clock.today, r.kind, r.ref]);
  if (!ev.rows.length) { await db.query("DELETE FROM reminder_log WHERE user_id=$1 AND kind='_day' AND local_day=$2", [userId, clock.today]); stats.skipped++; return "ok"; }
  let delivered = false;
  const t0 = Date.now();
  try { await sender.send(chatId, r.text, keyboardOf(r)); delivered = true; }
  catch (e) {
    const code = codeOf(e);
    // Журнал: обращение «напоминание» с итогом и ошибка с кодом Telegram (TG_403 — бот заблокирован, TG_429, TG_5xx, SEND_UNCERTAIN — нет ответа).
    const errCode = code === undefined ? "SEND_UNCERTAIN" : `TG_${code}`;
    await recordCall({ type: "reminder.send", channel: "cron", userId, result: "error", code: errCode, latencyMs: Date.now() - t0 });
    await logServiceError({ channel: "cron", route: "reminder.send", userId, code: errCode, httpStatus: code ?? null, message: `${r.kind}: ${code === undefined ? (e as Error)?.name ?? "error" : "telegram error"}` });
    if (code === 403) { // бот заблокирован — больше не пишем, пока пользователь сам не вернётся
      await updateSettings(userId, { blocked: true });
      await db.query("UPDATE reminder_log SET status='skipped' WHERE user_id=$1 AND local_day=$2 AND kind=$3 AND ref=$4", [userId, clock.today, r.kind, r.ref]);
      stats.blocked++; return "ok";
    }
    if (code === 429 || (code !== undefined && code >= 500) || code === 400) {
      // Telegram явно ответил «не доставлено» — освобождаем захват, следующий запуск попробует снова.
      await release(); stats.failed++;
      console.error("reminder send error", { code });
      return code === 429 ? "rate_limited" : "ok";
    }
    // Нет кода (таймаут/сеть): доставка неизвестна — лучше пропустить, чем прислать дубль.
    await db.query("UPDATE reminder_log SET status='failed' WHERE user_id=$1 AND local_day=$2 AND kind=$3 AND ref=$4", [userId, clock.today, r.kind, r.ref]);
    stats.failed++; console.error("reminder send uncertain", { name: (e as Error)?.name });
    return "ok";
  }
  if (delivered) {
    // Ошибка фиксации после доставки не освобождает захват (иначе — повтор).
    await db.query("UPDATE reminder_log SET status='sent' WHERE user_id=$1 AND local_day=$2 AND kind=$3 AND ref=$4", [userId, clock.today, r.kind, r.ref]).catch(() => {});
    stats.sent++;
    await recordCall({ type: "reminder.send", channel: "cron", userId, result: "ok", latencyMs: Date.now() - t0 });
    await track(userId, "reminder_sent", { kind: r.kind }, { channel: "telegram", key: `${r.kind}:${r.ref}:${clock.today}`, now });
  }
  return "ok";
}

/** Текст /reminders и клавиатура переключателей. */
export function settingsText(s: ReminderSettings): string {
  if (s.blockedAt) return "Напоминания приостановлены. Включить снова — кнопкой ниже.";
  if (!s.enabled) return "Напоминания выключены. Я ничего не присылаю сам.";
  const on = REMINDER_KINDS.filter((k) => s.kinds[k]).map((k) => KIND_LABEL[k].toLowerCase());
  return [
    "Напоминания — редко и по делу: не больше одного сообщения в день.",
    `Включено: ${on.length ? on.join(", ") : "ничего"}.`,
    `Присылаю после ${s.sendHour}:00, тихие часы ${s.quietStart}:00–${s.quietEnd}:00 (${s.timezone === DEFAULT_TZ ? "МСК" : s.timezone}).`,
  ].join("\n");
}
export function settingsKeyboard(s: ReminderSettings): InlineKeyboard {
  const k = new InlineKeyboard();
  if (!s.enabled || s.blockedAt) return k.text("Включить напоминания", "rm:all:on");
  REMINDER_KINDS.forEach((kind, i) => { k.text(`${s.kinds[kind] ? "✓" : "○"} ${KIND_LABEL[kind]}`, `rm:tog:${kind}`); if (i % 2 === 1) k.row(); });
  return k.text("Выключить все", "rm:all:off");
}
