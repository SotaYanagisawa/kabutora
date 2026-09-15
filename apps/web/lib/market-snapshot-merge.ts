import type { ServerBenchmark, ServerRemoteQuote } from "./server-market-types";

export function mergeQuoteRecords(...records: Array<Record<string, ServerRemoteQuote>>) {
  const result: Record<string, ServerRemoteQuote> = {};
  for (const record of records) {
    for (const [securityId, quote] of Object.entries(record)) {
      const current = result[securityId];
      if (
        !current ||
        Date.parse(quote.fetchedAt) > Date.parse(current.fetchedAt) ||
        (Date.parse(quote.fetchedAt) === Date.parse(current.fetchedAt) && Date.parse(quote.marketTimestamp) >= Date.parse(current.marketTimestamp)) ||
        Date.parse(quote.marketTimestamp) > Date.parse(current.marketTimestamp)
      ) {
        result[securityId] = quote;
      }
    }
  }
  return result;
}
export function mergeBenchmarks(...groups: ServerBenchmark[][]) {
  const result = new Map<string, ServerBenchmark>();
  for (const benchmark of groups.flat()) {
    const current = result.get(benchmark.id);
    if (!current || Date.parse(benchmark.fetchedAt ?? benchmark.marketTimestamp) >= Date.parse(current.fetchedAt ?? current.marketTimestamp)) result.set(benchmark.id, benchmark);
  }
  return [...result.values()];
}
