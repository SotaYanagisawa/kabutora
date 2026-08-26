const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})/u;

export function calendarDateKey(value: string) {
  const match = DATE_KEY.exec(value);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? `${match[1]}-${match[2]}-${match[3]}`
    : "";
}

export function calendarDateLabelJa(value: string) {
  const key = calendarDateKey(value);
  if (!key) return "—";
  const [year, month, day] = key.split("-").map(Number);
  return `${year}/${month}/${day}`;
}

export function localDateInputValue(date = new Date()) {
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function shiftCalendarMonths(value: string, months: number) {
  const key = calendarDateKey(value);
  if (!key || !Number.isInteger(months)) return "";
  const [year, month, day] = key.split("-").map(Number);
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = firstOfTarget.getUTCFullYear();
  const targetMonth = firstOfTarget.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
