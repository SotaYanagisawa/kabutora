/** Iteration avoids Safari's argument-count limit for long chart histories. */
export function numericExtent(values: Iterable<number>): [number, number] {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return minimum === Infinity ? [0, 1] : [minimum, maximum];
}
