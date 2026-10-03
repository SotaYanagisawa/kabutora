import type { ProviderCapabilities } from "@kabutora/market-data";
type Policy = {
    id: string;
    hosts: readonly string[];
    attemptsPerDay: number;
    capabilities: ProviderCapabilities;
};
const capabilities = (values: Partial<ProviderCapabilities>): ProviderCapabilities => ({ quotes: false, intraday: false, dailyHistory: false, distributions: false, corporateActions: false, delaySeconds: null, permittedGroupUse: "unverified", ...values });
/** Source coverage and hard admission policy; no portfolio-dependent limits. */
export const MARKET_PROVIDER_POLICIES: readonly Policy[] = [
    { id: "yahoo_chart", hosts: ["query1.finance.yahoo.com", "query2.finance.yahoo.com"], attemptsPerDay: 10000, capabilities: capabilities({ quotes: true, intraday: true, dailyHistory: true, distributions: true, corporateActions: true }) },
    { id: "yahoo_japan", hosts: ["finance.yahoo.co.jp"], attemptsPerDay: 4000, capabilities: capabilities({ quotes: true, dailyHistory: true, distributions: true }) },
    { id: "cnbc", hosts: ["quote.cnbc.com"], attemptsPerDay: 2000, capabilities: capabilities({ quotes: true }) },
    { id: "japannext", hosts: ["www.japannext.co.jp"], attemptsPerDay: 1200, capabilities: capabilities({ quotes: true, intraday: true }) },
    { id: "monex", hosts: ["fund.monex.co.jp"], attemptsPerDay: 100, capabilities: capabilities({ quotes: true, dailyHistory: true, distributions: true }) },
    { id: "blackrock", hosts: ["www.blackrock.com"], attemptsPerDay: 48, capabilities: capabilities({ distributions: true }) },
    { id: "ecb", hosts: ["www.ecb.europa.eu"], attemptsPerDay: 48, capabilities: capabilities({ quotes: true, delaySeconds: 86400, permittedGroupUse: "confirmed" }) },
];
export function marketProviderPolicy(host: string) { return MARKET_PROVIDER_POLICIES.find(policy => policy.hosts.includes(host)); }
