import { describe, expect, test } from "bun:test";
import { DEFAULT_SCHEDULE, EVERY_HOURS, EVERY_MINUTES, cronToSchedule, fitEvery, scheduleToCron } from "./schedule";

describe("schedule presets", () => {
  test("generate cron strings", () => {
    const d = DEFAULT_SCHEDULE;
    expect(scheduleToCron({ ...d, kind: "minutes", every: 15 })).toBe("*/15 * * * *");
    expect(scheduleToCron({ ...d, kind: "minutes", every: 1 })).toBe("* * * * *");
    expect(scheduleToCron({ ...d, kind: "hours", every: 2, minute: 5 })).toBe("5 */2 * * *");
    expect(scheduleToCron({ ...d, kind: "hours", every: 1, minute: 0 })).toBe("0 * * * *");
    expect(scheduleToCron({ ...d, kind: "daily", hour: 3, minute: 0 })).toBe("0 3 * * *");
    expect(scheduleToCron({ ...d, kind: "weekdays", hour: 8, minute: 30 })).toBe("30 8 * * 1-5");
    expect(scheduleToCron({ ...d, kind: "weekly", hour: 9, minute: 0, days: [5, 1, 3] })).toBe("0 9 * * 1,3,5");
    expect(scheduleToCron({ ...d, kind: "custom", cron: " 0 9 1 * * " })).toBe("0 9 1 * *");
  });

  test("read back into the matching preset", () => {
    expect(cronToSchedule("*/15 * * * *")).toMatchObject({ kind: "minutes", every: 15 });
    expect(cronToSchedule("* * * * *")).toMatchObject({ kind: "minutes", every: 1 });
    expect(cronToSchedule("5 */2 * * *")).toMatchObject({ kind: "hours", every: 2, minute: 5 });
    expect(cronToSchedule("5 * * * *")).toMatchObject({ kind: "hours", every: 1, minute: 5 });
    expect(cronToSchedule("0 3 * * *")).toMatchObject({ kind: "daily", hour: 3, minute: 0 });
    expect(cronToSchedule("30  8 * * 1-5")).toMatchObject({ kind: "weekdays", hour: 8, minute: 30 });
    expect(cronToSchedule("0 9 * * 1,3,5")).toMatchObject({ kind: "weekly", days: [1, 3, 5] });
  });

  test("anything else is custom, text kept", () => {
    for (const cron of ["0 9 1 * *", "@daily", "0 9 * * mon-fri", "0 9 * * 5,1", "05 9 * * *", "0 9-17 * * *", "*/45 * * * *", "0 */5 * * *"]) {
      expect(cronToSchedule(cron)).toMatchObject({ kind: "custom", cron });
    }
  });

  test("every N keeps the same gap across the hour / day", () => {
    for (const n of EVERY_MINUTES) expect(60 % n).toBe(0);
    for (const n of EVERY_HOURS) expect(24 % n).toBe(0);
    expect(fitEvery("minutes", 45)).toBe(30);
    expect(fitEvery("minutes", 15)).toBe(15);
    expect(fitEvery("hours", 5)).toBe(4);
    expect(fitEvery("hours", 30)).toBe(12);
    expect(fitEvery("hours", 0)).toBe(1);
  });
});
