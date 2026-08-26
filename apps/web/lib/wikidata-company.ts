import { companyDisplayName } from "./company-name";

type CompanyAliasRequest = {
  symbol: string;
  exchangeMic: string;
  shortName?: string | null;
  longName?: string | null;
};

export type CompanyAlias = {
  name: string;
  source: "wikidata";
  entityId: string;
  confidence: "verified_legal_name";
};

type WikidataSearchPayload = {
  search?: WikidataSearchCandidate[];
};

type WikidataSearchCandidate = {
  id?: string;
  label?: string;
  aliases?: string[];
  match?: { text?: string };
};

type CacheEntry = { value: CompanyAlias | null; expiresAt: number };

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "Kabutora/1.0 personal-portfolio-tracker (company-name metadata)";
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CompanyAlias | null>>();

function clean(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function comparable(value: string | null | undefined) {
  return companyDisplayName({ name: clean(value), country: "US" })
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/giu, "")
    .toLocaleLowerCase("en-US");
}

async function wikidataRequest<T>(params: Record<string, string>) {
  const url = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries({ format: "json", origin: "*", ...params })) url.searchParams.set(key, value);
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`Wikidata returned ${response.status}`);
  return await response.json() as T;
}

async function searchCandidates(query: string) {
  const payload = await wikidataRequest<WikidataSearchPayload>({
    action: "wbsearchentities",
    search: query,
    language: "en",
    uselang: "en",
    type: "item",
    limit: "6",
  });
  return (payload.search ?? []).filter((item) => /^Q[1-9][0-9]*$/u.test(item.id ?? ""));
}

function verifiedAlias(candidate: WikidataSearchCandidate, request: CompanyAliasRequest) {
  if (!candidate.id) return null;
  // The quote provider binds the ticker to its legal name. Require Wikidata to
  // match that full legal name exactly before accepting its common label.
  const expectedLegalName = comparable(request.longName);
  if (!expectedLegalName) return null;
  const candidateNames = [candidate.label, candidate.match?.text, ...(candidate.aliases ?? [])];
  if (!candidateNames.some((name) => comparable(name) === expectedLegalName)) return null;

  const label = clean(candidate.label);
  const symbol = request.symbol.toUpperCase();
  const current = companyDisplayName({ name: request.longName || request.shortName || symbol, shortName: request.shortName, longName: request.longName, country: "US", exchangeMic: request.exchangeMic });
  const name = companyDisplayName({ name: label, country: "US", exchangeMic: request.exchangeMic });
  if (!name || name.toUpperCase() === symbol || name.length >= current.length || name.length > 32) return null;
  return { name, source: "wikidata", entityId: candidate.id, confidence: "verified_legal_name" } satisfies CompanyAlias;
}

async function resolveUncached(request: CompanyAliasRequest) {
  const terms = [...new Set([clean(request.longName), clean(request.shortName)].filter((term) => term && term.toUpperCase() !== request.symbol.toUpperCase()))];
  for (const term of terms.slice(0, 2)) {
    const candidates = await searchCandidates(term);
    for (const candidate of candidates) {
      const alias = verifiedAlias(candidate, request);
      if (alias) return alias;
    }
  }
  return null;
}

export function shouldResolveCompanyAlias(request: CompanyAliasRequest) {
  const current = companyDisplayName({ name: request.longName || request.shortName || request.symbol, shortName: request.shortName, longName: request.longName, country: "US", exchangeMic: request.exchangeMic });
  return current.length > 18;
}

export async function resolveWikidataCompanyAlias(request: CompanyAliasRequest) {
  if (!shouldResolveCompanyAlias(request)) return null;
  const key = [request.symbol.toUpperCase(), request.exchangeMic.toUpperCase(), comparable(request.longName), comparable(request.shortName)].join("|");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let task = inFlight.get(key);
  if (!task) {
    task = resolveUncached(request).catch(() => null);
    inFlight.set(key, task);
  }
  try {
    const value = await task;
    cache.set(key, { value, expiresAt: Date.now() + (value ? SUCCESS_TTL_MS : MISS_TTL_MS) });
    return value;
  } finally {
    inFlight.delete(key);
  }
}

export function clearWikidataCompanyAliasCache() {
  cache.clear();
  inFlight.clear();
}
