import { describe, expect, test } from "bun:test";
import type { AccountLimits, HostHealth, LimitAccount, LimitWindow } from "./gen";
import { describeLoad, explainPick, hostLoad, pickHost, providerQuota, rankHosts, type WorkloadInput } from "./workload";

const health = (p: Partial<HostHealth> = {}): HostHealth => ({
  at: 1,
  cpuPct: 10,
  cores: 8,
  load1: 0.8,
  memUsed: 8e9,
  memTotal: 32e9,
  diskFree: 1e11,
  diskTotal: 1e12,
  uptimeS: 100,
  ...p,
});

const input = (hostId: string, p: Partial<WorkloadInput> = {}): WorkloadInput => ({ hostId, online: true, health: health(), running: 0, needs: 0, pending: 0, ...p });
const order = (inputs: WorkloadInput[]) => rankHosts(inputs.map(hostLoad)).map((l) => l.hostId);

describe("host workload", () => {
  test("fewer running agents wins", () => {
    expect(order([input("a", { running: 3 }), input("b", { running: 1 })])).toEqual(["b", "a"]);
  });

  test("CPU pressure is the larger of CPU% and load per core", () => {
    const busy = hostLoad(input("a", { health: health({ cpuPct: 20, load1: 12, cores: 8 }) }));
    expect(busy.cpu).toBeCloseTo(1.5);
    expect(order([input("a", { health: health({ cpuPct: 95 }) }), input("b")])).toEqual(["b", "a"]);
    // A saturated CPU outweighs one extra agent.
    expect(order([input("a", { running: 1, health: health({ cpuPct: 99, load1: 16 }) }), input("b", { running: 2 })])).toEqual(["b", "a"]);
  });

  test("memory near the limit is penalised steeply", () => {
    expect(order([input("a", { health: health({ memUsed: 31e9 }) }), input("b", { running: 2 })])).toEqual(["b", "a"]);
  });

  test("dispatches on their way count like running agents, so consecutive sends alternate", () => {
    const hosts = [input("a"), input("b")];
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const pick = pickHost(hosts.map(hostLoad));
      if (!pick) throw new Error("no host");
      picks.push(pick.hostId);
      const h = hosts.find((x) => x.hostId === pick.hostId)!;
      h.pending++;
    }
    expect(picks).toEqual(["a", "b", "a", "b"]);
  });

  test("needs-you agents weigh less than running ones", () => {
    expect(order([input("a", { running: 1 }), input("b", { needs: 2 })])).toEqual(["b", "a"]);
  });

  test("offline hosts are never picked and rank last", () => {
    expect(order([input("a", { online: false }), input("b", { running: 5 })])).toEqual(["b", "a"]);
    expect(pickHost([hostLoad(input("a", { online: false }))])).toBeNull();
    expect(pickHost([])).toBeNull();
  });

  test("ties: fewer agents on the way, then lower CPU, then the given order", () => {
    // Scores within 0.05 count as a tie.
    expect(order([input("a", { health: health({ cpuPct: 11 }) }), input("b", { health: health({ cpuPct: 10 }) })])).toEqual(["b", "a"]);
    expect(order([input("a"), input("b")])).toEqual(["a", "b"]);
    expect(order([input("b"), input("a")])).toEqual(["b", "a"]);
  });

  test("a host without health yet is assumed half busy", () => {
    expect(order([input("a", { health: undefined }), input("b", { health: health({ cpuPct: 20 }) })])).toEqual(["b", "a"]);
    expect(order([input("a", { health: undefined }), input("b", { health: health({ cpuPct: 90 }) })])).toEqual(["a", "b"]);
  });

  test("describes what the pick was based on", () => {
    expect(describeLoad(hostLoad(input("a", { running: 2, pending: 1, health: health({ cpuPct: 34, memUsed: 16e9 }) })))).toBe("2 running · 1 starting · CPU 34% · mem 50%");
    expect(describeLoad(hostLoad(input("a", { health: undefined })))).toBe("idle");
  });

  test("the chosen model's quota: more left wins, a used-up window only when nothing else can take it", () => {
    const q = (used: number, exhausted = false) => ({ label: "Claude 5 Hour", used, exhausted });
    // 70 % left beats 15 % left even with one more agent running.
    expect(order([input("a", { running: 1, quota: q(0.85) }), input("b", { running: 2, quota: q(0.3) })])).toEqual(["b", "a"]);
    // Unknown (limits not read, API key) counts as half used.
    expect(order([input("a", { quota: undefined }), input("b", { quota: q(0.2) })])).toEqual(["b", "a"]);
    expect(order([input("a", { quota: null }), input("b", { quota: q(0.9) })])).toEqual(["a", "b"]);
    expect(order([input("a", { running: 6, quota: q(0.95) }), input("b", { quota: q(1, true) })])).toEqual(["a", "b"]);
    // Without quota readings the order is the load order as before.
    expect(order([input("a", { running: 1 }), input("b")])).toEqual(["b", "a"]);
    expect(describeLoad(hostLoad(input("a", { health: undefined, quota: q(0.3) })))).toBe("idle · Claude 5 Hour 70% left");
    expect(describeLoad(hostLoad(input("a", { health: undefined, quota: q(1.2, true) })))).toBe("idle · Claude 5 Hour used up");
  });

  test("the card says why the task went there", () => {
    const q = (used: number) => ({ label: "Claude 5 Hour", used, exhausted: false });
    const name = (id: string) => (id === "a" ? "laptop" : "studio");
    const byQuota = rankHosts([input("a", { running: 1, quota: q(0.85), health: undefined }), input("b", { running: 2, quota: q(0.3), health: undefined })].map(hostLoad));
    const pick = pickHost(byQuota);
    if (!pick) throw new Error("no pick");
    expect(explainPick(pick, byQuota, name)).toBe("most Claude 5 Hour left of 2: 2 running · Claude 5 Hour 70% left (laptop: 1 running · Claude 5 Hour 15% left)");
    const byLoad = rankHosts([input("a", { running: 3, quota: q(0.1), health: undefined }), input("b", { quota: q(0.2), health: undefined })].map(hostLoad));
    const second = pickHost(byLoad);
    if (!second) throw new Error("no pick");
    expect(explainPick(second, byLoad, name)).toBe("least busy of 2: idle · Claude 5 Hour 80% left (laptop: 3 running · Claude 5 Hour 90% left)");
  });

  test("providerQuota: the binding window of the model's provider, the account with the most room", () => {
    const NOW = 1_800_000_000_000;
    const win = (p: Partial<LimitWindow>): LimitWindow => ({ id: "anthropic:5h", label: "Claude 5 Hour", status: "ok", unit: "percent", notes: [], samples: [], used: 0.4, resetsAt: NOW + 3_600_000, ...p });
    const acct = (key: string, windows: LimitWindow[], p: Partial<LimitAccount> = {}): LimitAccount => ({ key, provider: "anthropic", label: key, windows, notes: [], disabled: false, fetchedAt: NOW, ...p });
    const limits = (accounts: LimitAccount[]): AccountLimits => ({ fetchedAt: NOW, accounts, sessions: [] });
    const opus = { provider: "anthropic", id: "claude-opus-5" };
    expect(providerQuota(undefined, opus, NOW)).toBeUndefined();
    expect(providerQuota(limits([acct("x", [win({})], { provider: "openai-codex" })]), opus, NOW)).toBeNull();
    // The tightest window of an account binds (7-day at 90 % over 5-hour at 40 %).
    const one = limits([acct("a", [win({}), win({ id: "anthropic:7d", label: "Claude 7 Day", used: 0.9 })])]);
    expect(providerQuota(one, opus, NOW)).toEqual({ label: "Claude 7 Day", used: 0.9, exhausted: false });
    // Two logins: the one with more room; a disabled one never counts.
    const two = limits([acct("a", [win({ used: 0.8 })]), acct("b", [win({ used: 0.3 })]), acct("c", [win({ used: 0 })], { disabled: true })]);
    expect(providerQuota(two, opus, NOW)?.used).toBe(0.3);
    // A window whose reset has passed counts as fresh; tier windows only for models naming the tier.
    expect(providerQuota(limits([acct("a", [win({ used: 1, status: "exhausted", resetsAt: NOW - 1 })])]), opus, NOW)).toEqual({ label: "Claude 5 Hour", used: 0, exhausted: false });
    const tiered = limits([acct("a", [win({ used: 0.2 }), win({ id: "anthropic:7d:opus", label: "Claude 7 Day Opus", tier: "opus", used: 1, status: "exhausted" })])]);
    expect(providerQuota(tiered, opus, NOW)).toEqual({ label: "Claude 7 Day Opus", used: 1, exhausted: true });
    expect(providerQuota(tiered, { provider: "anthropic", id: "claude-sonnet-5" }, NOW)?.used).toBe(0.2);
  });
});
