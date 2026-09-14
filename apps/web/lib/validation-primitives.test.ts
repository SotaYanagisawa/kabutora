import { describe, expect, it } from "vitest";
import { finiteDecimal, isDateValue, isRecord, isText } from "./validation-primitives";

describe("validation primitives", () => {
  it("distinguishes records from arrays and null", () => {
    expect(isRecord({ id: "a" })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it("enforces explicit text bounds", () => {
    expect(isText("abc", 1, 3)).toBe(true);
    expect(isText("", 1)).toBe(false);
    expect(isText("abcd", 0, 3)).toBe(false);
  });

  it("accepts finite decimal strings and rejects non-finite or non-string input", () => {
    expect(finiteDecimal("-12.5e2")).toBe(true);
    expect(finiteDecimal("0", true)).toBe(false);
    expect(finiteDecimal("0.01", true)).toBe(true);
    expect(finiteDecimal("NaN")).toBe(false);
    expect(finiteDecimal(12)).toBe(false);
  });

  it("accepts parseable dates only", () => {
    expect(isDateValue("2026-09-14T12:00:00Z")).toBe(true);
    expect(isDateValue("not-a-date")).toBe(false);
  });
});
