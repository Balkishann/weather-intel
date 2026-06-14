/**
 * Pure data-quality predicates shared by collectors. Each returns a structured result so
 * the caller can persist it to `data_quality_checks`. These never throw — they classify.
 */

export interface CheckResult {
  checkName: string;
  passed: boolean;
  details?: string;
}

/** Probability/price must sit in [0,1]. */
export function checkPriceInRange(name: string, price: number | null): CheckResult {
  if (price === null) return { checkName: name, passed: false, details: "null price" };
  const ok = price >= 0 && price <= 1;
  return {
    checkName: name,
    passed: ok,
    details: ok ? undefined : `price ${price} outside [0,1]`,
  };
}

/** YES + NO should sum to ~1. Flags drift beyond tolerance (default 2 cents). */
export function checkComplementaryPrices(
  yes: number | null,
  no: number | null,
  tolerance = 0.02,
): CheckResult {
  if (yes === null || no === null) {
    return { checkName: "yes_no_sum", passed: false, details: "missing yes/no price" };
  }
  const drift = Math.abs(yes + no - 1);
  return {
    checkName: "yes_no_sum",
    passed: drift <= tolerance,
    details: drift <= tolerance ? undefined : `|yes+no-1| = ${drift.toFixed(4)}`,
  };
}

/** Temperature plausibility in Celsius. Earth records are roughly -90..57 °C. */
export function checkTemperaturePlausible(
  name: string,
  celsius: number | null,
): CheckResult {
  if (celsius === null) return { checkName: name, passed: false, details: "null temp" };
  const ok = celsius >= -90 && celsius <= 60;
  return {
    checkName: name,
    passed: ok,
    details: ok ? undefined : `temp ${celsius}°C implausible`,
  };
}

/** Source timestamp must not be in the future (allowing small clock skew, default 5 min). */
export function checkNotFuture(
  name: string,
  ts: Date,
  now: Date = new Date(),
  skewMs = 5 * 60_000,
): CheckResult {
  const ok = ts.getTime() <= now.getTime() + skewMs;
  return {
    checkName: name,
    passed: ok,
    details: ok ? undefined : `timestamp ${ts.toISOString()} is in the future`,
  };
}
