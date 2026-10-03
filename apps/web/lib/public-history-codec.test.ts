import {expect,it} from "vitest";
import {encodePublicHistory,decodePublicHistory} from "./public-history-codec";
it("round-trips exact financial strings in bounded blocks while reducing common history transfer",()=>{
 const bars=Array.from({length:7560},(_,i)=>({securityId:"sec-us-fixture",provider:"fixture",date:`${1997+Math.floor(i/252)}-${String(Math.floor(i%252/21)+1).padStart(2,"0")}-${String(i%21+1).padStart(2,"0")}`,close:"100.1234567890123456789",...(i%2 ? {adjustedClose:"99.1234567890123456789"} : {})}));
 const encoded=encodePublicHistory(bars);
 expect(encoded.every(block=>block.rows.length<=512)).toBe(true);
 expect(decodePublicHistory(encoded)).toEqual(bars);
 expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(bars).length/2);
 expect(()=>decodePublicHistory([{securityId:"sec-us-fixture",provider:"fixture",rows:[["invalid","100"]]}])).toThrow();
 expect(()=>decodePublicHistory([{securityId:"sec-us-fixture",provider:"fixture",rows:[["2026-10-01","NaN"]]}])).toThrow();
});
