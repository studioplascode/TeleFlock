import { describe, expect, test } from "bun:test";
import type { SetupStatus } from "../gen";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  const apply = async (fixes: string[]): Promise<SetupStatus> => {
    const p = engine.callHost("forge", "host.setupApply", { fixes });
    clock.advance(400);
    return (await p) as SetupStatus;
  };
  clock.advance(3000);
  return { clock, apply, setup: (): SetupStatus | undefined => state.hosts.forge?.state.info.setup };
}

describe("demo host setup", () => {
  test("config fixes apply at once; installs run after the reply, and a failed one stays open", async () => {
    const r = rig();
    const reply = await r.apply(["enable-global-sharing", "install-ffmpeg"]);
    expect(reply.globalSharing).toBe(true);
    expect(reply.applying).toEqual(["install-ffmpeg"]);
    expect(reply.issues.map((i) => i.id)).toContain("install-ffmpeg");
    expect(reply.issues.map((i) => i.id)).not.toContain("enable-global-sharing");
    // A batch keeps the GitHub items' fields.
    expect([reply.ghSignedIn, reply.gitIdentity]).toEqual([false, false]);

    r.clock.advance(3500);
    // ffmpeg's first attempt fails (the package mirror is unreachable).
    expect(r.setup()?.applying).toEqual([]);
    expect(r.setup()?.failed?.map((f) => [f.id, f.error.code])).toEqual([["install-ffmpeg", "install_failed"]]);
    expect(r.setup()?.issues.map((i) => i.id)).toContain("install-ffmpeg");

    // A retry hides the old failure while it runs and clears it when it works.
    const retry = await r.apply(["install-ffmpeg"]);
    expect([retry.applying, retry.failed]).toEqual([["install-ffmpeg"], []]);
    r.clock.advance(3500);
    expect(r.setup()?.issues.map((i) => i.id)).not.toContain("install-ffmpeg");
    expect(r.setup()?.failed).toEqual([]);
  });
});
