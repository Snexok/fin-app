// Предложения изменений и их подтверждение (§6.3, §9.1). Повтор подтверждения не создаёт второй операции.
import { getDb, type Queryable } from "./db";
import { assertDate, assertPositiveAmount, localDate, type ISODate, type Minor } from "./engine";
import { bumpVersion, loadBook } from "./finance-service";
import { ApiError, big, canonical, sha256hex, uuid } from "./util";

export const PROPOSAL_TTL_HOURS = 12;
export type EntrySource = "chat" | "telegram" | "form";

export interface EntryPayload {
  direction: "income" | "expense";
  amountMinor: Minor;
  currency: "RUB";
  date: ISODate;
  description: string;
  /** Закрывает плановое событие (платёж или ожидаемый доход). */
  occurrenceId: string | null;
  /** Операция уже входит в указанный остаток: не меняет баланс повторно. */
  alreadyIncludedInBalance: boolean;
  /** Канал, где предложение создано (ledger_entries.source). */
  source: EntrySource;
}

export interface ProposalView {
  id: string;
  revision: number;
  baseFinanceVersion: string;
  type: "create_entry";
  status: "pending" | "applied" | "rejected" | "expired";
  payload: EntryPayload;
  expiresAt: string;
  result: unknown;
}

function rowToView(r: Record<string, any>): ProposalView { // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
  return {
    id: r.id, revision: Number(r.revision), baseFinanceVersion: String(r.base_finance_version), type: r.kind, status: r.status,
    payload: { ...p, amountMinor: BigInt(p.amountMinor) },
    expiresAt: new Date(r.expires_at).toISOString(),
    result: r.result == null ? null : typeof r.result === "string" ? JSON.parse(r.result) : r.result,
  };
}

export interface EntryInput { direction: "income" | "expense"; amountMinor: Minor; date?: ISODate; description?: string; occurrenceId?: string | null; alreadyIncludedInBalance?: boolean; source?: EntrySource }

async function validateEntry(q: Queryable, userId: string, e: EntryInput, today: ISODate): Promise<EntryPayload> {
  if (e.direction !== "income" && e.direction !== "expense") throw new ApiError("INVALID_INPUT", 422, "direction: income или expense");
  assertPositiveAmount(e.amountMinor, "Сумма");
  const date = assertDate(e.date ?? today, "Дата");
  if (date > today) throw new ApiError("INVALID_INPUT", 422, "Операция не может быть в будущем. Для будущих платежей используйте план.");
  if (e.occurrenceId) {
    const o = await q.query<{ direction: string }>("SELECT direction FROM occurrences WHERE id=$1 AND user_id=$2 AND cancelled_at IS NULL", [e.occurrenceId, userId]);
    if (!o.rows[0]) throw new ApiError("NOT_FOUND", 404, "Плановое событие не найдено");
    if (o.rows[0].direction !== e.direction) throw new ApiError("INVALID_INPUT", 422, "Направление операции не совпадает с плановым событием");
  }
  return {
    direction: e.direction, amountMinor: e.amountMinor, currency: "RUB", date,
    description: (e.description ?? "").trim().slice(0, 120) || (e.direction === "expense" ? "Расход" : "Доход"),
    occurrenceId: e.occurrenceId ?? null, alreadyIncludedInBalance: !!e.alreadyIncludedInBalance,
    source: e.source === "telegram" || e.source === "form" ? e.source : "chat",
  };
}

