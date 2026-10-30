import { describe, expect, test } from "bun:test";
import { INPUT_EVERY_MS, PresenceTracker } from "./presence";

function tracker() {
  const clock = { t: 1_000_000 };
  return { clock, p: new PresenceTracker(() => clock.t) };
}

describe("PresenceTracker", () => {
  test("the first state is reported without inputAt; the same state again is not", () => {
    const { p } = tracker();
    expect(p.state(true, true)).toEqual({ visible: true, focused: true });
    expect(p.state(true, true)).toBeNull();
  });

  test("a change of visibility or focus is reported once", () => {
    const { p } = tracker();
    p.state(true, true);
    expect(p.state(true, false)).toEqual({ visible: true, focused: false });
    expect(p.state(true, false)).toBeNull();
    expect(p.state(false, false)).toEqual({ visible: false, focused: false });
  });

  test("input reports at most once per 20 s and carries the newest inputAt on later reports", () => {
    const { clock, p } = tracker();
    p.state(true, true);
    expect(p.input(true, true)).toEqual({ visible: true, focused: true, inputAt: 1_000_000 });
    clock.t += 1_000;
    expect(p.input(true, true)).toBeNull();
    clock.t += INPUT_EVERY_MS - 1_001;
    expect(p.input(true, true)).toBeNull();
    // a focus change in between reports the last input, even though input itself was throttled
    expect(p.state(true, false)).toEqual({ visible: true, focused: false, inputAt: 1_000_000 + INPUT_EVERY_MS - 1 });
    clock.t += 1;
    expect(p.input(true, false)).toEqual({ visible: true, focused: false, inputAt: 1_000_000 + INPUT_EVERY_MS });
  });
});
