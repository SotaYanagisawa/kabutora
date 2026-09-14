import { numericExtent } from "./numeric-extent";

export function dynamicChartDomain(
  primaryValues: number[],
  referenceValues: number[] = [],
  options: { zeroBased?: boolean; nonNegative?: boolean; minimumSpread?: number } = {},
): [number, number] {
  const primary = primaryValues.filter(Number.isFinite);
  const primaryAllZero = primary.length > 0 && primary.every((value) => value === 0);
  const reference = referenceValues.filter((value) => Number.isFinite(value) && (value !== 0 || primaryAllZero));
  const values = [...primary, ...reference];
  if (!values.length) return [0, 1];

  const [minimum, maximum] = numericExtent(values);
  if (options.zeroBased) return [0, Math.max(options.minimumSpread ?? 1, maximum * 1.04)];

  const spread = Math.max(maximum - minimum, Math.abs(maximum) * 0.0025, options.minimumSpread ?? 1);
  const lower = minimum - spread * 0.16;
  return [options.nonNegative ? Math.max(0, lower) : lower, maximum + spread * 0.16];
}
