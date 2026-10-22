import { describe, expect, test } from "bun:test";
import type { ConnStatus } from "@/core/gen";
import { connSummary, hostsHealth } from "./status";

describe("hostsHealth", () => {
  test("worst phase wins the orb", () => {
    expect(hostsHealth(["online", "hostKey", "error"]).orb).toBe("needs-you");
    expect(hostsHealth(["online", "error"]).orb).toBe("error");
    expect(hostsHealth(["online", "connecting"]).orb).toBe("running");
    expect(hostsHealth(["online", "online"])).toEqual({ orb: "done", degraded: false, online: 2, total: 2 });
  });

  test("never green while a host is down", () => {
    expect(hostsHealth(["online", "offline"])).toEqual({ orb: "idle", degraded: true, online: 1, total: 2 });
    expect(hostsHealth(["idle", "offline"])).toEqual({ orb: "idle", degraded: false, online: 0, total: 2 });
  });
});

describe("connSummary", () => {
  test("latency online, short reason on error, phase otherwise", () => {
    expect(connSummary({ phase: "online", since: 0, attempt: 0, latencyMs: 58.6 })).toBe("59 ms");
    const err: ConnStatus = { phase: "error", since: 0, attempt: 1, error: { code: "not_connected", message: "x" } } as ConnStatus;
    expect(connSummary(err)).toBe("Error · unreachable");
    expect(connSummary({ phase: "offline", since: 0, attempt: 0 })).toBe("Offline");
    expect(connSummary(undefined)).toBe("Not connected");
  });
});
