// «Хочу Плюс» без оплаты: заявка с необязательной «честной ценой» (исследование готовности платить, 299/399/499).
// Ничего не списывается, карта не нужна. Одна строка на пользователя; повтор обновляет выбор цены, created_at остаётся.
import { getDb, type Queryable } from "../db";
import { track } from "../analytics";
import { plansConfig } from "./config";
import { shownPrice } from "./price";

export type InterestChannel = "web" | "telegram" | "miniapp";
export interface InterestResult { priceChoice: number | null; offeredPrice: number; variant: string; createdAt: string; updatedAt: string; repeat: boolean }

export class InterestError extends Error { code = "INVALID_INPUT"; status = 400; }

/** price: одна из PLUS_PRICE_OPTIONS или null («не знаю»). Чужое значение — InterestError (в API — 400). */
export async function upsertInterest(userId: string, o: { price: number | null | undefined; channel: InterestChannel; now?: Date; q?: Queryable }): Promise<InterestResult> {
  const cfg = plansConfig();
  const price = o.price == null ? null : Number(o.price);
  if (price != null && !cfg.price.options.includes(price)) throw new InterestError("Выберите один из вариантов цены");
  const now = o.now ?? new Date();
  const sp = shownPrice(userId, cfg);
  const db = o.q ?? (await getDb());
  const r = await db.query<{ price_choice: number | null; offered_price: number; variant: string; created_at: Date; updated_at: Date; updates: number }>(
    `INSERT INTO plus_interest(user_id, price_choice, offered_price, variant, channel, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
     ON CONFLICT (user_id) DO UPDATE SET price_choice = EXCLUDED.price_choice, channel = EXCLUDED.channel, offered_price = EXCLUDED.offered_price,
       variant = EXCLUDED.variant, updated_at = EXCLUDED.updated_at, updates = plus_interest.updates + 1
     RETURNING price_choice, offered_price, variant, created_at, updated_at, updates`,
    [userId, price, sp.price, sp.variant, o.channel, now]);
  const x = r.rows[0];
  const repeat = Number(x.updates) > 0;
  const priceTag = (price == null ? "none" : String(price)) as "none";
  await track(userId, "plus_interest", { price: priceTag, repeat: repeat ? "true" : "false" }, { channel: o.channel, key: `interest:${now.getTime()}`, now });
  return { priceChoice: x.price_choice == null ? null : Number(x.price_choice), offeredPrice: Number(x.offered_price), variant: x.variant, createdAt: new Date(x.created_at).toISOString(), updatedAt: new Date(x.updated_at).toISOString(), repeat };
}
