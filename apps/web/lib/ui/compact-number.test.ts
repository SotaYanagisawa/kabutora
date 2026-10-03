import { describe, expect, it } from "vitest";
import { compactNumber } from "./compact-number";

describe("compactNumber", () => {
  it("keeps up to four significant figures", () => {
    expect(compactNumber(1.2345)).toBe("1.235");
    expect(compactNumber(12.345)).toBe("12.35");
    expect(compactNumber(123.45)).toBe("123.5");
    expect(compactNumber(1_234.5)).toBe("1235");
  });

  it("does not add unnecessary trailing zeroes", () => {
    expect(compactNumber(12)).toBe("12");
    expect(compactNumber(12.3)).toBe("12.3");
  });
});
