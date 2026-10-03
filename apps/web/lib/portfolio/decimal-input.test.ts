import { expect, test } from "vitest";
import { parseDecimalInput } from "./decimal-input";

test("incomplete and invalid trade drafts do not enter accounting", () => {
  for (const value of ["", ".", "-", "+", "1e", "NaN", "Infinity", "1e999", "￥100"]) expect(parseDecimalInput(value)).toBeNull();
});

test("formatted and fractional trade values retain decimal precision", () => {
  expect(parseDecimalInput(" 16,000.01 ")?.toString()).toBe("16000.01");
  expect(parseDecimalInput(".1")?.mul(parseDecimalInput(".2")!).toString()).toBe("0.02");
  expect(parseDecimalInput("10,000")?.mul("16000.01").div(10000).toString()).toBe("16000.01");
});
