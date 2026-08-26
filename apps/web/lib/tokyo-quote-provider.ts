export type TokyoQuoteProvider = "yahoo_japan" | "yahoo_chart";

export function tokyoQuoteProviderOrder(session: string | null | undefined): TokyoQuoteProvider[] {
  return session === "pts_day" || session === "pts_night"
    ? ["yahoo_japan", "yahoo_chart"]
    : ["yahoo_chart", "yahoo_japan"];
}
