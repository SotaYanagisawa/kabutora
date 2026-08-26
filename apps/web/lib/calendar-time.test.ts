import { afterEach, describe, expect, it } from "vitest";
import { calendarDateLabelJa, localDateInputValue, shiftCalendarMonths } from "./calendar-time";

const originalTimeZone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimeZone;
});

describe("calendar values across device timezones", () => {
  it("never shifts date-only financial records", () => {
    for (const timeZone of ["Pacific/Honolulu", "Asia/Tokyo", "Europe/London"]) {
      process.env.TZ = timeZone;
      expect(calendarDateLabelJa("2026-08-12T00:15:00.000Z")).toBe("2026/8/12");
    }
  });

  it("uses the user's local date for a date-input default", () => {
    const instant = new Date("2026-08-12T02:00:00.000Z");
    process.env.TZ = "Pacific/Honolulu";
    expect(localDateInputValue(instant)).toBe("2026-08-11");
    process.env.TZ = "Asia/Tokyo";
    expect(localDateInputValue(instant)).toBe("2026-08-12");
  });

  it("shifts calendar months without timezone or month-end rollover", () => {
    expect(shiftCalendarMonths("2026-05-31", -3)).toBe("2026-02-28");
    expect(shiftCalendarMonths("2024-05-31", -3)).toBe("2024-02-29");
  });
});
