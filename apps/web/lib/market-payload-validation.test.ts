import { expect, it } from "vitest";
import { validateMarketPayload } from "./market-payload-validation";
it("accepts resource-specific daily and intraday bar shapes, rejecting mixed invalid accounting inputs", () => {
    expect(() => validateMarketPayload({ bars: [{ securityId: "sec-us-aapl", timestamp: "2026-09-01T12:00:00Z", price: "100" }] })).not.toThrow();
    expect(() => validateMarketPayload({ bars: [{ securityId: "sec-us-aapl", date: "2026-09-01", close: "100" }] })).not.toThrow();
    expect(() => validateMarketPayload({ bars: [{ securityId: "sec-us-aapl", date: "invalid", close: "invalid", timestamp: "2026-09-01T12:00:00Z", price: "100" }] })).toThrow();
    expect(() => validateMarketPayload({ bars: [{ securityId: "sec-us-aapl", timestamp: "2026-09-01T12:00:00Z", price: "NaN" }] })).toThrow();
});
