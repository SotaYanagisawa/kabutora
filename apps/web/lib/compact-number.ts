const fourSignificantFigures = new Intl.NumberFormat("ja-JP", {
  maximumSignificantDigits: 4,
  useGrouping: false,
});

export function compactNumber(value: number) {
  return fourSignificantFigures.format(value);
}
