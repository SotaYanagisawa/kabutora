import { expect, it } from "vitest";
import { parseEcbUsdJpy } from "./ecb-fx";
it("calculates official cross rates without rounding through native numbers", () => {
    expect(parseEcbUsdJpy(`<Cube time='2026-10-01'><Cube currency='USD' rate='1.25'/><Cube currency='JPY' rate='187.5'/></Cube>`)).toEqual([{ date: "2026-10-01", price: "150" }]);
    expect(() => parseEcbUsdJpy(`<Cube time='2026-10-01'><Cube currency='USD' rate='0'/><Cube currency='JPY' rate='187.5'/></Cube>`)).toThrow("ecb_rate_invalid");
    expect(() => parseEcbUsdJpy(`<!DOCTYPE external [<!ENTITY x SYSTEM 'file:///secret'>]>`)).toThrow("ecb_payload_invalid");
});
