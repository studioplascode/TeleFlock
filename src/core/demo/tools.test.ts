import { describe, expect, test } from "bun:test";
import type { ToolUpdates } from "../gen";
import { ManualClock } from "./clock";
import { DemoTools } from "./tools";

function setup(variant: "forge" | "studio") {
  const clock = new ManualClock();
  const changes: { tools: ToolUpdates; installed: string | null }[] = [];
  const tools = new DemoTools(variant, clock, (t, installed) => changes.push({ tools: t, installed }));
  return { clock, tools, changes };
}

/** Moves the manual clock in 100 ms steps; between steps, pending promise continuations run and register their next timers. */
async function advance(clock: ManualClock, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    clock.advance(100);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

describe("demo tool updates", () => {
  test("forge: check finds the omp update, concurrent requests join, update installs it", async () => {
    const { clock, tools, changes } = setup("forge");
    expect(tools.status().omp.latest).toBe("18.12.6");
    const a = tools.call("host.toolsUpdate", { checkOnly: true });
    const b = tools.call("host.toolsUpdate", { tool: "omp", checkOnly: true });
    expect(tools.status().omp.updating).toBe(true);
    await advance(clock, 3000);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra.omp).toMatchObject({ current: "18.12.3", latest: "18.12.6", updating: false });
    expect(changes.filter((c) => c.tools.omp.updating).length).toBe(1);

    const run = tools.call("host.toolsUpdate", { tool: "omp", checkOnly: false });
    await advance(clock, 5000);
    const done = await run;
    expect(done.omp).toMatchObject({ current: "18.12.6", updating: false });
    expect(done.omp.latest).toBeUndefined();
    expect(changes.at(-1)?.installed).toBe("omp");
  });

  test("forge: the first automatic run installs 2 minutes after start", async () => {
    const { clock, tools } = setup("forge");
    await advance(clock, 2 * 60_000 + 6000);
    expect(tools.status().omp).toMatchObject({ current: "18.12.6", updating: false });
    expect(tools.status().nextCheckAt).toBeGreaterThan(clock.now() + 5 * 3_600_000);
  });

  test("studio: auto off; a Homebrew herdr is never installed", async () => {
    const { clock, tools } = setup("studio");
    expect(tools.status()).toMatchObject({ auto: false });
    expect(tools.status().nextCheckAt).toBeUndefined();
    const run = tools.call("host.toolsUpdate", { tool: "herdr", checkOnly: false });
    await advance(clock, 3000);
    const s = await run;
    expect(s.herdr).toMatchObject({ current: "0.9.0", latest: "0.9.5" });
    expect(s.herdr.note).toContain("Homebrew");
    const on = await tools.call("host.toolsConfig", { auto: true });
    expect(on.auto).toBe(true);
    expect(on.nextCheckAt).toBe(clock.now() + 120_000);
    await expect(tools.call("host.toolsUpdate", { tool: "brew", checkOnly: true })).rejects.toThrow("unknown tool");
  });
});
