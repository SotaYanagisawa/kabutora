import { marketKey } from "@kabutora/domain/market";

export type SearchableSecurity = {
  id: string;
  displaySymbol: string;
  name: string;
  aliases?: readonly string[];
  readingKana?: string;
  providerSymbols?: { yahoo?: string; monex?: string };
};

type IndexedSecurity<T extends SearchableSecurity> = {
  security: T;
  order: number;
  symbol: string;
  providerSymbols: readonly string[];
  name: string;
  aliases: readonly string[];
  reading: string;
};

export type SecuritySearchIndex<T extends SearchableSecurity> = readonly IndexedSecurity<T>[];

const toHiragana = (value: string) => value.replace(/[\u30a1-\u30f6]/gu, (character) =>
  String.fromCharCode(character.charCodeAt(0) - 0x60));

export function normalizeSecuritySearchTerm(value: string): string {
  return toHiragana(value.normalize("NFKC").toLocaleLowerCase("ja").trim())
    .replaceAll("高配当", "好配当")
    .replace(/[\s・･()（）「」『』【】\[\]{}｛｝_\-.,/]+/gu, "");
}

export function buildSecuritySearchIndex<T extends SearchableSecurity>(
  securities: readonly T[],
): SecuritySearchIndex<T> {
  return securities.map((security, order) => ({
    security,
    order,
    symbol: normalizeSecuritySearchTerm(security.displaySymbol),
    providerSymbols: Object.values(security.providerSymbols ?? {})
      .filter((value): value is string => Boolean(value))
      .map(normalizeSecuritySearchTerm),
    name: normalizeSecuritySearchTerm(security.name),
    aliases: (security.aliases ?? []).map(normalizeSecuritySearchTerm),
    reading: security.readingKana ? normalizeSecuritySearchTerm(security.readingKana) : "",
  }));
}

function matchScore<T extends SearchableSecurity>(entry: IndexedSecurity<T>, query: string): number {
  if (entry.symbol === query) return 1_000;
  if (entry.providerSymbols.some((symbol) => symbol === query)) return 950;
  if (entry.symbol.startsWith(query)) return 900 - Math.min(entry.symbol.length, 50);
  if (entry.providerSymbols.some((symbol) => symbol.startsWith(query))) return 850;
  if (entry.name === query) return 800;
  if (entry.aliases.some((alias) => alias === query)) return 780;
  if (entry.name.startsWith(query)) return 700;
  if (entry.aliases.some((alias) => alias.startsWith(query))) return 680;
  if (entry.reading.startsWith(query)) return 660;
  if (entry.name.includes(query)) return 500;
  if (entry.aliases.some((alias) => alias.includes(query))) return 480;
  if (entry.reading.includes(query)) return 460;

  // Long official fund names often contain a shorter registered name or alias.
  // Keep that existing lookup behavior, but rank it below direct substrings.
  if (entry.name.length >= 4 && query.includes(entry.name)) return 420;
  if (entry.aliases.some((alias) => alias.length >= 4 && query.includes(alias))) return 400;
  return 0;
}

export function searchSecurityIndex<T extends SearchableSecurity>(
  index: SecuritySearchIndex<T>,
  query: string,
  limit = 15,
): T[] {
  const normalizedQuery = normalizeSecuritySearchTerm(query);
  if (!normalizedQuery || limit <= 0) return [];

  const seen = new Set<string>();
  return index
    .map((entry) => ({ entry, score: matchScore(entry, normalizedQuery) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.order - right.entry.order)
    .flatMap(({ entry }) => {
      if (seen.has(entry.security.id)) return [];
      seen.add(entry.security.id);
      return [entry.security];
    })
    .slice(0, limit);
}

export function mergeSecuritySearchResults<T extends SearchableSecurity>(
  groups: readonly (readonly T[])[],
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const results: T[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const security of group) {
      // One row per listed security, whatever id spelling each source uses.
      const key = marketKey(security.id);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(security);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export function isCurrentSearchRequest(
  requestGeneration: number,
  requestQuery: string,
  currentGeneration: number,
  currentQuery: string,
): boolean {
  return requestGeneration === currentGeneration && requestQuery === currentQuery;
}
