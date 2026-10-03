export const JAPANNEXT_PTS_URLS = {
  day: "https://www.japannext.co.jp/pub_data/pts_info/pts_info_execution_J.js",
  night: "https://www.japannext.co.jp/pub_data/pts_info/pts_info_execution_N.js",
} as const;

export type JapannextPtsVenue = keyof typeof JAPANNEXT_PTS_URLS;
export type JapannextPtsSession = "pts_day" | "pts_night";

export type JapannextPtsRow = {
  symbol: string;
  open: string;
  high: string;
  low: string;
  last: string;
  volume: string;
};

export type JapannextPtsWindow = {
  venue: JapannextPtsVenue;
  venueCode: "JNX_DAY" | "JNX_NIGHT";
  session: JapannextPtsSession;
  sessionKey: string;
};

const MAX_SOURCE_BYTES = 400_000;
const SOURCE_ROW = /^mdata\[\s*\d+\s*\]\s*=\s*(\[.*\]);\s*$/;
const SYMBOL = /^(?:\d{4}|\d{3}[A-Z])$/;
const tokyoParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function partsAt(date: Date) {
  const parts = Object.fromEntries(tokyoParts.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function previousDate(ymd: string) {
  const noonUtc = new Date(`${ymd}T12:00:00.000Z`);
  noonUtc.setUTCDate(noonUtc.getUTCDate() - 1);
  return noonUtc.toISOString().slice(0, 10);
}

/** Japannext operating windows, including the post-midnight part of its night session. */
export function japannextPtsWindowAt(date: Date): JapannextPtsWindow | null {
  const local = partsAt(date);
  const minute = local.hour * 60 + local.minute;
  if (minute >= 8 * 60 + 20 && minute <= 16 * 60 + 30) {
    return { venue: "day", venueCode: "JNX_DAY", session: "pts_day", sessionKey: local.date };
  }
  if (minute >= 17 * 60) {
    return { venue: "night", venueCode: "JNX_NIGHT", session: "pts_night", sessionKey: local.date };
  }
  if (minute < 6 * 60) {
    return { venue: "night", venueCode: "JNX_NIGHT", session: "pts_night", sessionKey: previousDate(local.date) };
  }
  return null;
}

function validPrice(value: unknown) {
  return typeof value === "string" && value.length <= 32 && Number.isFinite(Number(value)) && Number(value) > 0;
}

function validVolume(value: unknown) {
  return typeof value === "string" && value.length <= 32 && Number.isFinite(Number(value)) && Number(value) >= 0;
}

/** Parse Japannext's assignment-form batch file as data. This deliberately never evaluates source JavaScript. */
export function parseJapannextPtsSource(source: string, selectedSymbols?: ReadonlySet<string>) {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) throw new Error("pts_source_too_large");
  const rows: JapannextPtsRow[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = SOURCE_ROW.exec(line.trim());
    if (!match) continue;
    let raw: unknown;
    try { raw = JSON.parse(match[1]); } catch { continue; }
    if (!Array.isArray(raw) || raw.length !== 9) continue;
    const [symbol, , , , open, high, low, last, volume] = raw;
    if (typeof symbol !== "string" || !SYMBOL.test(symbol)) continue;
    if (selectedSymbols && !selectedSymbols.has(symbol)) continue;
    if (!validPrice(last) || !validVolume(volume)) continue;
    rows.push({
      symbol,
      open: validPrice(open) ? open : last,
      high: validPrice(high) ? high : last,
      low: validPrice(low) ? low : last,
      last,
      volume,
    });
  }
  return rows;
}

export function normalizeJapanesePtsSymbol(providerSymbol: string) {
  const match = /^(\d{4}|\d{3}[A-Z])(?:\.T)?$/i.exec(providerSymbol.trim());
  return match?.[1]?.toUpperCase() ?? null;
}
