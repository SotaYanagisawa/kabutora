export class MarketApiResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MarketApiResponseError";
  }
}

export function isAbortLikeMarketError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.name === "AbortError"
    || cause.name === "TimeoutError"
    || /\b(?:abort(?:ed)?|timed?\s*out|timeout)\b/iu.test(cause.message);
}

export function stableMarketErrorMessage(cause: unknown, fallbackMessage: string): string {
  return isAbortLikeMarketError(cause)
    ? "市場データの応答が時間内に完了しませんでした"
    : cause instanceof MarketApiResponseError
    ? cause.message
    : fallbackMessage;
}

export async function readMarketApiResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const body = await response.text();
  if (!body.trim()) throw new MarketApiResponseError(fallbackMessage, response.status);
  try {
    return JSON.parse(body) as T;
  } catch {
    // Safari exposes JSON parsing failures as the opaque DOMException message
    // "The string did not match the expected pattern.". Keep infrastructure
    // error pages out of the UI and give the caller a stable, actionable error.
    throw new MarketApiResponseError(fallbackMessage, response.status);
  }
}
