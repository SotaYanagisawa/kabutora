export type MarketRegion = "JP" | "US";
export type MarketSessionKind = "regular" | "pre_market" | "after_hours" | "pts_day" | "pts_night" | "closed" | "unknown";

export type MarketSessionStatus = {
  market: MarketRegion;
  marketLabel: string;
  isOpen: boolean;
  session: MarketSessionKind;
  label: string;
  reason: string;
  detail: string;
  calendarSource: "official" | "rules";
};

type LocalClock = { year: number; month: number; day: number; weekday: number; minute: number; ymd: string };

const JPX_PUBLISHED_YEARS = new Set([2026, 2027]);
const NYSE_PUBLISHED_YEARS = new Set([2026, 2027, 2028]);

const JPX_OFFICIAL_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "元日", "2026-01-02": "年始休業", "2026-01-03": "年始休業", "2026-01-12": "成人の日",
  "2026-02-11": "建国記念の日", "2026-02-23": "天皇誕生日", "2026-03-20": "春分の日", "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日", "2026-05-04": "みどりの日", "2026-05-05": "こどもの日", "2026-05-06": "振替休日",
  "2026-07-20": "海の日", "2026-08-11": "山の日", "2026-09-21": "敬老の日", "2026-09-22": "国民の休日",
  "2026-09-23": "秋分の日", "2026-10-12": "スポーツの日", "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日",
  "2026-12-31": "年末休業",
  "2027-01-01": "元日", "2027-01-02": "年始休業", "2027-01-03": "年始休業", "2027-01-11": "成人の日",
  "2027-02-11": "建国記念の日", "2027-02-23": "天皇誕生日", "2027-03-21": "春分の日", "2027-03-22": "振替休日",
  "2027-04-29": "昭和の日", "2027-05-03": "憲法記念日", "2027-05-04": "みどりの日", "2027-05-05": "こどもの日",
  "2027-07-19": "海の日", "2027-08-11": "山の日", "2027-09-20": "敬老の日", "2027-09-23": "秋分の日",
  "2027-10-11": "スポーツの日", "2027-11-03": "文化の日", "2027-11-23": "勤労感謝の日", "2027-12-31": "年末休業",
};

const NYSE_OFFICIAL_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "元日", "2026-01-19": "キング牧師記念日", "2026-02-16": "大統領の日", "2026-04-03": "聖金曜日",
  "2026-05-25": "戦没将兵追悼記念日", "2026-06-19": "ジューンティーンス", "2026-07-03": "独立記念日の振替休日",
  "2026-09-07": "労働者の日", "2026-11-26": "感謝祭", "2026-12-25": "クリスマス",
  "2027-01-01": "元日", "2027-01-18": "キング牧師記念日", "2027-02-15": "大統領の日", "2027-03-26": "聖金曜日",
  "2027-05-31": "戦没将兵追悼記念日", "2027-06-18": "ジューンティーンスの振替休日", "2027-07-05": "独立記念日の振替休日",
  "2027-09-06": "労働者の日", "2027-11-25": "感謝祭", "2027-12-24": "クリスマスの振替休日",
  "2028-01-17": "キング牧師記念日", "2028-02-21": "大統領の日", "2028-04-14": "聖金曜日", "2028-05-29": "戦没将兵追悼記念日",
  "2028-06-19": "ジューンティーンス", "2028-07-04": "独立記念日", "2028-09-04": "労働者の日", "2028-11-23": "感謝祭",
  "2028-12-25": "クリスマス",
};

const NYSE_EARLY_CLOSES: Record<string, string> = {
  "2026-11-27": "感謝祭翌日", "2026-12-24": "クリスマス前日", "2027-11-26": "感謝祭翌日",
  "2028-07-03": "独立記念日前日", "2028-11-24": "感謝祭翌日",
};

