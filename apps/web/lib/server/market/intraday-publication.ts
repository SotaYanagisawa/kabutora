import { canonicalDomainSecurityId, type IntradayBar } from "@kabutora/domain";
import type { D1DatabaseLike } from "../../cloudflare-market-env";
import type { PublicSecurityDescriptor } from "../../server-market-types";
import { encodePublicIntraday, type PublicIntradayBlock } from "../../public-intraday-codec";
import { validateMarketPayload } from "../../market-payload-validation";
import { sparkline24HourBars } from "../../chart-presentation";
import { finiteDecimal, isRecord } from "../../validation-primitives";
/** Frame pages and regular rows are parsed separately; no catalog-sized bar graph. */
export async function buildPublicIntraday(db: D1DatabaseLike, securities: PublicSecurityDescriptor[]) {
    const selected = new Map(securities.map(security => [canonicalDomainSecurityId(security.securityId), security]));
    if (selected.size > 200)
        throw new Error("public_catalog_capacity");
    const pts = new Map<string, PublicIntradayBlock[]>();
    const latest = await db.prepare("SELECT session_key FROM market_pts_frames ORDER BY observed_minute DESC LIMIT 1").first<{
        session_key: string;
    }>();
    if (latest) {
        for (let offset = 0; offset < 1500; offset += 400) {
            const page = await db.prepare("SELECT venue_code,observed_minute,payload_json FROM market_pts_frames WHERE session_key=? ORDER BY observed_minute LIMIT ? OFFSET ?")
                .bind(latest.session_key, Math.min(400, 1500 - offset), offset).all<{
                venue_code: string;
                observed_minute: string;
                payload_json: string;
            }>();
            for (const row of page.results ?? []) {
                let payload: unknown;
                try {
                    payload = JSON.parse(row.payload_json);
                }
                catch {
                    continue;
                }
                if (!isRecord(payload))
                    continue;
                for (const [symbol, tuple] of Object.entries(payload)) {
                    const id = `sec-${symbol.toLowerCase()}`;
                    if (!selected.has(id) || !Array.isArray(tuple) || !finiteDecimal(tuple[0], true))
                        continue;
                    const blocks = pts.get(id) ?? [];
                    const session = row.venue_code === "JNX_DAY" ? "pts_day" : "pts_night";
                    let block = blocks.at(-1);
                    if (!block || block.session !== session || block.rows.length >= 512) {
                        block = { securityId: id, provider: "japannext_pts_public", venueCode: row.venue_code, session, rows: [] };
                        blocks.push(block);
                    }
                    block.rows.push([row.observed_minute, tuple[0]]);
                    pts.set(id, blocks);
                }
            }
            if ((page.results?.length ?? 0) < 400)
                break;
        }
    }
    const blocks: PublicIntradayBlock[] = [];
    const ids = [...selected.keys()];
    // Resolve old aliases on the indexed registry, while v2 rows use canonical IDs.
    for (let offset = 0; offset < ids.length; offset += 20) {
        const group = ids.slice(offset, offset + 20);
        const rows = await db.prepare(`SELECT security_id,payload_json FROM market_intraday WHERE security_id IN (SELECT value FROM json_each(?)) OR security_id IN (SELECT security_id FROM market_securities WHERE enabled=1 AND security_id IN (SELECT value FROM json_each(?)))`)
            .bind(JSON.stringify(group), JSON.stringify(securities.filter(security => group.includes(canonicalDomainSecurityId(security.securityId))).map(security => security.securityId)))
            .all<{
            security_id: string;
            payload_json: string;
        }>();
        const regular = new Map<string, IntradayBar[]>();
        for (const row of rows.results ?? []) {
            try {
                const value: unknown = JSON.parse(row.payload_json);
                validateMarketPayload({ intraday: value });
                const id = canonicalDomainSecurityId(row.security_id);
                regular.set(id, [...(regular.get(id) ?? []), ...value as IntradayBar[]]);
            }
            catch { /* Invalid public rows are omitted and repaired independently. */ }
        }
        for (const id of group) {
            const ptsPoints: IntradayBar[] = [];
            for (const block of pts.get(id) ?? [])
                for (const [timestamp, price] of block.rows) {
                    const { rows: _, ...metadata } = block;
                    ptsPoints.push({ ...metadata, timestamp, price });
                }
            const security = selected.get(id)!;
            blocks.push(...encodePublicIntraday(sparkline24HourBars(ptsPoints, { exchangeMic: security.exchangeMic, currency: security.currency })));
            const points = new Map<string, IntradayBar>();
            for (const bar of regular.get(id) ?? [])
                points.set(bar.timestamp.slice(0, 16), { ...bar, securityId: id });
            const bars = sparkline24HourBars([...points.values()], { exchangeMic: security.exchangeMic, currency: security.currency });
            blocks.push(...encodePublicIntraday(bars));
            pts.delete(id);
        }
    }
    return { intradayBlocks: blocks };
}
