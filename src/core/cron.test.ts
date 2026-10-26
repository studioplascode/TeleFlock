import { describe, expect, test } from "bun:test";
import { cronError, describeCron, nextRuns, parseCron } from "./cron";

/** Local wall-clock time (tests stay zone-independent). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("parseCron", () => {
  test("fields, ranges, steps, lists and names", () => {
    const s = parseCron("*/15 9-17/4 1,15 jan-mar mon-fri");
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([9, 13, 17]);
    expect(s.doms).toEqual([1, 15]);
    expect(s.months).toEqual([1, 2, 3]);
    expect(s.dows).toEqual([1, 2, 3, 4, 5]);
    expect(s.domStar).toBe(false);
    expect(s.dowStar).toBe(false);
  });

  test("a/n runs to the end of the field; 7 is Sunday", () => {
    expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
    expect(parseCron("0 0 * * 7").dows).toEqual([0]);
    expect(parseCron("0 0 * * 5-7").dows).toEqual([0, 5, 6]);
    expect(parseCron("0 0 * * *").dows).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("macros", () => {
    expect(parseCron("@daily")).toEqual(parseCron("0 0 * * *"));
    expect(parseCron("@midnight")).toEqual(parseCron("0 0 * * *"));
    expect(parseCron("@hourly")).toEqual(parseCron("0 * * * *"));
    expect(parseCron("@weekly")).toEqual(parseCron("0 0 * * 0"));
    expect(parseCron("@monthly")).toEqual(parseCron("0 0 1 * *"));
    expect(parseCron("@annually")).toEqual(parseCron("0 0 1 1 *"));
  });

  test("errors (hostd's messages)", () => {
    expect(cronError("0 9 * * 1-5")).toBeNull();
    expect(cronError("")).toBe("a schedule has 5 fields (minute hour day-of-month month day-of-week), got 0");
    expect(cronError("0 9 * *")).toContain("got 4");
    expect(cronError("60 * * * *")).toBe("minute 60 is out of range (0–59)");
    expect(cronError("0 24 * * *")).toBe("hour 24 is out of range (0–23)");
    expect(cronError("0 0 0 * *")).toBe("day of month 0 is out of range (1–31)");
    expect(cronError("*/0 * * * *")).toBe("step 0 is out of range in the minute field");
    expect(cronError("*/x * * * *")).toBe("`x` is not a valid step in the minute field");
    expect(cronError("0 9 * * funday")).toBe("`funday` is not a valid day of week");
    expect(cronError("5-1 * * * *")).toBe("range 5-1 runs backwards in the minute field");
    expect(cronError("@sometimes")).toBe("unknown schedule `@sometimes`");
    expect(cronError("1,,2 * * * *")).toBe("`` is not a valid minute");
  });
});

describe("nextRuns", () => {
  test("weekdays at 09:00 skip the weekend", () => {
    // 2026-10-23 is a Friday
    expect(nextRuns("0 9 * * 1-5", at(2026, 10, 23, 9, 0), 3)).toEqual([at(2026, 10, 26, 9), at(2026, 10, 27, 9), at(2026, 10, 28, 9)]);
  });

  test("strictly after `from`, minute steps", () => {
    expect(nextRuns("*/15 * * * *", at(2026, 1, 5, 8, 15), 3)).toEqual([at(2026, 1, 5, 8, 30), at(2026, 1, 5, 8, 45), at(2026, 1, 5, 9, 0)]);
    expect(nextRuns("* * * * *", at(2026, 1, 5, 8, 15) + 30_000, 1)).toEqual([at(2026, 1, 5, 8, 16)]);
  });

  test("day fields: `*` defers to the other one, both restricted match with OR", () => {
    // 2026-02-01 is a Sunday; Mondays plus the 1st
    expect(nextRuns("0 0 1 * 1", at(2026, 1, 31, 12), 3)).toEqual([at(2026, 2, 1), at(2026, 2, 2), at(2026, 2, 9)]);
    // dom starts with `*`: only the weekday counts (as in hostd)
    expect(nextRuns("0 0 */2 * 1", at(2026, 2, 1), 2)).toEqual([at(2026, 2, 2), at(2026, 2, 9)]);
  });

  test("months, leap days and impossible dates", () => {
    expect(nextRuns("30 6 1 jan,jul *", at(2026, 3, 1), 2)).toEqual([at(2026, 7, 1, 6, 30), at(2027, 1, 1, 6, 30)]);
    expect(nextRuns("0 0 29 2 *", at(2026, 3, 1), 1)).toEqual([at(2028, 2, 29)]);
    expect(nextRuns("0 0 31 2 *", at(2026, 3, 1), 1)).toEqual([]);
  });
});

describe("describeCron", () => {
  const cases: [string, string][] = [
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["5 * * * *", "Every hour at :05"],
    ["@hourly", "Every hour at :00"],
    ["0 */2 * * *", "Every 2 hours at :00"],
    ["0 9 * * *", "At 09:00, every day"],
    ["@daily", "At 00:00, every day"],
    ["0 9 * * 1-5", "At 09:00, Monday through Friday"],
    ["30 8 * * mon-fri", "At 08:30, Monday through Friday"],
    ["0 9,17 * * 1,3,5", "At 09:00 and 17:00, on Monday, Wednesday and Friday"],
    ["0 10 * * 6,0", "At 10:00, on Saturday and Sunday"],
    ["5,35 * * * *", "At minute 5 and 35 past every hour"],
    ["5,35 * * * 1-5", "At minute 5 and 35 past every hour, Monday through Friday"],
    ["*/30 * * * 1-5", "Every 30 minutes, Monday through Friday"],
    ["0 0 * * 0", "At 00:00, on Sunday"],
    ["0 0 1 * *", "At 00:00, on day 1 of the month"],
    ["0 9 1 1 *", "At 09:00, on day 1 of the month, in January"],
    ["0 9 1,15 * *", "At 09:00, on days 1 and 15 of the month"],
    ["0 0 1 * 1", "At 00:00, on day 1 of the month or on Monday"],
    ["5,35 1-4 * * *", "At minute 5 and 35, past hour 01 through 04, every day"],
    ["*/10 9-17 * * 1-5", "Every 10 minutes, past hour 09 through 17, Monday through Friday"],
    ["0 */6 * * *", "Every 6 hours at :00"],
    ["0,30 9 * * *", "At minute 0 and 30, past hour 09, every day"],
    ["0 9 * 6-8 *", "At 09:00, every day, in June through August"],
  ];
  for (const [expr, text] of cases) {
    test(expr, () => expect(describeCron(expr)).toBe(text));
  }

  test("invalid → null", () => {
    expect(describeCron("nope")).toBeNull();
  });
});
