import type { MarketBar } from "@kabutora/domain";
import { finiteDecimal, isDateValue, isRecord, isText } from "./validation-primitives";
export type PublicHistoryBlock = { securityId: string; provider: string; rows: Array<[string,string] | [string,string,string]> };
/** Public transport compression only; persisted vault and accounting formats are unchanged. */
export function encodePublicHistory(bars: MarketBar[]): PublicHistoryBlock[] {
 const groups=new Map<string,PublicHistoryBlock>();
 const blocks:PublicHistoryBlock[]=[];
 for(const bar of bars) {
  const key=JSON.stringify([bar.securityId,bar.provider]);
  let block=groups.get(key);
  if(!block || block.rows.length>=512) { block={securityId:bar.securityId,provider:bar.provider,rows:[]};groups.set(key,block);blocks.push(block); }
  block.rows.push(bar.adjustedClose===undefined ? [bar.date,bar.close] : [bar.date,bar.close,bar.adjustedClose]);
 }
 return blocks;
}
export function validatePublicHistory(value:unknown):asserts value is PublicHistoryBlock[] {
 if(!Array.isArray(value) || value.length>10000) throw new Error("market_history_blocks_invalid");
 for(const block of value) {
  if(!isRecord(block) || Object.keys(block).some(key=>!["securityId","provider","rows"].includes(key)) || !isText(block.securityId,1,200) || !isText(block.provider,1,100) || !Array.isArray(block.rows) || block.rows.length>512) throw new Error("market_history_block_invalid");
  for(const row of block.rows) {
   if(!Array.isArray(row) || ![2,3].includes(row.length) || !isDateValue(row[0]) || !finiteDecimal(row[1],true) || (row.length===3 && !finiteDecimal(row[2],true))) throw new Error("market_history_row_invalid");
  }
 }
}
export function decodePublicHistory(value:unknown):MarketBar[] {
 validatePublicHistory(value);
 return value.flatMap(block=>block.rows.map(row=>({securityId:block.securityId,provider:block.provider,date:row[0],close:row[1],...(row.length===3 ? {adjustedClose:row[2]} : {})})));
}
