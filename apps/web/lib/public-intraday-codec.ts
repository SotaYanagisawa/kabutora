import type { IntradayBar } from "@kabutora/domain";
import { finiteDecimal, isDateValue, isRecord, isText } from "./validation-primitives";

export type PublicIntradayBlock = Omit<IntradayBar, "timestamp" | "price"> & { rows: Array<[string, string]> };
export function encodePublicIntraday(bars: IntradayBar[]): PublicIntradayBlock[] {
  const groups = new Map<string, PublicIntradayBlock>();
  const blocks: PublicIntradayBlock[] = [];
  for (const bar of bars) {
    const { timestamp, price, ...metadata } = bar;
    const key = JSON.stringify(metadata);
    let block = groups.get(key);
    if (!block || block.rows.length >= 512) {
      block = { ...metadata, rows: [] }; groups.set(key, block); blocks.push(block);
    }
    block.rows.push([timestamp, price]);
  }
  return blocks;
}
export function decodePublicIntraday(value: unknown): IntradayBar[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("market_intraday_blocks_invalid");
  const bars: IntradayBar[] = [];
  for (const block of value) {
    if (!isRecord(block) || Object.keys(block).some(key => !["securityId", "provider", "venueCode", "session", "rows"].includes(key))
      || !isText(block.securityId, 1, 200) || !isText(block.provider, 1, 100)
      || (block.venueCode !== undefined && !isText(block.venueCode, 1, 100))
      || (block.session !== undefined && !["pre_market", "regular", "after_hours", "pts_day", "pts_night", "closed"].includes(String(block.session)))
      || !Array.isArray(block.rows) || block.rows.length > 512) throw new Error("market_intraday_block_invalid");
    for (const row of block.rows) {
      if (!Array.isArray(row) || row.length !== 2 || !isDateValue(row[0]) || !finiteDecimal(row[1], true)) throw new Error("market_intraday_row_invalid");
      bars.push({ securityId: block.securityId, provider: block.provider, timestamp: row[0], price: row[1],
        ...(block.venueCode === undefined ? {} : { venueCode: block.venueCode }),
        ...(block.session === undefined ? {} : { session: block.session as IntradayBar["session"] }) });
    }
  }
  return bars;
}
