import { PUBLIC_MARKET_RESOURCES, type MarketResource, type PublicMarketManifest } from "@kabutora/market-data";
import { canonicalDomainSecurityId } from "@kabutora/domain";
import { buildPublicIntraday } from "./intraday-publication";
import type { ServerBenchmark, ServerRemoteQuote } from "../../server-market-types";
import { readObservations } from "./observations";
import { createHash } from "node:crypto";
import type { D1DatabaseLike } from "../../cloudflare-market-env";
import { listEnabledMarketSecurities, readCachedDistributions, readStoredQuotes } from "../../server-market-store";
import { validateMarketPayload } from "../../market-payload-validation";
import type { CoordinatorStore } from "./coordinator-store";
import { publishHistoryParts, readHistoryPart } from "./history-publication";
import { currentMarketRequestContext } from "../../server-market-request-context";
export const PUBLIC_RESOURCES = PUBLIC_MARKET_RESOURCES;
export type PublicResource = MarketResource;
export type PublicManifest = PublicMarketManifest;
const MAX_CHUNK_BYTES = 240000;
const encoder = new TextEncoder();
/** Bound rows before D1 transport. All members fetch the same chunks and filter locally. */
export function publicPayloadChunks(payload: Record<string, unknown>): string[] {
    const metadata = Object.fromEntries(Object.entries(payload).filter(([, value]) => !Array.isArray(value)));
    const chunks: string[] = [];
    let current: Record<string, unknown> = { ...metadata };
    let bytes = encoder.encode(JSON.stringify(current)).length;
    for (const [name, value] of Object.entries(payload)) {
        if (!Array.isArray(value))
            continue;
        for (const item of value) {
            const size = encoder.encode(JSON.stringify(item)).length + name.length + 8;
            if (size > MAX_CHUNK_BYTES / 2)
                throw new Error("market_public_row_too_large");
            if (bytes + size > MAX_CHUNK_BYTES) {
                chunks.push(JSON.stringify(current));
                current = { ...metadata };
                bytes = encoder.encode(JSON.stringify(current)).length;
            }
            const items = (current[name] ?? []) as unknown[];
            items.push(item);
            current[name] = items;
            bytes += size;
        }
        if (!value.length && current[name] === undefined)
            current[name] = [];
    }
    chunks.push(JSON.stringify(current));
    if (chunks.some((chunk) => encoder.encode(chunk).length > MAX_CHUNK_BYTES))
        throw new Error("market_public_chunk_too_large");
    return chunks;
}
export async function publishResource(db: D1DatabaseLike, resource: PublicResource | `history/${string}`, payload: Record<string, unknown>) {
    if (resource !== "catalog")
        validateMarketPayload(payload);
    const chunks = publicPayloadChunks(payload);
    const revision = createHash("sha256").update(chunks.join("\n")).digest("hex");
    const chunkKeys = chunks.map(chunk => createHash("sha256").update(chunk).digest("hex"));
    await db.prepare("INSERT OR IGNORE INTO market_publication_descriptors VALUES (?,?,?,?)").bind(resource, revision, JSON.stringify(chunkKeys), new Date().toISOString()).run();
    const current = await db.prepare("SELECT revision FROM market_publication_manifests WHERE resource=?").bind(resource).first<{
        revision: string;
    }>();
    if (current?.revision === revision)
        return false;
    const publishedAt = new Date().toISOString();
    const existing = await db.prepare("SELECT MAX(chunk_index) AS last_chunk FROM market_publication_chunks WHERE resource=? AND revision=?").bind(resource, revision).first<{
        last_chunk: number | null;
    }>();
    for (let offset = (existing?.last_chunk ?? -1) + 1; offset < chunks.length; offset += 5) {
        const rows = chunks.slice(offset, offset + 5).map((chunk, index) => [resource, revision, offset + index, chunk, publishedAt]);
        await db.prepare(`INSERT OR IGNORE INTO market_publication_chunks(resource,revision,chunk_index,payload_json,created_at) VALUES ${rows.map(() => "(?,?,?,?,?)").join(",")}`).bind(...rows.flat()).run();
    }
    // Readers cannot see the new generation until every immutable chunk exists.
    await db.prepare(`INSERT INTO market_publication_manifests VALUES (?,?,?,?) ON CONFLICT(resource) DO UPDATE SET revision=excluded.revision,chunk_count=excluded.chunk_count,published_at=excluded.published_at`).bind(resource, revision, chunks.length, publishedAt).run();
    // A reader gets a 15-minute grace period to finish the previous generation.
    // Content-addressed revisions must not accumulate indefinitely on free D1.
    if (!resource.startsWith("history/"))
        await db.prepare("DELETE FROM market_publication_chunks WHERE resource=? AND revision!=? AND created_at<?").bind(resource, revision, new Date(Date.now() - 15 * 60000).toISOString()).run();
    return true;
}
export async function publishMarketResources(db: D1DatabaseLike, kind: string, store?: CoordinatorStore): Promise<boolean | undefined> {
    const securities = await listEnabledMarketSecurities(db);
    const ids = securities.map((security) => security.securityId);
    let changed = await publishResource(db, "catalog", { securities });
    if (["quotes", "benchmarks", "pts", "all"].includes(kind)) {
        const allowed = new Set(ids.map(canonicalDomainSecurityId));
        const quotes = new Map(await readStoredQuotes(db));
        for (const [id, quote] of await readObservations(db)) {
            const previous = quotes.get(id);
            if (!previous || quote.marketTimestamp >= previous.marketTimestamp)
                quotes.set(id, quote);
        }
        const canonicalQuotes = new Map<string, ServerRemoteQuote>();
        for (const quote of quotes.values()) {
            const id = canonicalDomainSecurityId(quote.securityId);
            if (!allowed.has(id))
                continue;
            const previous = canonicalQuotes.get(id);
            if (!previous || quote.marketTimestamp > previous.marketTimestamp || (quote.marketTimestamp === previous.marketTimestamp && quote.fetchedAt >= previous.fetchedAt))
                canonicalQuotes.set(id, { ...quote, securityId: id });
        }
        const result = await db.prepare("SELECT payload_json FROM market_benchmarks ORDER BY benchmark_id").all<{
            payload_json: string;
        }>();
        const benchmarks: ServerBenchmark[] = [];
        for (const row of result.results ?? []) {
            try {
                const value: unknown = JSON.parse(row.payload_json);
                validateMarketPayload({ benchmarks: [value] });
                benchmarks.push(value as ServerBenchmark);
            }
            catch { }
        }
        changed = (await publishResource(db, "quotes", { quotes: [...canonicalQuotes.values()], benchmarks, coverage: { registered: allowed.size, quoted: canonicalQuotes.size } })) || changed;
        if (kind !== "benchmarks")
            changed = (await publishResource(db, "intraday", await buildPublicIntraday(db, securities))) || changed;
    }
    if (["history", "all"].includes(kind)) {
        if (!store)
            throw new Error("history_coordinator_required");
        const historyChanged = await publishHistoryParts(db, ids, store);
        if (historyChanged === undefined)
            return undefined;
        changed = historyChanged || changed;
    }
    if (["distributions", "all"].includes(kind)) {
        const distributions = await readCachedDistributions(db, ids);
        changed = (await publishResource(db, "distributions", { ...distributions })) || changed;
    }
    return changed;
}
/** Called after authentication by the native route. Cache entries contain only public data. */
export async function readPublicResource(db: D1DatabaseLike, request: Request): Promise<Response> {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some(key => !["resource", "revision", "chunk"].includes(key)))
        return Response.json({ error: "invalid_public_query" }, { status: 400 });
    const edge = typeof caches === "undefined" ? undefined : (caches as CacheStorage & {
        default?: Cache;
    }).default;
    if (!edge)
        return readStoredPublicResource(db, request);
    const key = new Request(url.toString()), immutable = url.searchParams.has("revision");
    const cached = await edge.match(key).catch(() => undefined);
    const decorate = (response: Response, stale = false) => {
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "private, no-store");
        headers.set("X-Market-Server-Time", new Date().toISOString());
        headers.delete("X-Market-Cached-At");
        if (stale)
            headers.set("X-Market-Stale", "true");
        if (response.headers.get("ETag") === request.headers.get("If-None-Match"))
            return new Response(null, { status: 304, headers });
        return new Response(response.body, { status: response.status, headers });
    };
    const age = cached ? Date.now() - Date.parse(cached.headers.get("X-Market-Cached-At") ?? "") : Infinity;
    if (cached && (immutable || age < 30000) && request.headers.get("Cache-Control") !== "no-cache")
        return decorate(cached);
    let response: Response;
    try {
        response = await readStoredPublicResource(db, request);
    }
    catch {
        response = Response.json({ error: "market_publication_unavailable" }, { status: 503, headers: { "Retry-After": "30", "Cache-Control": "private, no-store" } });
    }
    if (response.status === 503 && cached)
        return decorate(cached, true);
    if (response.status === 200) {
        const copy = response.clone(), headers = new Headers(copy.headers);
        headers.set("Cache-Control", "public, max-age=86400");
        headers.set("X-Market-Cached-At", new Date().toISOString());
        const write = edge.put(key, new Response(copy.body, { status: 200, headers })).catch(() => undefined);
        const context = currentMarketRequestContext();
        if (context?.ctx)
            context.ctx.waitUntil(write);
        else
            await write;
    }
    return response;
}
async function readStoredPublicResource(db: D1DatabaseLike, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const resource = url.searchParams.get("resource");
    const headers = { "Cache-Control": "private, no-store", "X-Market-Server-Time": new Date().toISOString() };
    if (!PUBLIC_RESOURCES.includes(resource as PublicResource))
        return Response.json({ error: "invalid_public_resource" }, { status: 400, headers });
    const revision = url.searchParams.get("revision"), index = url.searchParams.get("chunk");
    if (!revision && !index) {
        const manifest = await db.prepare("SELECT m.resource,m.revision,m.chunk_count,m.published_at,d.chunk_keys_json FROM market_publication_manifests m LEFT JOIN market_publication_descriptors d ON d.resource=m.resource AND d.revision=m.revision WHERE m.resource=?").bind(resource).first<PublicManifest & {
            chunk_keys_json: string | null;
        }>();
        if (!manifest)
            return Response.json({ error: "market_publication_pending" }, { status: 503, headers: { ...headers, "Retry-After": "30" } });
        const etag = `"${manifest.revision}"`;
        if (request.headers.get("If-None-Match") === etag)
            return new Response(null, { status: 304, headers: { ...headers, ETag: etag, "X-Market-Published-At": manifest.published_at } });
        const { chunk_keys_json, ...fields } = manifest;
        return Response.json({ ...fields, ...(chunk_keys_json ? { chunk_keys: JSON.parse(chunk_keys_json) } : {}) }, { headers: { ...headers, ETag: etag, "X-Market-Published-At": manifest.published_at } });
    }
    if (!revision || !/^[a-f0-9]{64}$/u.test(revision) || !index || !/^\d{1,4}$/u.test(index))
        return Response.json({ error: "invalid_public_chunk" }, { status: 400, headers });
    if (resource === "history") {
        const part = await readHistoryPart(db, revision, Number(index));
        if (part !== undefined)
            return part === null ? Response.json({ error: "market_publication_expired" }, { status: 409, headers }) : new Response(part, { headers: { ...headers, "Content-Type": "application/json", ETag: `"${revision}-${index}"` } });
    }
    const row = await db.prepare("SELECT payload_json FROM market_publication_chunks WHERE resource=? AND revision=? AND chunk_index=?").bind(resource, revision, Number(index)).first<{
        payload_json: string;
    }>();
    if (!row)
        return Response.json({ error: "market_publication_expired" }, { status: 409, headers });
    return new Response(row.payload_json, { headers: { ...headers, "Content-Type": "application/json", ETag: `"${revision}-${index}"` } });
}
