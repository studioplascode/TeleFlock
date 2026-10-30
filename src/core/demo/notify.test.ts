import { describe, expect, test } from "bun:test";
import type { NotifyConfig, NotifyTestResult } from "../gen";
import { DemoNotify, maskTarget } from "./notify";

const make = (supported = true) => new DemoNotify({ supported, now: () => 1_700_000_000_000 });
const call = <T>(n: DemoNotify, method: string, params: unknown = {}): T => n.call(method, params as Record<string, unknown>) as T;

describe("demo notify.*", () => {
  test("seeded policy, one ntfy channel with only its saved fields listed, three devices", () => {
    const c = call<NotifyConfig>(make(), "notify.config");
    expect(c.policy).toEqual({ route: true, escalateAfterS: 300, escalateTo: "phones" });
    expect(c.channels).toHaveLength(1);
    expect(c.channels[0]).toMatchObject({ kind: "ntfy", target: "ntfy.sh · topic tf-…k2", saved: ["url"], last: { ok: true } });
    expect(JSON.stringify(c)).not.toContain("tf-7f3a91ck2");
    expect(c.devices.map((d) => [d.name, d.me, d.presence?.state])).toEqual([
      ["This device", true, "active"],
      ["Pixel 9", false, "idle"],
      ["old-laptop", false, undefined],
    ]);
  });

  test("setPolicy validates and answers the new config", () => {
    const n = make();
    expect(call<NotifyConfig>(n, "notify.setPolicy", { route: false, escalateAfterS: 0, escalateTo: "all" }).policy).toEqual({ route: false, escalateAfterS: 0, escalateTo: "all" });
    expect(() => call(n, "notify.setPolicy", { route: true, escalateAfterS: -5, escalateTo: "all" })).toThrow();
  });

  test("a channel keeps stored secrets unless one is sent; empty deletes it", () => {
    const n = make();
    const base = { kind: "pushover", name: "Phone", enabled: true, when: "always", kinds: ["needs"], private: true };
    const added = call<NotifyConfig>(n, "notify.saveChannel", { ...base, token: "app-token", user: "user-key-1234" });
    const ch = added.channels.find((c) => c.name === "Phone");
    expect(ch).toMatchObject({ target: "Pushover · user …1234", saved: ["token", "user"], private: true });
    // only non-secret fields: both secrets stay
    const renamed = call<NotifyConfig>(n, "notify.saveChannel", { ...base, id: ch?.id, name: "Phone 2", enabled: false });
    expect(renamed.channels.find((c) => c.id === ch?.id)).toMatchObject({ name: "Phone 2", enabled: false, saved: ["token", "user"] });
    // a required secret cannot be deleted
    expect(() => call(n, "notify.saveChannel", { ...base, id: ch?.id, user: "" })).toThrow();
  });

  test("validation errors carry a hint", () => {
    const n = make();
    expect(() => call(n, "notify.saveChannel", { kind: "ntfy", name: "x", enabled: true, when: "offline", kinds: [], private: false })).toThrow(/topic URL/);
    expect(() => call(n, "notify.saveChannel", { kind: "webhook", name: "x", enabled: true, when: "offline", kinds: [], private: false, url: "ftp://x" })).toThrow();
  });

  test("removeChannel drops it; test alerts the devices in use or pushes", () => {
    const n = make();
    const test = (p: unknown) => call<NotifyTestResult>(n, "notify.test", p);
    expect(test({ escalate: true }).alerted).toEqual(["This device"]);
    call(n, "notify.setPolicy", { route: false, escalateAfterS: 0, escalateTo: "phones" });
    expect(test({ escalate: false }).alerted).toEqual(["This device", "Pixel 9", "old-laptop"]);
    expect(test({ channelId: "ch-ntfy", escalate: false }).push).toMatchObject({ ok: true, test: true });
    expect(call<NotifyConfig>(n, "notify.config").channels[0]?.last?.test).toBe(true);
    expect(call<NotifyConfig>(n, "notify.removeChannel", { id: "ch-ntfy" }).channels).toEqual([]);
    expect(() => call(n, "notify.removeChannel", { id: "ch-ntfy" })).toThrow();
  });

  test("a host older than 0.7.0 answers unknown_method", () => {
    expect(() => call(make(false), "notify.config")).toThrow(/Unknown method/);
    try {
      call(make(false), "notify.config");
    } catch (e) {
      expect(e).toMatchObject({ code: "unknown_method" });
    }
  });

  test("masked targets never contain the secret", () => {
    expect(maskTarget("webhook", { url: "https://hooks.example.com/abc/secret-path" })).toBe("hooks.example.com");
    expect(maskTarget("ntfy", { url: "https://ntfy.example/ops" })).toBe("ntfy.example · topic ops");
  });
});
