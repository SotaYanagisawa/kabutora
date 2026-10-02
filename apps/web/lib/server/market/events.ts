import { Decimal } from "@kabutora/domain";
import type { D1DatabaseLike } from "../../cloudflare-market-env";
import type { MarketHistoryBatchResult } from "../../server-market-types";
import { validateMarketPayload } from "../../market-payload-validation";
/** Batch public issuer events with JSON table input: one binding per 100 rows. */
export async function persistPublicEvents(db: D1DatabaseLike, result: MarketHistoryBatchResult) {
    validateMarketPayload(result);
    for (let offset = 0; offset < result.distributions.length; offset += 100) {
        const events = result.distributions.slice(offset, offset + 100).map((event) => ({ event, priority: event.confidence === "manual" ? 4 : event.confidence === "official" ? 3 : event.confidence === "reported" ? 2 : 1 }));
        await db.prepare(`INSERT INTO market_distributions(event_id,security_id,event_type,effective_date,payment_date,amount_per_unit,distribution_unit,currency,source_priority,payload_json,updated_at)
    SELECT json_extract(value,'$.event.id'),json_extract(value,'$.event.securityId'),json_extract(value,'$.event.type'),substr(COALESCE(json_extract(value,'$.event.exDate'),json_extract(value,'$.event.recordDate'),json_extract(value,'$.event.paymentDate')),1,10),json_extract(value,'$.event.paymentDate'),json_extract(value,'$.event.amountPerUnit'),COALESCE(json_extract(value,'$.event.distributionUnit'),'1'),json_extract(value,'$.event.currency'),json_extract(value,'$.priority'),json_extract(value,'$.event'),?
    FROM json_each(?) WHERE COALESCE(json_extract(value,'$.event.exDate'),json_extract(value,'$.event.recordDate'),json_extract(value,'$.event.paymentDate')) IS NOT NULL
    ON CONFLICT(event_id) DO UPDATE SET event_type=excluded.event_type,effective_date=excluded.effective_date,payment_date=excluded.payment_date,amount_per_unit=excluded.amount_per_unit,distribution_unit=excluded.distribution_unit,currency=excluded.currency,source_priority=excluded.source_priority,payload_json=excluded.payload_json,updated_at=excluded.updated_at
    WHERE excluded.source_priority>=market_distributions.source_priority AND excluded.payload_json!=market_distributions.payload_json`).bind(result.generatedAt, JSON.stringify(events)).run();
    }
    for (let offset = 0; offset < result.corporateActions.length; offset += 100) {
        await db.prepare(`INSERT INTO market_corporate_actions(action_id,security_id,payload_json,effective_date,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.securityId'),value,json_extract(value,'$.effectiveDate'),? FROM json_each(?) WHERE 1
    ON CONFLICT(action_id) DO UPDATE SET payload_json=excluded.payload_json,effective_date=excluded.effective_date,updated_at=excluded.updated_at WHERE payload_json!=excluded.payload_json`).bind(result.generatedAt, JSON.stringify(result.corporateActions.slice(offset, offset + 100))).run();
    }
    for (const id of result.coveredSecurityIds) {
        const events = result.distributions.filter((event) => event.securityId === id);
        const count = events.filter((event) => new Decimal(event.amountPerUnit).gt(0)).length;
        await db.prepare(`INSERT INTO market_distribution_coverage(security_id,covered_from,checked_through,checked_at,event_count,status,source_provider,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(security_id) DO UPDATE SET covered_from=MIN(covered_from,excluded.covered_from),checked_through=excluded.checked_through,checked_at=excluded.checked_at,event_count=excluded.event_count,status=excluded.status,source_provider=COALESCE(excluded.source_provider,source_provider),updated_at=excluded.updated_at`).bind(id, result.requestedFrom, result.generatedAt.slice(0, 10), result.generatedAt, count, result.requestedFrom <= "2000-01-01" ? count ? "ready" : "no_events" : "partial", events[0]?.sourceProvider ?? null, result.generatedAt).run();
    }
}
