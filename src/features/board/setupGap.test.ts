import { describe, expect, test } from "bun:test";
import { boardSetupGap, setupGap } from "./setupGap";

const setup = (globalBridge: boolean, globalSharing: boolean, herdrIntegration: boolean) => ({ globalBridge, globalSharing, herdrIntegration });

describe("setup gap", () => {
  test("the bridge or session sharing is enough for hand-started sessions", () => {
    expect(setupGap(setup(true, false, true))).toBeNull();
    expect(setupGap(setup(false, true, true))).toBeNull();
    expect(setupGap(setup(true, true, true))).toBeNull();
    expect(setupGap(setup(false, false, true))).toBe("sessions");
  });

  test("hidden sessions outrank unknown states; herdr's integration is needed either way", () => {
    expect(setupGap(setup(false, false, false))).toBe("sessions");
    expect(setupGap(setup(true, false, false))).toBe("states");
    expect(setupGap(setup(false, true, false))).toBe("states");
  });

  test("unknown setup is no gap", () => {
    expect(setupGap(undefined)).toBeNull();
  });

  test("the board never points at a demo host's simulated setup", () => {
    expect(boardSetupGap("demo", setup(false, false, false))).toBeNull();
    expect(boardSetupGap("tailscaleSsh", setup(false, false, true))).toBe("sessions");
    expect(boardSetupGap(undefined, setup(true, false, false))).toBe("states");
  });
});
