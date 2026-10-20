// Деньги: целые копейки (bigint). Рубли и форматирование только на границе.
export type Minor = bigint;

/** Верхняя граница суммы одной операции: 10 млрд ₽. */
export const MAX_MINOR = 1_000_000_000_000n;

export class MoneyError extends Error {
  code = "INVALID_AMOUNT";
}

/** Строгий разбор десятичной строки рублей ("1500", "1500.5", "1 500,50") в копейки. */
export function rublesToMinor(input: string | number): Minor {
  let s: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new MoneyError("Сумма должна быть конечным числом");
    // Единое правило для number: округление до копейки половиной от нуля по десятичной записи (2.675 -> 2.68).
    if (Math.abs(input) > 1e15) throw new MoneyError("Слишком большая сумма");
    const [i, f = ""] = Math.abs(input).toFixed(10).split(".");
    let k = BigInt(i) * 100n + BigInt((f + "00").slice(0, 2));
    if ((f[2] ?? "0") >= "5") k += 1n;
    return input < 0 ? -k : k;
  } else s = input.replace(/[\s\u00a0]/g, "").replace(",", ".");
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new MoneyError(`Не удалось разобрать сумму: ${String(input)}`);
  const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? "0").padEnd(2, "0"));
  return m[1] ? -v : v;
}

/** Копейки из строки/числа/bigint в формате API (десятичная строка копеек). */
export function parseMinor(v: unknown): Minor {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d{1,18}$/.test(v)) return BigInt(v);
  throw new MoneyError(`Некорректная сумма в копейках: ${String(v)}`);
}

/** Положительная сумма в допустимом диапазоне (цена, расход). Infinity/NaN/0 отклоняются. */
export function assertPositiveAmount(v: Minor, field = "amount"): Minor {
  if (v <= 0n) throw new MoneyError(`${field}: сумма должна быть больше нуля`);
  if (v > MAX_MINOR) throw new MoneyError(`${field}: слишком большая сумма`);
  return v;
}

export function assertNonNegativeAmount(v: Minor, field = "amount"): Minor {
  if (v < 0n) throw new MoneyError(`${field}: сумма не может быть отрицательной`);
  if (v > MAX_MINOR) throw new MoneyError(`${field}: слишком большая сумма`);
  return v;
}

/** Только для совместимых ответов в рублях (number). Копейки сохраняются как дробная часть. */
export function minorToRubles(v: Minor): number {
  return Number(v) / 100;
}

export const minStr = (v: Minor) => v.toString();

export function minBig(...xs: Minor[]): Minor { return xs.reduce((a, b) => (b < a ? b : a)); }
export function maxBig(...xs: Minor[]): Minor { return xs.reduce((a, b) => (b > a ? b : a)); }

/** floor-деление для bigint (в JS bigint делится с усечением к нулю). */
export function floorDiv(a: Minor, b: Minor): Minor {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** "15 000 ₽" или "15 000,50 ₽" — с неразрывными пробелами (разряды и перед ₽). Рубли округляются вниз только при отображении. */
export function formatRub(v: Minor, opts: { kopecks?: boolean } = {}): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const rub = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const kop = a % 100n;
  const tail = opts.kopecks && kop !== 0n ? "," + kop.toString().padStart(2, "0") : "";
  return `${neg ? "−" : ""}${rub}${tail}\u00a0₽`;
}
