import { createHash } from "node:crypto";
import { canonicalDomainSecurityId } from "@kabutora/domain";
import type { D1DatabaseLike } from "../../cloudflare-market-env";
import { readCachedHistory } from "../../server-market-store";
import { validateMarketPayload } from "../../market-payload-validation";
import { encodePublicHistory } from "../../public-history-codec";
import { readHistoryMonths } from "./observations";
import { publishResource } from "./publisher";
import type { CoordinatorStore } from "./coordinator-store";
type Part = {
    resource: `history/${string}`;
    revision: string;
    chunk_count: number;
};
function parseParts(value: string): Part[] {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 200 || !parsed.every(part => part && typeof part === "object" && typeof part.resource === "string" && /^history\/[a-z0-9.-]+$/u.test(part.resource) && /^[a-f0-9]{64}$/u.test(part.revision) && Number.isInteger(part.chunk_count) && part.chunk_count > 0 && part.chunk_count <= 5000))
        throw new Error("history_composition_invalid");
    return parsed as Part[];
}
/** At most three instruments are materialized in an invocation, one at a time. */
export async function publishHistoryParts(db: D1DatabaseLike, aliases: string[], store: CoordinatorStore): Promise<boolean | undefined> {
    const ids = [...new Set(aliases.map(canonicalDomainSecurityId))].sort();
    if (ids.length > 200)
        throw new Error("public_catalog_capacity");
    let pending: string[] = JSON.parse(store.metadata("history:pending") ?? JSON.stringify(ids));
    pending = [...new Set(pending.map(canonicalDomainSecurityId))].filter(id => ids.includes(id));
    store.setMetadata("history:pending", JSON.stringify(pending));
    for (const id of pending.slice(0, 3)) {
        const resource = `history/${id}` as const;
        const previous = await db.prepare("SELECT revision FROM market_publication_manifests WHERE resource=?").bind(resource).first<{
            revision: string;
        }>();
        const history = await readCachedHistory(db, [...new Set([id, ...aliases.filter(alias => canonicalDomainSecurityId(alias) === id)])]);
        const months = await readHistoryMonths(db, id);
        const bars = [...new Map([...history.bars, ...months].map(bar => [bar.date, { ...bar, securityId: id }])).values()].sort((a, b) => a.date.localeCompare(b.date));
        validateMarketPayload({ bars, corporateActions: history.corporateActions });
        const metadata = await db.prepare("SELECT inception_date FROM market_instrument_metadata WHERE instrument_id=?").bind(id).first<{
            inception_date: string | null;
        }>();
        const inceptionDate = metadata?.inception_date ?? Object.values(history.inceptionDates).sort()[0] ?? bars[0]?.date;
        const changed = await publishResource(db, resource, { historyBlocks: encodePublicHistory(bars), corporateActions: history.corporateActions, inceptionDates: inceptionDate ? { [id]: inceptionDate } : {} });
        if (changed && previous)
            store.setMetadata("history:gc", JSON.stringify([...new Set([...JSON.parse(store.metadata("history:gc") ?? "[]"), resource])]));
        pending = pending.filter(item => item !== id);
        store.setMetadata("history:pending", JSON.stringify(pending));
    }
    if (pending.length)
        return undefined;
    const manifests = await db.prepare("SELECT m.resource,m.revision,m.chunk_count,d.chunk_keys_json FROM market_publication_manifests m LEFT JOIN market_publication_descriptors d ON d.resource=m.resource AND d.revision=m.revision WHERE m.resource LIKE 'history/%' ORDER BY m.resource").all<Part & {
        chunk_keys_json: string | null;
    }>();
    const selected = new Map((manifests.results ?? []).map(part => [part.resource, part]));
    const missing = ids.filter(id => !selected.has(`history/${id}`));
    if (missing.length) {
        store.setMetadata("history:pending", JSON.stringify(missing));
        return undefined;
    }
    const parts = ids.map(id => { const { chunk_keys_json: _, ...part } = selected.get(`history/${id}`)!; return part; });
    parseParts(JSON.stringify(parts));
    const count = parts.reduce((sum, part) => sum + part.chunk_count, 0);
    // An empty public catalog still has one valid, empty history part.
    if (!count)
        return publishResource(db, "history", { bars: [], corporateActions: [], inceptionDates: {} });
    if (count > 5000)
        throw new Error("history_publication_capacity");
    const payload = JSON.stringify(parts), revision = createHash("sha256").update(payload).digest("hex"), publishedAt = new Date().toISOString();
    const current = await db.prepare("SELECT revision FROM market_publication_manifests WHERE resource='history'").first<{
        revision: string;
    }>();
    const changed = current?.revision !== revision;
    if (changed) {
        const keys = ids.flatMap(id => JSON.parse(selected.get(`history/${id}`)!.chunk_keys_json ?? "[]") as string[]);
        if (keys.length === count)
            await db.prepare("INSERT OR IGNORE INTO market_publication_descriptors VALUES ('history',?,?,?)").bind(revision, JSON.stringify(keys), publishedAt).run();
        await db.prepare("INSERT OR IGNORE INTO market_publication_generations VALUES ('history',?,?,?)").bind(revision, payload, publishedAt).run();
        await db.prepare("INSERT INTO market_publication_manifests VALUES ('history',?,?,?) ON CONFLICT(resource) DO UPDATE SET revision=excluded.revision,chunk_count=excluded.chunk_count,published_at=excluded.published_at").bind(revision, count, publishedAt).run();
    }
    const cutoff = new Date(Date.now() - 15 * 60000).toISOString();
    await db.prepare("DELETE FROM market_publication_generations WHERE resource='history' AND revision!=? AND created_at<?").bind(revision, cutoff).run();
    await db.prepare("DELETE FROM market_publication_descriptors WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM market_publication_manifests m WHERE m.resource=market_publication_descriptors.resource AND m.revision=market_publication_descriptors.revision) AND NOT EXISTS (SELECT 1 FROM market_publication_generations g WHERE g.resource=market_publication_descriptors.resource AND g.revision=market_publication_descriptors.revision)").bind(cutoff).run();
    const cleanup: string[] = JSON.parse(store.metadata("history:gc") ?? "[]");
    if (cleanup.length) {
        const retained = await db.prepare("SELECT payload_json FROM market_publication_generations WHERE resource='history'").all<{
            payload_json: string;
        }>();
        const live = (retained.results ?? []).flatMap(row => parseParts(row.payload_json));
        for (const resource of cleanup.slice(0, 3)) {
            const keep = [...new Set(live.filter(part => part.resource === resource).map(part => part.revision))];
            await db.prepare("DELETE FROM market_publication_chunks WHERE resource=? AND created_at<? AND revision NOT IN (SELECT value FROM json_each(?))").bind(resource, cutoff, JSON.stringify(keep)).run();
            cleanup.splice(cleanup.indexOf(resource), 1);
            store.setMetadata("history:gc", JSON.stringify(cleanup));
        }
    }
    return changed;
}
/** The immutable composition keeps old in-flight readers valid during publication. */
export async function readHistoryPart(db: D1DatabaseLike, revision: string, index: number): Promise<string | null | undefined> {
    const generation = await db.prepare("SELECT payload_json FROM market_publication_generations WHERE resource='history' AND revision=?").bind(revision).first<{
        payload_json: string;
    }>();
    if (!generation)
        return undefined;
    let offset = index;
    for (const part of parseParts(generation.payload_json)) {
        if (offset < part.chunk_count)
            return (await db.prepare("SELECT payload_json FROM market_publication_chunks WHERE resource=? AND revision=? AND chunk_index=?").bind(part.resource, part.revision, offset).first<{
                payload_json: string;
            }>())?.payload_json ?? null;
        offset -= part.chunk_count;
    }
    return null;
}
