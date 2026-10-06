import { expect, test } from "vitest";
import { decimalText, parseDecimalInput } from "./decimal-input";

test("incomplete and invalid trade drafts do not enter accounting", () => {
  for (const value of ["", ".", "-", "+", "1e", "NaN", "Infinity", "1e999", "￥100"]) expect(parseDecimalInput(value)).toBeNull();
});

test("formatted and fractional trade values parse to numbers and store without binary noise", () => {
  expect(parseDecimalInput(" 16,000.01 ")).toBe(16000.01);
  expect(decimalText(parseDecimalInput(".1")! * parseDecimalInput(".2")!)).toBe("0.02");
  expect(decimalText((parseDecimalInput("10,000")! * 16000.01) / 10000)).toBe("16000.01");
});
