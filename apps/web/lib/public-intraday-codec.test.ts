import { expect, it } from "vitest";
import { decodePublicIntraday, encodePublicIntraday } from "./public-intraday-codec";
it("round trips exact prices and separate trading sessions in bounded blocks", () => {
  const bars = Array.from({length:1500},(_,i)=>({securityId:"sec-7203",provider:"synthetic",session:"pts_night" as const,venueCode:"JNX_NIGHT",timestamp:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),price:"123.1234567890123456789"}));
  const blocks=encodePublicIntraday(bars);
  expect(blocks.every(block=>block.rows.length<=512)).toBe(true);
  expect(decodePublicIntraday(blocks)).toEqual(bars);
  expect(()=>decodePublicIntraday([{...blocks[0],rows:[["invalid","1"]]}])).toThrow();
  expect(()=>decodePublicIntraday([{...blocks[0],session:"unexpected"}])).toThrow();
});
