import { finiteDecimal, isDateValue, isRecord, isText } from "./validation-primitives";

const object = isRecord;
const text = (value: unknown) => isText(value, 1);
const date = isDateValue;
/** Validate accounting inputs at the network boundary, before merging caches. */
export function validateMarketPayload(value: unknown): void {
  if (!object(value)) throw new Error("market_payload_invalid");
  const arrays: Record<string, (item: Record<string, unknown>) => boolean> = {
    quotes: (item) => text(item.securityId) && finiteDecimal(item.price, true) && (item.previousRegularClose === undefined || finiteDecimal(item.previousRegularClose, true)),
    bars: (item) => text(item.securityId) && date(item.date) && finiteDecimal(item.close, true) && (item.adjustedClose === undefined || finiteDecimal(item.adjustedClose, true)),
    intraday: (item) => text(item.securityId) && date(item.timestamp) && finiteDecimal(item.price, true),
    corporateActions: (item) => text(item.id) && text(item.securityId) && date(item.effectiveDate) && ["SPLIT", "REVERSE_SPLIT"].includes(String(item.type)) && finiteDecimal(item.numerator, true) && finiteDecimal(item.denominator, true),
    distributions: (item) => text(item.id) && text(item.securityId) && finiteDecimal(item.amountPerUnit) && text(item.currency) && (item.distributionUnit === undefined || finiteDecimal(item.distributionUnit, true)),
    benchmarks: (item) => text(item.id) && typeof item.value === "number" && Number.isFinite(item.value),
  };
  for (const [name, valid] of Object.entries(arrays)) {
    const array = value[name];
    if (array !== undefined && (!Array.isArray(array) || !array.every((item) => object(item) && valid(item)))) throw new Error(`market_${name}_invalid`);
  }
}

/** Older browser caches store quotes as a map and price series as tuples. */
export function validateCachedMarketPayload(value: unknown): void {
  if (!object(value)) throw new Error("market_cache_invalid");
  validateMarketPayload({ ...value, ...(object(value.quotes) ? { quotes: Object.values(value.quotes) } : {}) });
  for (const key of ["series", "intradaySeries"] as const) {
    const series = value[key];
    if (series === undefined) continue;
    if (!object(series)) throw new Error("market_cache_series_invalid");
    for (const item of Object.values(series)) {
      const validRow = key === "series"
        ? (row: unknown) => Array.isArray(row) && date(row[0]) && finiteDecimal(row[1], true) && (row[2] === undefined || finiteDecimal(row[2], true))
        : (row: unknown) => Array.isArray(row)
          && date(row[0])
          && finiteDecimal(row[1], true)
          && (row[2] === undefined || typeof row[2] === "string")
          && (row[3] === undefined || ["pre_market", "regular", "after_hours", "pts_day", "pts_night", "closed"].includes(String(row[3])));
      if (!object(item) || !Array.isArray(item.rows) || !item.rows.every(validRow)) throw new Error("market_cache_series_invalid");
    }
  }
}
