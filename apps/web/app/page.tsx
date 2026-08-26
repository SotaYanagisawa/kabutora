import ClientAppRoot from "@/components/client-app-root";
import { portfolioMarketSessions } from "@/lib/market-session";

// The middleware generates a fresh CSP nonce for every document request.
// Rendering this route dynamically lets Next.js attach that nonce to its
// bootstrap scripts instead of serving nonce-less prerendered HTML.
export const dynamic = "force-dynamic";

export default function Home() {
  const initialServerTimeMs = Date.now();
  return <ClientAppRoot initialServerTimeMs={initialServerTimeMs} initialMarketSessions={portfolioMarketSessions("ALL", new Date(initialServerTimeMs))} />;
}