function clockAtUtcOffset(now: Date, offsetMinutes: number): LocalClock {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid market clock");
  const shifted = new Date(timestamp + offsetMinutes * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    weekday: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    ymd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function newYorkUtcOffset(now: Date) {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid market clock");
  const year = now.getUTCFullYear();
  // US daylight time: second Sunday in March at 02:00 EST through the
  // first Sunday in November at 02:00 EDT (the rule in force since 2007).
  const starts = Date.UTC(year, 2, nthWeekday(year, 3, 0, 2), 7);
  const ends = Date.UTC(year, 10, nthWeekday(year, 11, 0, 1), 6);
  return timestamp >= starts && timestamp < ends ? -4 * 60 : -5 * 60;
}

function localClock(now: Date, timeZone: "Asia/Tokyo" | "America/New_York"): LocalClock {
  return clockAtUtcOffset(now, timeZone === "Asia/Tokyo" ? 9 * 60 : newYorkUtcOffset(now));
}

function shiftedYmd(clock: LocalClock, days: number) {
  const date = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function weekdayOf(ymd: string) {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function utcDateFromYmd(ymd: string) {
  return new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), 12));
}

function nthWeekday(year: number, month: number, weekday: number, nth: number) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  return 1 + ((7 + weekday - first.getUTCDay()) % 7) + (nth - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number) {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((7 + last.getUTCDay() - weekday) % 7);
}

function observedDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function easterSunday(year: number) {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function japaneseRuleHolidays(year: number) {
  const holidays = new Map<string, string>();
  const add = (month: number, day: number, name: string) => holidays.set(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, name);
  add(1, 1, "元日"); add(1, 2, "年始休業"); add(1, 3, "年始休業"); add(1, nthWeekday(year, 1, 1, 2), "成人の日");
  add(2, 11, "建国記念の日"); add(2, 23, "天皇誕生日");
  add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)), "春分の日");
  add(4, 29, "昭和の日"); add(5, 3, "憲法記念日"); add(5, 4, "みどりの日"); add(5, 5, "こどもの日");
  add(7, nthWeekday(year, 7, 1, 3), "海の日"); add(8, 11, "山の日"); add(9, nthWeekday(year, 9, 1, 3), "敬老の日");
  add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)), "秋分の日");
  add(10, nthWeekday(year, 10, 1, 2), "スポーツの日"); add(11, 3, "文化の日"); add(11, 23, "勤労感謝の日"); add(12, 31, "年末休業");
  for (const [ymd, name] of [...holidays]) {
    if (weekdayOf(ymd) !== 0) continue;
    const base = utcDateFromYmd(ymd);
    do base.setUTCDate(base.getUTCDate() + 1); while (holidays.has(base.toISOString().slice(0, 10)));
    holidays.set(base.toISOString().slice(0, 10), `${name}の振替休日`);
  }
  for (let month = 1; month <= 12; month += 1) for (let day = 2; day <= 30; day += 1) {
    const current = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (holidays.has(current)) continue;
    const date = utcDateFromYmd(current);
    const before = new Date(date); before.setUTCDate(date.getUTCDate() - 1);
    const after = new Date(date); after.setUTCDate(date.getUTCDate() + 1);
    if (holidays.has(before.toISOString().slice(0, 10)) && holidays.has(after.toISOString().slice(0, 10))) holidays.set(current, "国民の休日");
  }
  return holidays;
}

