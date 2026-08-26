import { describe, expect, it } from "vitest";
import { MarketApiResponseError, isAbortLikeMarketError, readMarketApiResponse, stableMarketErrorMessage } from "./market-api-response";

describe("market API responses", () => {
  it("parses JSON regardless of a missing content-type header", async () => {
    const response = new Response(JSON.stringify({ quotes: [{ securityId: "sec-7203-xtks" }] }), { status: 200 });
    await expect(readMarketApiResponse(response, "response unavailable")).resolves.toEqual({
      quotes: [{ securityId: "sec-7203-xtks" }],
    });
  });

  it("replaces an HTML infrastructure response with a stable application error", async () => {
    const response = new Response("<html>upstream failure</html>", { status: 503 });
    await expect(readMarketApiResponse(response, "price response unavailable")).rejects.toEqual(
      new MarketApiResponseError("price response unavailable", 503),
    );
  });

  it("handles an empty response without exposing a browser parser error", async () => {
    const response = new Response(null, { status: 502 });
    await expect(readMarketApiResponse(response, "history response unavailable")).rejects.toMatchObject({
      message: "history response unavailable",
      status: 502,
    });
  });

  it("normalizes browser abort and timeout failures", () => {
    expect(isAbortLikeMarketError(new DOMException("Fetch is aborted", "AbortError"))).toBe(true);
    expect(stableMarketErrorMessage(new Error("The operation timed out"), "fallback")).toBe("市場データの応答が時間内に完了しませんでした");
  });

  it("does not expose arbitrary upstream details", () => {
    expect(stableMarketErrorMessage(new Error("provider socket failed"), "価格を取得できませんでした")).toBe("価格を取得できませんでした");
  });
});
