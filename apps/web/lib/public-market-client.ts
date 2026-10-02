import { parsePublicMarketManifest } from "@kabutora/market-data";
import { canonicalDomainSecurityId, type IntradayBar } from "@kabutora/domain";
import { firebaseConfigured } from "./firebase-config";
import { getMarketAuthHeaders } from "./firebase-client";
import { validateMarketPayload } from "./market-payload-validation";
import { timeoutSignal } from "./operation-deadline";
import { clearPublicChunkMemory, readPublicChunkCache, writePublicChunkCache } from "./public-chunk-cache";
import { decodePublicIntraday } from "./public-intraday-codec";
import { decodePublicHistory, validatePublicHistory } from "./public-history-codec";
import { portfolioMarketSessions } from "./market-session";
import { sparkline24HourBars } from "./chart-presentation";
export const usesPublicMarketBackend = () => firebaseConfigured && process.env.NEXT_PUBLIC_KABUTORA_MARKET_BACKEND === "v2";
type Resource = "quotes" | "history" | "distributions" | "intraday";
type Entry = {
    revision: string;
    checkedAt: number;
    payload: Record<string, unknown>;
};
let cacheEpoch = 0;
let bypassUntil = 0;
const cache = new Map<Resource, Entry>();
const flights = new Map<Resource, Promise<Record<string, unknown>>>();
let historyManifest: {
    record: ReturnType<typeof parsePublicMarketManifest>;
    checkedAt: number;
    generatedAt: string;
} | undefined;
let historyManifestFlight: Promise<NonNullable<typeof historyManifest>> | undefined;
const chunkFlights = new Map<string, Promise<Record<string, unknown>>>();
const CHUNK_CONCURRENCY = 6;
async function boundedChunkText(response: Response): Promise<string> {
    if (!response.body)
        throw new Error("market_chunk_empty");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, text = "";
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.byteLength;
            if (bytes > 240000) {
                await reader.cancel();
                throw new Error("market_chunk_too_large");
            }
            text += decoder.decode(part.value, { stream: true });
        }
        return text + decoder.decode();
    }
    finally {
        reader.releaseLock();
    }
}
async function historyGeneration() {
    if (historyManifest && Date.now() - historyManifest.checkedAt < 30000)
        return historyManifest;
    if (historyManifestFlight)
        return historyManifestFlight;
    const epoch = cacheEpoch;
    const task = (async () => {
        const recent = historyManifest;
        const response = await fetch("/api/market/data?resource=history", { cache: "no-store", headers: { ...await getMarketAuthHeaders(), ...(Date.now() < bypassUntil ? { "Cache-Control": "no-cache" } : {}), ...(recent ? { "If-None-Match": `"${recent.record.revision}"` } : {}) }, signal: timeoutSignal(8000) });
        if (epoch !== cacheEpoch)
            throw new Error("market_session_changed");
        if (response.status === 304 && recent) {
            recent.checkedAt = Date.now();
            recent.generatedAt = response.headers.get("X-Market-Server-Time") ?? new Date().toISOString();
            return recent;
        }
        if (!response.ok) {
            if (recent && response.status === 503)
                return recent;
            throw new Error("market_publication_unavailable");
        }
        const record = parsePublicMarketManifest(await response.json());
        if (record.resource !== "history")
            throw new Error("market_manifest_invalid");
        return historyManifest = { record, checkedAt: Date.now(), generatedAt: response.headers.get("X-Market-Server-Time") ?? new Date().toISOString() };
    })().finally(() => {
        if (historyManifestFlight === task)
            historyManifestFlight = undefined;
    });
    historyManifestFlight = task;
    return task;
}
async function publicChunk(resource: Resource, revision: string, index: number, headers: Record<string, string>, expectedHash?: string) {
    const key = `${resource}:${expectedHash ?? `${revision}:${index}`}`;
    const flight = chunkFlights.get(key);
    if (flight)
        return flight;
    const task = (async () => {
        const checksum = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        let text = await readPublicChunkCache(key);
        if (text !== undefined && expectedHash && await checksum(text) !== expectedHash)
            text = undefined;
        if (text === undefined) {
            const response = await fetch(`/api/market/data?resource=${resource}&revision=${revision}&chunk=${index}`, { cache: "no-store", headers, signal: timeoutSignal(8000) });
            if (!response.ok)
                throw new Error("market_chunk_unavailable");
            text = await boundedChunkText(response);
        }
        if (expectedHash && await checksum(text) !== expectedHash)
            throw new Error("market_chunk_checksum_mismatch");
        const value: unknown = JSON.parse(text);
        validateMarketPayload(value);
        const chunk = value as Record<string, unknown>;
        if (chunk.historyBlocks !== undefined) {
            if (!Array.isArray(chunk.historyBlocks))
                throw new Error("market_history_blocks_invalid");
            validatePublicHistory(chunk.historyBlocks);
        }
        if (chunk.intradayBlocks !== undefined) {
            chunk.bars = decodePublicIntraday(chunk.intradayBlocks);
            delete chunk.intradayBlocks;
        }
        // Persistence must not delay rendering or the next download wave.
        void writePublicChunkCache(key, text).catch(() => undefined);
        return chunk;
    })().finally(() => chunkFlights.delete(key));
    chunkFlights.set(key, task);
    return task;
}
/** Traverse the same public chunks; only selected bars are expanded in memory. */
async function loadPackedHistory(localIds?: ReadonlySet<string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const generation = await historyGeneration(), headers = await getMarketAuthHeaders();
    const selected = (id: unknown) => localIds === undefined || localIds.has(canonicalDomainSecurityId(String(id)));
    const bars: ReturnType<typeof decodePublicHistory> = [];
    const corporateActions: unknown[] = [], inceptionDates: Record<string, unknown> = {};
    const deadline = Date.now() + 120000;
    for (let offset = 0; offset < generation.record.chunk_count; offset += CHUNK_CONCURRENCY) {
        if (Date.now() > deadline)
            throw new Error("market_history_deadline");
        if (signal?.aborted)
            throw signal.reason;
        const chunks = await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, generation.record.chunk_count - offset) }, (_, i) => publicChunk("history", generation.record.revision, offset + i, headers, generation.record.chunk_keys?.[offset + i])));
        for (const chunk of chunks) {
            if (Array.isArray(chunk.historyBlocks))
                for (const block of chunk.historyBlocks) {
                    if (block && typeof block === "object" && selected(block.securityId))
                        bars.push(...decodePublicHistory([block]));
                }
            else if (Array.isArray(chunk.bars))
                bars.push(...(chunk.bars as ReturnType<typeof decodePublicHistory>).filter(bar => selected(bar.securityId)));
            if (Array.isArray(chunk.corporateActions))
                corporateActions.push(...chunk.corporateActions.filter(action => selected(action.securityId)));
            if (chunk.inceptionDates && typeof chunk.inceptionDates === "object")
                for (const [id, date] of Object.entries(chunk.inceptionDates))
                    if (selected(id))
                        inceptionDates[id] = date;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    bars.sort((a, b) => a.securityId.localeCompare(b.securityId) || a.date.localeCompare(b.date));
    return { bars, corporateActions, inceptionDates, generatedAt: generation.generatedAt };
}
export function clearPublicMarketCache() { cacheEpoch++; bypassUntil = Date.now() + 5000; cache.clear(); flights.clear(); historyManifest = undefined; historyManifestFlight = undefined; clearPublicChunkMemory(); }
/** Fetch the group-wide manifest and every chunk, never a user's symbol subset. */
export async function loadPublicMarketResource(resource: Resource, localIds?: ReadonlySet<string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (resource === "history")
        return loadPackedHistory(localIds, signal);
    const recent = cache.get(resource);
    if (recent && Date.now() - recent.checkedAt < 30000)
        return recent.payload;
    const existing = flights.get(resource);
    if (existing)
        return existing;
    const epoch = cacheEpoch;
    const task = (async () => {
        const headers = await getMarketAuthHeaders();
        const response = await fetch(`/api/market/data?resource=${resource}`, { cache: "no-store", headers: { ...headers, ...(Date.now() < bypassUntil ? { "Cache-Control": "no-cache" } : {}), ...(recent ? { "If-None-Match": `"${recent.revision}"` } : {}) }, signal: timeoutSignal(8000) });
        if (epoch !== cacheEpoch)
            throw new Error("market_session_changed");
        if (response.status === 304 && recent) {
            recent.checkedAt = Date.now();
            recent.payload.generatedAt = response.headers.get("X-Market-Server-Time") ?? new Date().toISOString();
            return recent.payload;
        }
        if (!response.ok) {
            if (recent && response.status === 503)
                return recent.payload;
            throw new Error("market_publication_unavailable");
        }
        const record = parsePublicMarketManifest(await response.json());
        if (record.resource !== resource)
            throw new Error("market_manifest_invalid");
        const payload: Record<string, unknown> = {};
        // A bounded pool downloads the same common chunks for every member.
        for (let offset = 0; offset < record.chunk_count; offset += CHUNK_CONCURRENCY) {
            const chunks = await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, record.chunk_count - offset) }, async (_, i) => {
                const decoded = await publicChunk(resource, record.revision, offset + i, headers, record.chunk_keys?.[offset + i]);
                if (decoded.historyBlocks !== undefined) {
                    decoded.bars = decodePublicHistory(decoded.historyBlocks);
                    delete decoded.historyBlocks;
                }
                return decoded;
            }));
            for (const chunk of chunks)
                for (const [name, value] of Object.entries(chunk)) {
                    if (Array.isArray(value)) {
                        const rows = (Array.isArray(payload[name]) ? payload[name] : []) as unknown[];
                        rows.push(...value);
                        payload[name] = rows;
                    }
                    else if (value && typeof value === "object") {
                        payload[name] = { ...(payload[name] && typeof payload[name] === "object" ? payload[name] as object : {}), ...value };
                    }
                    else
                        payload[name] = value;
                }
        }
        payload.generatedAt = response.headers.get("X-Market-Server-Time") ?? new Date().toISOString();
        if (epoch !== cacheEpoch)
            throw new Error("market_session_changed");
        cache.set(resource, { revision: record.revision, checkedAt: Date.now(), payload });
        return payload;
    })().finally(() => {
        if (flights.get(resource) === task)
            flights.delete(resource);
    });
    flights.set(resource, task);
    return task;
}
/** Compatibility adapter: private selection and date filtering happen locally. */
export async function fetchMarketResponse(input: string, init?: RequestInit): Promise<Response> {
    if (!usesPublicMarketBackend())
        return fetch(input, init);
    const url = new URL(input, "https://local.invalid");
    const name = url.pathname.split("/").at(-1);
    if (!["quotes", "benchmarks", "history", "distributions", "intraday"].includes(name ?? ""))
        throw new Error("market_resource_invalid");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const selection = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const ids = String(selection.securityIds ?? url.searchParams.get("securityIds") ?? "").split(",").filter(Boolean);
    const canonical = new Set(ids.map(canonicalDomainSecurityId));
    const resource: Resource = name === "benchmarks" ? "quotes" : name as Resource;
    const all = await loadPublicMarketResource(resource, canonical, init?.signal ?? undefined);
    const payload: Record<string, unknown> = { ...all, failures: [], marketSessions: portfolioMarketSessions("ALL") };
    for (const field of ["quotes", "bars", "corporateActions", "distributions", "coverage"]) {
        const rows = all[field];
        if (!Array.isArray(rows))
            continue;
        payload[field] = rows.filter((row: unknown) => row && typeof row === "object" && (!canonical.size || canonical.has(canonicalDomainSecurityId(String((row as Record<string, unknown>).securityId)))));
    }
    if (name === "quotes" && selection.includeIntraday !== false) {
        const intraday = await loadPublicMarketResource("intraday");
        payload.intraday = (Array.isArray(intraday.bars) ? intraday.bars : []).filter((row: {
            securityId: string;
        }) => canonical.has(canonicalDomainSecurityId(row.securityId)));
    }
    if (name !== "distributions") {
        const rows = payload[name === "quotes" ? "quotes" : "bars"];
        const returned = new Set((Array.isArray(rows) ? rows : []).map((row: {
            securityId: string;
        }) => canonicalDomainSecurityId(row.securityId))).size;
        payload.coverage = { requested: ids.length, returned, fresh: 0, stale: 0, suspect: 0 };
        if (returned < canonical.size)
            payload.failures = ids.filter((id) => !(Array.isArray(rows) ? rows : []).some((row: {
                securityId: string;
            }) => canonicalDomainSecurityId(row.securityId) === canonicalDomainSecurityId(id))).map((id) => ({ securityId: id, symbol: id, message: "market_catalog_coverage_pending" }));
    }
    if (name === "intraday") {
        let bars = Array.isArray(payload.bars) ? payload.bars as IntradayBar[] : [];
        if (url.searchParams.get("market") === "US")
            bars = ids.flatMap(id => sparkline24HourBars(bars.filter(bar => canonicalDomainSecurityId(bar.securityId) === canonicalDomainSecurityId(id)), { exchangeMic: "XNAS", currency: "USD", country: "US" }));
        else
            bars = bars.filter(bar => bar.session === "pts_day" || bar.session === "pts_night" || bar.provider === "japannext_pts_public");
        payload.bars = bars;
        const sessions = ids.map((id) => { const points = bars.filter((bar) => canonicalDomainSecurityId(bar.securityId) === canonicalDomainSecurityId(id)); return { securityId: id, currentSessionDate: points.at(-1)?.timestamp.slice(0, 10) ?? "", currentPoints: points.length, previousSessionDate: null, previousPoints: 0, ready: points.length >= 2 }; });
        payload.sessions = sessions;
        payload.revision = cache.get(resource)?.revision ?? null;
        payload.nextCursor = payload.revision;
        payload.coverage = { requested: ids.length, ready: sessions.filter((session) => session.ready).length, currentReady: sessions.filter((session) => session.ready).length };
    }
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
/** Only an explicit search selection may expand the public group catalog. */
export async function registerPublicMarketSelection(securityId: string): Promise<boolean> {
    if (!usesPublicMarketBackend())
        return true;
    const response = await fetch("/api/market/registry", { method: "POST", cache: "no-store", headers: { ...await getMarketAuthHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ securityIds: [securityId], mode: "merge" }), signal: timeoutSignal(8000) });
    if (response.ok)
        clearPublicMarketCache();
    return response.ok;
}
