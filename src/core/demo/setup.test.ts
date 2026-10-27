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
  test("config fixes apply at once; installs run after the reply, each on its own", async () => {
    const r = rig();
    const reply = await r.apply(["enable-global-sharing", "install-gh", "install-ffmpeg"]);
    expect(reply.globalSharing).toBe(true);
    expect(reply.applying).toEqual(["install-gh", "install-ffmpeg"]);
    expect(reply.issues.map((i) => i.id)).toContain("install-gh");

    r.clock.advance(3500);
    // gh's first attempt fails (github.com unreachable); ffmpeg still runs.
    expect(r.setup()?.applying).toEqual(["install-ffmpeg"]);
    expect(r.setup()?.failed?.map((f) => [f.id, f.error.code])).toEqual([["install-gh", "install_failed"]]);
    r.clock.advance(3500);
    expect(r.setup()?.applying).toEqual([]);
    expect(r.setup()?.issues.map((i) => i.id)).not.toContain("install-ffmpeg");
    expect(r.setup()?.issues.map((i) => i.id)).toContain("install-gh");

    // A retry hides the old failure while it runs and clears it when it works.
    const retry = await r.apply(["install-gh"]);
    expect([retry.applying, retry.failed]).toEqual([["install-gh"], []]);
    r.clock.advance(3500);
    expect(r.setup()?.issues.map((i) => i.id)).not.toContain("install-gh");
    expect(r.setup()?.failed).toEqual([]);
  });
});
