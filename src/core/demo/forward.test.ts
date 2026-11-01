import { describe, expect, test } from "bun:test";
import type { AppEvent, ForwardList, ForwardRule } from "../gen";
import { ManualClock } from "./clock";
import { DemoForwards, type ForwardHost } from "./forward";

function rig() {
  const clock = new ManualClock();
  const events: ForwardList[] = [];
  const hosts: ForwardHost[] = [
    { id: "forge", name: "forge", online: true },
    { id: "studio-pc", name: "studio-pc", online: false },
  ];
  const fw = new DemoForwards({
    clock,
    hosts: () => hosts,
    emit: (e: AppEvent) => {
      if (e.type === "forwards") events.push(e.forwards);
    },
  });
  fw.seed();
  const setOnline = (id: string, online: boolean) => {
    const h = hosts.find((x) => x.id === id);
    if (h) h.online = online;
    fw.hostsChanged();
  };
  return { clock, fw, events, hosts, setOnline };
}

const rule = (over: Partial<ForwardRule> = {}): ForwardRule => ({ id: "", fromHost: "forge", toHost: "studio-pc", name: "laptop", enabled: true, shell: true, tools: [], ports: [], ...over });

describe("demo forwarding", () => {
  test("seeded rules wait for their hosts; streams open when both are connected and end when one drops", () => {
    const r = rig();
    const first = r.fw.list();
    expect(first.rules.map((x) => x.name)).toEqual(["studio-pc", "forge"]);
    expect(first.status[0]).toMatchObject({ state: "waiting", message: "Waiting for studio-pc to connect" });
    expect(first.streams).toEqual([]);

    r.setOnline("studio-pc", true);
    const ready = r.fw.list();
    expect(ready.status.map((s) => s.state)).toEqual(["ready", "ready"]);
    expect(ready.streams.map((s) => s.kind).sort()).toEqual(["command", "port", "tool"]);
    // The second rule's from-host cannot bind 5432: reported as a port error, the rule stays ready.
    expect(ready.status[1]?.portErrors).toEqual([{ listen: 5432, message: expect.stringContaining("already in use") }]);

    r.setOnline("studio-pc", false);
    expect(r.fw.list().streams).toEqual([]);
  });

  test("save validates with the core's field-prefixed messages and returns the list", () => {
    const r = rig();
    expect(() => r.fw.save(rule({ name: "Bad Name" }))).toThrow(/^name: use 1–32 lowercase letters/);
    expect(() => r.fw.save(rule({ toHost: "forge" }))).toThrow("toHost: choose a host other than the one the forward is used from");
    expect(() => r.fw.save(rule({ fromHost: "nope" }))).toThrow("fromHost: no host nope");
    expect(() => r.fw.save(rule({ name: "studio-pc" }))).toThrow('name: forge already has a forward called "studio-pc"');
    expect(() => r.fw.save(rule({ shell: false }))).toThrow("shell: turn on the shell, a tool or a port");
    expect(() => r.fw.save(rule({ tools: ["a b"] }))).toThrow(/^tools: "a b" is not a command name/);
    expect(() => r.fw.save(rule({ ports: [{ listen: 9222, target: 1 }] }))).toThrow('ports: forge already listens on 9222 in forward "studio-pc"');

    const saved = r.fw.save(rule({ ports: [{ listen: 9333, target: 9222 }] }));
    expect(saved.rules.at(-1)).toMatchObject({ name: "laptop", id: expect.stringContaining("fr-") });
    expect(r.events.at(-1)).toEqual(saved);
  });

  test("editing keeps the rule's own name and ports free; unknown ids are not_found", () => {
    const r = rig();
    const id = r.fw.list().rules[0]?.id ?? "";
    const edited = r.fw.save({ ...(r.fw.list().rules[0] as ForwardRule), tools: [], enabled: true });
    expect(edited.rules[0]).toMatchObject({ id, tools: [] });
    expect(() => r.fw.save(rule({ id: "fr-99" }))).toThrow("Unknown forward fr-99");
    expect(() => r.fw.remove("fr-99")).toThrow("Unknown forward fr-99");
    expect(() => r.fw.stop("fs-99")).toThrow("Unknown stream fs-99");
  });

  test("turning a rule off ends its streams; removing it drops it; stop ends one stream", () => {
    const r = rig();
    r.setOnline("studio-pc", true);
    const [a] = r.fw.list().rules as [ForwardRule];
    const streams = r.fw.list().streams;
    expect(streams).toHaveLength(3);
    const afterStop = r.fw.stop(streams[0]?.id ?? "");
    expect(afterStop.streams).toHaveLength(2);

    const off = r.fw.save({ ...a, enabled: false });
    expect(off.status[0]?.state).toBe("disabled");
    expect(off.streams).toEqual([]);

    expect(r.fw.remove(a.id).rules.map((x) => x.name)).toEqual(["forge"]);
  });

  test("saving a rule without the tool or shell ends the streams that used them", () => {
    const r = rig();
    r.setOnline("studio-pc", true);
    const [a] = r.fw.list().rules as [ForwardRule];
    const next = r.fw.save({ ...a, shell: false, tools: [] });
    expect(next.streams.map((s) => s.kind)).toEqual(["port"]);
  });

  test("byte counters move about every two seconds while streams are open", () => {
    const r = rig();
    r.setOnline("studio-pc", true);
    const before = r.fw.list().streams[0]?.bytesDown ?? 0;
    const events = r.events.length;
    r.clock.advance(4100);
    expect(r.fw.list().streams[0]?.bytesDown).toBeGreaterThan(before);
    expect(r.events.length - events).toBe(2);
  });

  test("a removed host takes its rules along", () => {
    const r = rig();
    r.hosts.pop();
    r.fw.hostsChanged();
    expect(r.fw.list().rules).toEqual([]);
  });
});
