import { Decimal, type MarketQuote } from "@kabutora/domain";
import { providerFetch } from "./provider-fetch";
export const ECB_REFERENCE_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
type ReferenceRate = {
    date: string;
    price: string;
};
/** ECB quotes currencies per EUR; calculate JPY per USD using decimal arithmetic. */
export function parseEcbUsdJpy(xml: string): ReferenceRate[] {
    if (xml.length > 500000 || /<!DOCTYPE|<!ENTITY/iu.test(xml))
        throw new Error("ecb_payload_invalid");
    const rates: ReferenceRate[] = [];
    for (const match of xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/gu)) {
        const usd = /currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/u.exec(match[2])?.[1];
        const jpy = /currency=['"]JPY['"]\s+rate=['"]([0-9.]+)['"]/u.exec(match[2])?.[1];
        if (!usd || !jpy)
            continue;
        const base = new Decimal(usd), yen = new Decimal(jpy);
        if (!base.isFinite() || !yen.isFinite() || base.lte(0) || yen.lte(0))
            throw new Error("ecb_rate_invalid");
        rates.push({ date: match[1], price: yen.div(base).toString() });
    }
    if (!rates.length)
        throw new Error("ecb_rates_missing");
    return rates.sort((a, b) => a.date.localeCompare(b.date));
}
let cached: {
    expires: number;
    rates: ReferenceRate[];
} | undefined;
let flight: Promise<ReferenceRate[]> | undefined;
export async function getEcbUsdJpyQuote(): Promise<MarketQuote> {
    const rates = cached && cached.expires > Date.now() ? cached.rates : await (flight ??= (async () => {
        const response = await providerFetch(ECB_REFERENCE_URL, { signal: AbortSignal.timeout(5000), headers: { Accept: "application/xml" } });
        if (!response.ok)
            throw new Error("ecb_unavailable");
        const parsed = parseEcbUsdJpy(await response.text());
        cached = { expires: Date.now() + 3600000, rates: parsed };
        return parsed;
    })().finally(() => { flight = undefined; }));
    const latest = rates.at(-1)!, previous = rates.at(-2);
    return { price: latest.price, ...(previous ? { previousRegularClose: previous.price } : {}), marketTimestamp: `${latest.date}T00:00:00.000Z`, fetchedAt: new Date().toISOString(), freshness: "delayed", session: "closed", priceType: "official_close", venueCode: "FX", provider: "ecb_reference_fx", validationStatus: "valid" };
}
