import { describe, expect, test } from "bun:test";
import type { IdleShell, IdleShells } from "@/core/gen";
import { andList, closedText, idleText, SNOOZE_MS, showShellsNotice, spanText, THRESHOLDS, thresholdChoices } from "./idleShells";

const shell = (paneId: string, workspace: string): IdleShell => ({ paneId, terminalId: `t-${paneId}`, workspaceId: paneId.split(":")[0] ?? "", workspace, shell: "bash", idleSince: 0, closesWorkspace: true });
const idle = (n: number, auto = false): IdleShells => ({ auto, minutes: 1440, shells: Array.from({ length: n }, (_, i) => shell(`w${i}:p1`, `ws${i}`)) });
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("idle shells notice", () => {
  test("shows while the host leaves idle shells open; never for a host that closes them or reports none", () => {
    expect(showShellsNotice(idle(3), undefined, NOW)).toBe(true);
    expect(showShellsNotice(idle(3, true), undefined, NOW)).toBe(false);
    expect(showShellsNotice(idle(0), undefined, NOW)).toBe(false);
    // a host before 0.9.0 reports no idle shells at all
    expect(showShellsNotice(undefined, undefined, NOW)).toBe(false);
  });

  test("hiding it lasts a day, unless more shells go idle", () => {
    const snooze = { count: 3, until: NOW + SNOOZE_MS };
    expect(showShellsNotice(idle(3), snooze, NOW + 1000)).toBe(false);
    // fewer (some were used or closed since) stays hidden too
    expect(showShellsNotice(idle(2), snooze, NOW + 1000)).toBe(false);
    expect(showShellsNotice(idle(4), snooze, NOW + 1000)).toBe(true);
    expect(showShellsNotice(idle(3), snooze, NOW + SNOOZE_MS)).toBe(true);
  });
});

describe("idle shells thresholds", () => {
  test("the presets run from an hour to a week; a host's own value joins them in order", () => {
    expect(thresholdChoices(1440)).toEqual([...THRESHOLDS]);
    expect(thresholdChoices(2)).toEqual([2, ...THRESHOLDS]);
    const custom = thresholdChoices(3000);
    expect(custom).toEqual([...custom].sort((a, b) => a - b));
    expect(custom).toContain(3000);
    expect(custom).toHaveLength(THRESHOLDS.length + 1);
  });

  test("minutes under an hour, hours up to 72 h, whole days beyond", () => {
    expect(spanText(2)).toBe("2 min");
    expect(spanText(90)).toBe("1 h 30 min");
    expect(spanText(1440)).toBe("24 h");
    expect(spanText(4320)).toBe("72 h");
    expect(spanText(10_080)).toBe("7 days");
    // not whole days: stays in hours
    expect(spanText(4380)).toBe("73 h");
    // every preset has a distinct label
    expect(new Set(THRESHOLDS.map(spanText)).size).toBe(THRESHOLDS.length);
  });

  test("idle time rounds down in the same units", () => {
    expect(idleText(40 * 60_000 + 59_000)).toBe("40 min");
    expect(idleText(26 * 3600_000 + 59 * 60_000)).toBe("26 h");
    expect(idleText((3 * 24 + 5) * 3600_000)).toBe("3 days");
    expect(idleText(10_000)).toBe("1 min");
  });
});

describe("idle shells words", () => {
  test("a list names every workspace up to four, then counts the rest", () => {
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b"])).toBe("a and b");
    expect(andList(["a", "b", "c", "d"])).toBe("a, b, c and d");
    expect(andList(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c and 3 more");
  });

  test("the last automatic close says when, in local time", () => {
    const now = new Date(2026, 10, 1, 9, 30).getTime();
    expect(closedText({ at: new Date(2026, 10, 1, 4, 12).getTime(), count: 3, workspaces: ["a", "b", "c"] }, now)).toBe("Closed 3 idle shells by itself at 04:12: a, b and c.");
    expect(closedText({ at: new Date(2026, 9, 31, 23, 5).getTime(), count: 1, workspaces: ["~"] }, now)).toBe("Closed 1 idle shell by itself yesterday at 23:05: ~.");
  });
});