/** Найти плановое событие по описанию ("аренду" -> "Аренда"). Только подсказка; подтверждает пользователь. */
export async function matchOccurrence(userId: string, description: string, direction: "income" | "expense"): Promise<{ id: string; name: string } | null> {
  const words = description.toLowerCase().split(/[^a-zа-яё0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return null;
  const db = await getDb();
  const book = await loadBook(db, userId);
  if (!book) return null;
  const stem = (w: string) => w.slice(0, Math.max(3, w.length - 2));
  const cands = book.occurrences.filter((o) => o.direction === direction && o.remainingMinor > 0n &&
    o.name.toLowerCase().split(/[^a-zа-яё0-9]+/).some((n) => n.length >= 3 && words.some((w) => stem(n) === stem(w) || n.startsWith(stem(w)))));
  return cands.length === 1 ? { id: cands[0].id, name: cands[0].name } : null;
}

export async function createEntryProposal(userId: string, entry: EntryInput, now = new Date()): Promise<ProposalView> {
  const db = await getDb();
  return db.tx(async (q) => {
    const book = await loadBook(q, userId, true);
    if (!book) throw new ApiError("NO_PLAN", 409, "Сначала нужен план: остаток, доход и платежи");
    const payload = await validateEntry(q, userId, entry, localDate(now, book.timezone));
    const id = uuid();
    const expires = new Date(now.getTime() + PROPOSAL_TTL_HOURS * 3_600_000);
    const r = await q.query("INSERT INTO proposals(id, user_id, kind, payload, payload_hash, base_finance_version, expires_at) VALUES ($1,$2,'create_entry',$3,$4,$5,$6) RETURNING *",
      [id, userId, canonical(payload), sha256hex(canonical(payload)), book.financeVersion, expires]);
    return rowToView(r.rows[0]);
  });
}

export async function getProposal(userId: string, id: string): Promise<ProposalView> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError("NOT_FOUND", 404, "Предложение не найдено");
  const db = await getDb();
  const r = await db.query("SELECT * FROM proposals WHERE id=$1 AND user_id=$2", [id, userId]);
  if (!r.rows[0]) throw new ApiError("NOT_FOUND", 404, "Предложение не найдено");
  return rowToView(r.rows[0]);
}

export async function rejectProposal(userId: string, id: string): Promise<ProposalView> {
  const db = await getDb();
  return db.tx(async (q) => {
    const r = await q.query("SELECT * FROM proposals WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, userId]);
    if (!r.rows[0]) throw new ApiError("NOT_FOUND", 404, "Предложение не найдено");
    if (r.rows[0].status === "pending") {
      const u = await q.query("UPDATE proposals SET status='rejected' WHERE id=$1 RETURNING *", [id]);
      return rowToView(u.rows[0]);
    }
    return rowToView(r.rows[0]);
  });
}

export interface ConfirmOutcome { status: number; body: Record<string, unknown>; replayed: boolean }

/**
 * Подтверждение конкретной ревизии. Алгоритм §9.1:
 * ключ идемпотентности -> блокировка books -> блокировка proposal -> проверки -> запись -> версия -> событие -> результат.
 */
export async function confirmProposal(userId: string, id: string, opts: { revision: number; idempotencyKey?: string | null }, now = new Date()): Promise<ConfirmOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError("NOT_FOUND", 404, "Предложение не найдено");
  if (!Number.isInteger(opts.revision) || opts.revision < 1) throw new ApiError("INVALID_INPUT", 400, "Нужна revision");
  const key = (opts.idempotencyKey?.trim() || `proposal:${id}:${opts.revision}`).slice(0, 200);
  const requestHash = sha256hex(canonical({ id, revision: opts.revision }));
  const db = await getDb();
  return db.tx(async (q) => {
    const ins = await q.query("INSERT INTO idempotency_keys(user_id, scope, key, request_hash, status, expires_at) VALUES ($1,'proposal_confirm',$2,$3,'processing',$4) ON CONFLICT DO NOTHING RETURNING key",
      [userId, key, requestHash, new Date(now.getTime() + 86_400_000)]);
    if (!ins.rows.length) {
      const ex = (await q.query<{ request_hash: string; status: string; response_status: number; response_body: unknown }>(
        "SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE user_id=$1 AND scope='proposal_confirm' AND key=$2", [userId, key])).rows[0];
      if (ex.request_hash !== requestHash) throw new ApiError("IDEMPOTENCY_KEY_REUSED", 409, "Этот ключ уже использован для другого запроса");
      if (ex.status !== "completed") throw new ApiError("IN_PROGRESS", 409, "Подтверждение уже обрабатывается. Повторите чуть позже.");
      const body = typeof ex.response_body === "string" ? JSON.parse(ex.response_body) : ex.response_body;
      return { status: ex.response_status, body: body as Record<string, unknown>, replayed: true };
    }
    const finish = async (status: number, body: Record<string, unknown>): Promise<ConfirmOutcome> => {
      await q.query("UPDATE idempotency_keys SET status='completed', response_status=$3, response_body=$4 WHERE user_id=$1 AND scope='proposal_confirm' AND key=$2",
        [userId, key, status, canonical(body)]);
      return { status, body, replayed: false };
    };
    const book = await loadBook(q, userId, true);
    if (!book) throw new ApiError("NOT_FOUND", 404, "Предложение не найдено");
    const pr = await q.query("SELECT * FROM proposals WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, userId]);
    if (!pr.rows[0]) throw new ApiError("NOT_FOUND", 404, "Предложение не найдено");
    let p = rowToView(pr.rows[0]);
    const err = (code: string, message: string, status = 409) => ({ error: { code, message }, proposal: p });

    if (p.status === "applied") return finish(200, { proposal: p, result: p.result, alreadyApplied: true });
    if (p.status === "rejected") return finish(409, err("PROPOSAL_REJECTED", "Это предложение отклонено"));
    if (p.status === "expired" || new Date(p.expiresAt) <= now) {
      await q.query("UPDATE proposals SET status='expired' WHERE id=$1", [id]);
      p = { ...p, status: "expired" };
      return finish(409, err("PROPOSAL_EXPIRED", "Предложение устарело. Создайте новое."));
    }
    if (p.revision !== opts.revision) return finish(409, err("PROPOSAL_REVISION_MISMATCH", "Предложение изменилось. Проверьте новые данные."));
    if (big(p.baseFinanceVersion) !== book.financeVersion) {
      // Данные изменились: новая ревизия на текущей версии, старая кнопка её не подтвердит.
      const u = await q.query("UPDATE proposals SET revision=revision+1, base_finance_version=$2 WHERE id=$1 RETURNING *", [id, book.financeVersion]);
      p = rowToView(u.rows[0]);
      return finish(409, err("STALE_PROPOSAL", "Данные изменились. Проверьте обновлённый расчёт."));
    }
    // Применяем: одна запись, одна версия, одно событие.
    const pl = p.payload;
    if (pl.occurrenceId) {
      const o = await q.query("SELECT 1 FROM occurrences WHERE id=$1 AND user_id=$2 AND cancelled_at IS NULL AND direction=$3", [pl.occurrenceId, userId, pl.direction]);
      if (!o.rows.length) throw new ApiError("NOT_FOUND", 404, "Плановое событие больше не активно");
    }
    const entryId = uuid();
    const signed = pl.direction === "expense" ? -pl.amountMinor : pl.amountMinor;
    const occurredAt = pl.date === localDate(now, book.timezone) ? now : new Date(`${pl.date}T12:00:00Z`);
    const source: EntrySource = pl.source ?? "chat";
    await q.query(
      `INSERT INTO ledger_entries(id, user_id, occurrence_id, kind, amount_minor, affects_balance, occurred_at, name, source, proposal_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, clock_timestamp())`,
      [entryId, userId, pl.occurrenceId, pl.direction, signed, !pl.alreadyIncludedInBalance, occurredAt, pl.description, source, id]);
    const version = await bumpVersion(q, userId, "entry_created", entryId, { proposalId: id, revision: p.revision, amountMinor: signed, occurrenceId: pl.occurrenceId });
    const result = { entryId, financeVersion: version.toString() };
    const u = await q.query("UPDATE proposals SET status='applied', applied_at=$2, result=$3 WHERE id=$1 RETURNING *", [id, now, JSON.stringify(result)]);
    p = rowToView(u.rows[0]);
    return finish(200, { proposal: p, result, alreadyApplied: false });
  });
}
