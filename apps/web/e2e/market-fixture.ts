import type { Page, Route } from "@playwright/test";
import type { CorporateAction, DistributionEvent, IntradayBar, MarketBar } from "@kabutora/domain";

/**
 * Serves the real market wire contract (`/api/market/snapshot`, `history`,
 * `distributions`, `registry`) from fixture data. Properties are read on every
 * request, so a test can mutate the fixture to simulate new prices.
 */
export type MarketFixture = {
  generatedAt?: string;
  quotes?: Array<Record<string, unknown> & { securityId: string }>;
  benchmarks?: Array<Record<string, unknown>>;
  intraday?: IntradayBar[];
  /** Return `null` to answer the history request with HTTP 500. */
  bars?: MarketBar[] | ((from: string) => MarketBar[] | null);
  corporateActions?: CorporateAction[];
  inceptionDates?: Record<string, string>;
  distributions?: DistributionEvent[];
  coverage?: Array<Record<string, unknown> & { securityId: string }>;
  /** Simulated server + network time for the snapshot request. */
  snapshotDelayMs?: number;
};

function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(36);
}

export function snapshotBody(fixture: MarketFixture) {
  const generatedAt = fixture.generatedAt ?? new Date().toISOString();
  const grouped = new Map<string, IntradayBar[]>();
  for (const bar of fixture.intraday ?? []) grouped.set(bar.securityId, [...grouped.get(bar.securityId) ?? [], bar]);
  const series = [...grouped].map(([id, bars]) => {
    const sorted = [...bars].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const times = sorted.map((bar) => Math.floor(Date.parse(bar.timestamp) / 1000));
    return {
      id,
      v: sorted[0].provider,
      ...(sorted[0].session ? { s: sorted[0].session } : {}),
      t: times.map((time, index) => index ? time - times[index - 1] : time),
      p: sorted.map((bar) => Number(bar.price)),
    };
  });
  const content = { quotes: fixture.quotes ?? [], benchmarks: fixture.benchmarks ?? [], series };
  return { schemaVersion: 2, full: true, generatedAt, revision: hash(JSON.stringify(content)), catalogKey: "fixture", failures: [], ...content };
}

const fulfill = (route: Route, json: unknown, headers: Record<string, string> = {}) => route.fulfill({ json, headers: { "X-Market-Server-Time": new Date().toISOString(), ...headers } });

export async function mockMarket(page: Page, fixture: MarketFixture) {
  await page.route("**/api/market/snapshot**", async (route) => {
    if (fixture.snapshotDelayMs) await new Promise((resolve) => setTimeout(resolve, fixture.snapshotDelayMs));
    // Always 200: Playwright's WebKit cannot fulfill a mocked 304. Unit and workerd tests cover 304.
    const body = snapshotBody(fixture);
    await fulfill(route, body, { ETag: `"${body.revision}"` });
  });
  await page.route("**/api/market/history**", async (route) => {
    const from = new URL(route.request().url()).searchParams.get("from") ?? "";
    const bars = typeof fixture.bars === "function" ? fixture.bars(from) : fixture.bars ?? [];
    if (bars === null) {
      await route.fulfill({ status: 500, json: { error: "fixture_history_rejected" } });
      return;
    }
    const series: Record<string, { provider: string; rows: Array<[string, string]> }> = {};
    for (const bar of bars.filter((item) => item.date >= from)) {
      series[bar.securityId] ??= { provider: bar.provider, rows: [] };
      series[bar.securityId].rows.push([bar.date, bar.close]);
    }
    await fulfill(route, { generatedAt: fixture.generatedAt ?? new Date().toISOString(), from, series, corporateActions: fixture.corporateActions ?? [], inceptionDates: fixture.inceptionDates ?? {}, pending: [] });
  });
  await page.route("**/api/market/distributions", (route) => fulfill(route, {
    generatedAt: fixture.generatedAt ?? new Date().toISOString(),
    distributions: fixture.distributions ?? [],
    corporateActions: [],
    coverage: fixture.coverage ?? [],
  }));
  await page.route("**/api/market/registry", (route) => fulfill(route, { added: [], rejected: [], size: 0 }));
}
