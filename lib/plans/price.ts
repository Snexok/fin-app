import { createHash } from "node:crypto";
import { plansConfig } from "./config";

/** Цена, которую видит пользователь: PLUS_PRICE_RUB, а при PLUS_PRICE_EXPERIMENT=1 — стабильный вариант из PLUS_PRICE_OPTIONS. */
export function shownPrice(userId: string, cfg = plansConfig()): { price: number; variant: string } {
  if (!cfg.price.experiment || cfg.price.options.length < 2) return { price: cfg.price.plusRub, variant: "base" };
  const h = createHash("sha256").update(`plus-price:${userId}`).digest()[0];
  const p = cfg.price.options[h % cfg.price.options.length];
  return { price: p, variant: `p${p}` };
}

