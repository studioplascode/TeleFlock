import { describe, expect, test } from "bun:test";
import { countdownActions } from "./countdownActions";

describe("countdownActions", () => {
  test("a countdown that counts or stands: Cancel, +10 min, +1 h", () => {
    for (const phase of ["counting", "waiting"] as const) {
      expect(countdownActions(phase, 1_200)).toEqual([
        { kind: "cancel", label: "Cancel", title: "Don't auto-pick: this question waits for you" },
        { kind: "postpone", secs: 600, label: "+10 min", title: "Wait 10 min longer" },
        { kind: "postpone", secs: 3_600, label: "+1 h", title: "Wait 1 h longer" },
      ]);
    }
  });

  test("cancelled: Restart with the policy's whole wait", () => {
    expect(countdownActions("cancelled", 1_800)).toEqual([{ kind: "restart", secs: 1_800, label: "Restart", title: "Count down again from 30 min" }]);
    expect(countdownActions("cancelled", 5_400)).toEqual([{ kind: "restart", secs: 5_400, label: "Restart", title: "Count down again from 1 h 30 min" }]);
  });

  test("nothing while it picks, or with no policy to restart", () => {
    expect(countdownActions("due", 1_200)).toEqual([]);
    expect(countdownActions("cancelled", undefined)).toEqual([]);
  });
});
