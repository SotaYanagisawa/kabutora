import { describe, expect, it } from "vitest";
import { clientErrorCode, isReleaseMismatchError } from "./client-recovery";

describe("client recovery classification", () => {
  it("only classifies stale module failures as release mismatches", () => {
    expect(isReleaseMismatchError(new Error("Loading chunk 123 failed"))).toBe(true);
    expect(isReleaseMismatchError(new Error("Failed to fetch dynamically imported module"))).toBe(true);
    expect(isReleaseMismatchError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isReleaseMismatchError(new Error("market_refresh_failed"))).toBe(false);
  });

  it("uses a stable opaque code instead of exposing an error message", () => {
    const first = clientErrorCode(new Error("private-looking detail"));
    expect(first).toMatch(/^CLIENT-[0-9A-F]{8}$/u);
    expect(clientErrorCode(new Error("private-looking detail"))).toBe(first);
    expect(first).not.toContain("private-looking detail");
  });

  it("exports a non-empty string for CLIENT_BUILD_ID", async () => {
    const { CLIENT_BUILD_ID } = await import("./client-recovery");
    expect(typeof CLIENT_BUILD_ID).toBe("string");
    expect(CLIENT_BUILD_ID.length).toBeGreaterThan(0);
  });
});