function usRuleHolidays(year: number) {
  const holidays = new Map<string, string>();
  const ymd = (month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  holidays.set(observedDate(year, 1, 1), "元日");
  holidays.set(ymd(1, nthWeekday(year, 1, 1, 3)), "キング牧師記念日");
  holidays.set(ymd(2, nthWeekday(year, 2, 1, 3)), "大統領の日");
  const goodFriday = easterSunday(year); goodFriday.setUTCDate(goodFriday.getUTCDate() - 2); holidays.set(goodFriday.toISOString().slice(0, 10), "聖金曜日");
  holidays.set(ymd(5, lastWeekday(year, 5, 1)), "戦没将兵追悼記念日");
  holidays.set(observedDate(year, 6, 19), "ジューンティーンス"); holidays.set(observedDate(year, 7, 4), "独立記念日");
  holidays.set(ymd(9, nthWeekday(year, 9, 1, 1)), "労働者の日"); holidays.set(ymd(11, nthWeekday(year, 11, 4, 4)), "感謝祭");
  holidays.set(observedDate(year, 12, 25), "クリスマス");
  return holidays;
}

function jpHoliday(ymd: string) {
  if (JPX_OFFICIAL_HOLIDAYS[ymd]) return JPX_OFFICIAL_HOLIDAYS[ymd];
  const year = Number(ymd.slice(0, 4));
  return japaneseRuleHolidays(year).get(ymd) ?? null;
}

function usHoliday(ymd: string) {
  if (NYSE_OFFICIAL_HOLIDAYS[ymd]) return NYSE_OFFICIAL_HOLIDAYS[ymd];
  const year = Number(ymd.slice(0, 4));
  return usRuleHolidays(year).get(ymd) ?? null;
}

function isBusinessDay(ymd: string, region: MarketRegion) {
  const weekday = weekdayOf(ymd);
  return weekday !== 0 && weekday !== 6 && !(region === "JP" ? jpHoliday(ymd) : usHoliday(ymd));
}

function closedStatus(market: MarketRegion, label: string, reason: string, detail: string, source: "official" | "rules"): MarketSessionStatus {
  return { market, marketLabel: market === "JP" ? "日本" : "米国", isOpen: false, session: "closed", label, reason, detail, calendarSource: source };
}

function openStatus(market: MarketRegion, session: MarketSessionKind, label: string, detail: string, source: "official" | "rules"): MarketSessionStatus {
  return { market, marketLabel: market === "JP" ? "日本" : "米国", isOpen: true, session, label, reason: "取引時間内", detail, calendarSource: source };
}

export function japanMarketSession(now = new Date()): MarketSessionStatus {
  const clock = localClock(now, "Asia/Tokyo");
  const source = JPX_PUBLISHED_YEARS.has(clock.year) ? "official" : "rules";
  const previousYmd = shiftedYmd(clock, -1);
  if (clock.minute < 6 * 60 && isBusinessDay(previousYmd, "JP")) return openStatus("JP", "pts_night", "PTS夜間", "ジャパンネクストPTS夜間取引中 · 06:00まで", source);
  const holiday = jpHoliday(clock.ymd);
  if (clock.weekday === 0 || clock.weekday === 6) return closedStatus("JP", "週末休場", "土日", "東証・PTSとも休場", source);
  if (holiday) return closedStatus("JP", "祝日休場", holiday, `東証・PTS休場 · ${holiday}`, source);
  if (clock.minute < 8 * 60 + 20) return closedStatus("JP", "開始前", "取引時間外", "PTSデイタイムは08:20開始", source);
  if (clock.minute < 9 * 60) return openStatus("JP", "pts_day", "PTSデイ", "ジャパンネクストPTSデイタイム取引中 · 東証は09:00開始", source);
  if (clock.minute < 11 * 60 + 30) return openStatus("JP", "regular", "東証通常", "東証前場 · 11:30まで", source);
  if (clock.minute < 12 * 60 + 30) return openStatus("JP", "pts_day", "PTSデイ", "東証は昼休み · PTSデイタイムは取引中", source);
  if (clock.minute < 15 * 60 + 30) return openStatus("JP", "regular", "東証通常", "東証後場 · 15:30まで", source);
  if (clock.minute < 16 * 60 + 30) return openStatus("JP", "pts_day", "PTSデイ", "東証終了後 · PTSデイタイムは16:30まで", source);
  if (clock.minute < 17 * 60) return closedStatus("JP", "PTS切替中", "セッション切替", "PTSデイ終了 · 夜間は17:00開始", source);
  return openStatus("JP", "pts_night", "PTS夜間", "ジャパンネクストPTS夜間取引中 · 翌06:00まで", source);
}

export function usMarketSession(now = new Date()): MarketSessionStatus {
  const clock = localClock(now, "America/New_York");
  const source = NYSE_PUBLISHED_YEARS.has(clock.year) ? "official" : "rules";
  const holiday = usHoliday(clock.ymd);
  if (clock.weekday === 0 || clock.weekday === 6) return closedStatus("US", "週末休場", "土日", "米国株式市場は週末休場", source);
  if (holiday) return closedStatus("US", "祝日休場", holiday, `米国株式市場休場 · ${holiday}`, source);
  const earlyCloseReason = NYSE_EARLY_CLOSES[clock.ymd];
  const regularEnd = earlyCloseReason ? 13 * 60 : 16 * 60;
  const afterEnd = earlyCloseReason ? 17 * 60 : 20 * 60;
  if (clock.minute < 4 * 60) return closedStatus("US", "開始前", "取引時間外", "プレ市場は04:00 ET開始", source);
  if (clock.minute < 9 * 60 + 30) return openStatus("US", "pre_market", "プレ市場", "米国プレマーケット取引中 · 09:30 ETまで", source);
  if (clock.minute < regularEnd) return openStatus("US", "regular", "通常取引", `${earlyCloseReason ? `${earlyCloseReason}の短縮取引` : "コアセッション"} · ${earlyCloseReason ? "13:00" : "16:00"} ETまで`, source);
  if (clock.minute < afterEnd) return openStatus("US", "after_hours", "時間外", `${earlyCloseReason ? `${earlyCloseReason}の短縮時間外取引` : "アフターマーケット"} · ${earlyCloseReason ? "17:00" : "20:00"} ETまで`, source);
  return closedStatus("US", "時間外終了", "取引時間外", "次の営業日のプレ市場は04:00 ET開始", source);
}

export function portfolioMarketSessions(filter: "ALL" | "JP" | "US", now = new Date()) {
  const unknown = (market: MarketRegion): MarketSessionStatus => ({
    market,
    marketLabel: market === "JP" ? "日本" : "米国",
    isOpen: false,
    session: "unknown",
    label: "判定不能",
    reason: "端末の日時判定に失敗",
    detail: "価格表示は継続します。市場セッションだけを判定できませんでした。",
    calendarSource: "rules",
  });
  const safeJapan = () => { try { return japanMarketSession(now); } catch { return unknown("JP"); } };
  const safeUs = () => { try { return usMarketSession(now); } catch { return unknown("US"); } };
  if (filter === "JP") return [safeJapan()];
  if (filter === "US") return [safeUs()];
  return [safeJapan(), safeUs()];
}

export function selectReliableMarketSessions(
  filter: "ALL" | "JP" | "US",
  locallyCalculated: MarketSessionStatus[],
  serverCalculated: MarketSessionStatus[],
) {
  const wanted = (status: MarketSessionStatus) => filter === "ALL" || status.market === filter;
  const expectedCount = filter === "ALL" ? 2 : 1;
  const local = locallyCalculated.filter(wanted);
  if (local.length === expectedCount && local.every((status) => status.session !== "unknown")) return local;
  const server = serverCalculated.filter(wanted);
  return server.length === expectedCount && server.every((status) => status.session !== "unknown") ? server : local;
}
