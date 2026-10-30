import { describe, expect, test } from "bun:test";
import type { HerdrHealth } from "../gen";
import { ManualClock } from "./clock";
import { DemoHerdr } from "./herdrHealth";

function setup(variant: "forge" | "studio" = "forge") {
  const clock = new ManualClock();
  const seen: HerdrHealth[] = [];
  const herdr = new DemoHerdr(variant, clock, () => 9, (h) => seen.push(h));
  return { clock, herdr, seen };
}

describe("demo herdr health", () => {
  test("forge runs 0.9.5 with 0.9.6 waiting on two working agents; studio has nothing to load", () => {
    const h = setup().herdr.status();
    expect(h).toMatchObject({ state: "up", version: "0.9.5", epoch: 1, config: { autoRestart: true, idleUpdate: true, idleMinutes: 20 } });
    expect(h.update).toMatchObject({ state: "waiting", from: "0.9.5", to: "0.9.6", mode: "handoff", blockers: ["2 agents working"] });
    const s = setup("studio").herdr.status();
    expect(s).toMatchObject({ state: "up", version: "0.9.0" });
    expect(s.update).toBeUndefined();
  });

  test("a restart without force leaves a running server alone; force replaces it: restarting → starting → up", () => {
    const { clock, herdr, seen } = setup();
    expect(herdr.call("host.herdrRestart", {}).state).toBe("up");
    expect(seen).toHaveLength(0);
    const t0 = clock.now();
    const r = herdr.call("host.herdrRestart", { force: true });
    expect(r).toMatchObject({ state: "restarting", cause: "restart", downAt: t0, endedAgents: 9 });
    clock.advance(2600);
    expect(herdr.status()).toMatchObject({ state: "starting", attempt: 1, downAt: t0 });
    clock.advance(3100);
    expect(herdr.status()).toMatchObject({ state: "up", epoch: 2, version: "0.9.6", keptPanes: false, downAt: undefined, cause: undefined });
    // the restart loaded the installed herdr
    expect(herdr.status().update).toMatchObject({ state: "done", to: "0.9.6" });
  });

  test("herdr server stop: down at once, started again after the backoff, epoch bumped", () => {
    const { clock, herdr } = setup();
    const t0 = clock.now();
    herdr.stopServer();
    expect(herdr.status()).toMatchObject({ state: "down", cause: "stopped", downAt: t0, endedAgents: 9, attempt: 0, retryAt: t0 + 12_000 });
    clock.advance(12_100);
    expect(herdr.status()).toMatchObject({ state: "starting", attempt: 1 });
    clock.advance(3100);
    expect(herdr.status()).toMatchObject({ state: "up", epoch: 2 });
  });

  test("with the automatic restart off it stays down until Restart herdr, which skips the backoff", () => {
    const { clock, herdr } = setup();
    herdr.call("host.herdrConfig", { autoRestart: false });
    herdr.stopServer("crashed");
    expect(herdr.status()).toMatchObject({ state: "down", cause: "crashed", retryAt: undefined });
    clock.advance(60_000);
    expect(herdr.status().state).toBe("down");
    expect(herdr.call("host.herdrRestart", {}).state).toBe("starting");
    clock.advance(3100);
    expect(herdr.status().state).toBe("up");
  });

  test("Load now: a live handoff keeps the panes and marks the update done", () => {
    const { clock, herdr } = setup();
    expect(herdr.call("host.herdrLoad", {})).toMatchObject({ state: "updating", update: { state: "running" } });
    clock.advance(3100);
    expect(herdr.status()).toMatchObject({ state: "up", version: "0.9.6", keptPanes: true, epoch: 2 });
    expect(herdr.status().update).toMatchObject({ state: "done", at: clock.now() - 100 });
    expect(() => herdr.call("host.herdrLoad", {})).toThrow(/Nothing to load/);
  });

  test("loading needs a running server and something to load", () => {
    const { herdr } = setup("studio");
    expect(() => herdr.call("host.herdrLoad", {})).toThrow(/Nothing to load/);
    const forge = setup().herdr;
    forge.stopServer();
    expect(() => forge.call("host.herdrLoad", {})).toThrow(/isn't running/);
  });

  test("settings: validates the idle minutes, and switching idle loading off makes the plan manual", () => {
    const { herdr } = setup();
    expect(() => herdr.call("host.herdrConfig", { idleMinutes: 0 })).toThrow(/1–1440/);
    expect(() => herdr.call("host.herdrConfig", { idleMinutes: 1441 })).toThrow();
    expect(herdr.call("host.herdrConfig", { idleUpdate: false }).update?.state).toBe("manual");
    expect(herdr.call("host.herdrConfig", { idleUpdate: true, idleMinutes: 5 })).toMatchObject({ config: { idleUpdate: true, idleMinutes: 5 }, update: { state: "waiting" } });
  });

  test("the session goes idle 45 s after start; the update loads by itself after the idle window", () => {
    const { clock, herdr } = setup();
    herdr.call("host.herdrConfig", { idleMinutes: 2 });
    clock.advance(45_100);
    const idle = herdr.status().update;
    expect(idle).toMatchObject({ state: "waiting", blockers: [] });
    expect(idle?.dueAt).toBe((idle?.idleSince ?? 0) + 2 * 60_000);
    clock.advance(2 * 60_000);
    expect(herdr.status().state).toBe("updating");
    clock.advance(3100);
    expect(herdr.status()).toMatchObject({ state: "up", version: "0.9.6", keptPanes: true });
  });

  test("an unknown method is refused", () => {
    expect(() => setup().herdr.call("host.herdrNope", {})).toThrow(/Unknown method/);
  });
});
