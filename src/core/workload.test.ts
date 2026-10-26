import { describe, expect, test } from "bun:test";
import type { HostHealth } from "./gen";
import { describeLoad, hostLoad, pickHost, rankHosts, type WorkloadInput } from "./workload";

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
});
