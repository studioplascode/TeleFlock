import { afterAll, describe, expect, test } from "bun:test";
import { pulseBus } from "./buses";
import { core, flushCoreEvents, openSession, pushInternal, refreshHost, selectBackend, startCoreWith } from "./client";
import { ManualClock } from "./demo/clock";
import type { AppEvent, HostProfile, HostState } from "./gen";
import { isMuted, useSettings } from "./hooks";
import { coreStore } from "./store/store";
import type { CoreTransport } from "./transport/types";

const lab: HostProfile = { id: "lab", name: "lab", kind: "tailscaleSsh", address: "aron-dev", herdrSession: "tf-lab", autoConnect: true };
const demoProfile: HostProfile = { id: "try", name: "Try the demo", kind: "demo", herdrSession: "default", autoConnect: true };

function labState(agentIds: string[]): HostState {
  return {
    info: { hostname: "aron-dev", os: "linux", arch: "x86_64", home: "/root", hostdVersion: "0.1.0", herdrSession: "tf-lab", herdrSessions: ["tf-lab"], relayPort: 47566, setup: { herdrIntegration: true, globalSharing: true, globalBridge: true, relay: true, issues: [] } },
    workspaces: [],
    agents: agentIds.map((id) => ({ id, name: id, kind: "omp", paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", state: "working", stateSince: 1, column: "running", archived: false, turns: 0, title: id, live: { streaming: false, thinking: false } })),
    usage: { costUsd: 0, tokens: 0, input: 0, output: 0 },
  };
}

/** A fake real backend (as tf-client would behave) that records calls. */
const calls: { hostId: string | null; method: string }[] = [];
let emit: (e: AppEvent) => void = () => {};
const fake: CoreTransport = {
  kind: "ws",
  async call(hostId, method, params) {
    calls.push({ hostId, method });
    switch (method) {
      case "hosts.list":
        return { profiles: [lab, demoProfile], statuses: [{ hostId: "lab", status: { phase: "online", since: 1, attempt: 0 } }, { hostId: "try", status: { phase: "error", since: 1, attempt: 0 } }] };
      case "settings.get":
        return { motion: "system", notifyNeeds: true, notifyFinished: true, notifyErrors: true, notifySound: false, keepAlive: true, terminalFontSize: 13, confirmArchive: false, defaultPlan: false, deviceName: "test", mutedAgents: ["lab::b"], templates: [] };
      case "tunnel.list":
        return { tunnels: [] };
      case "state.get":
        return labState(["a", "b", "c"]);
      case "session.open":
        return { agentId: "a", meta: { fast: false, mode: "normal", todos: [], subagents: [], files: [], queue: { steering: [], followUp: [] }, caps: {} }, items: [{ kind: "user", id: "u1", at: 1, text: "hi", images: [], steering: false, synthetic: false }], hasMore: false };
      case "settings.set":
        return params;
      default:
        return {};
    }
  },
  termInput() {},
  subscribe(cb) {
    emit = cb;
    return () => {};
  },
};

/** Lets already-resolved fake-transport promises run their continuations (no wall-clock wait). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const clock = new ManualClock();
/** Await a demo-host call while advancing the demo clock past its simulated latency. */
const demoCall = <T>(p: Promise<T>): Promise<T> => {
  clock.advance(500);
  return p;
};

startCoreWith(fake, { demoClock: clock });

afterAll(() => {
  // Detach the embedded demo host so its timers stop.
  emit({ type: "profiles", profiles: [lab] });
  flushCoreEvents();
});

describe("client pipeline", () => {
  test("bootstrap loads profiles; demo-kind host statuses come from the demo engine", async () => {
    await settle();
    flushCoreEvents();
    const s = coreStore.getState();
    expect(s.profilesLoaded).toBe(true);
    expect(s.profiles.map((p) => p.id)).toEqual(["lab", "try"]);
    expect(s.status.try?.phase).not.toBe("error");
  });

  test("a burst of events is applied in one store update", () => {
    let updates = 0;
    const off = coreStore.subscribe(() => updates++);
    emit({ type: "hostSnapshot", hostId: "lab", rev: 1, state: labState(["a"]) });
    for (let rev = 2; rev <= 30; rev++) emit({ type: "hostPatch", hostId: "lab", rev, ops: [{ op: "usage", usage: { costUsd: rev, tokens: 0, input: 0, output: 0 } }] });
    expect(updates).toBe(0);
    flushCoreEvents();
    off();
    expect(updates).toBe(1);
    expect(coreStore.getState().hosts.lab?.rev).toBe(30);
    expect(coreStore.getState().hosts.lab?.state.usage.costUsd).toBe(30);
  });

  test("pulses bypass the store and reach pulseBus synchronously", () => {
    const seen: number[] = [];
    const off = pulseBus.subscribe("lab::a", (p) => seen.push(p.n));
    let updates = 0;
    const offStore = coreStore.subscribe(() => updates++);
    emit({ type: "pulse", hostId: "lab", at: 5, pulses: [{ agentId: "a", kind: "token", n: 3 }] });
    flushCoreEvents();
    off();
    offStore();
    expect(seen).toEqual([3]);
    expect(updates).toBe(0);
  });

  test("a revision gap triggers state.get and replaces the host state", async () => {
    calls.length = 0;
    emit({ type: "hostPatch", hostId: "lab", rev: 40, ops: [] });
    flushCoreEvents();
    await settle();
    flushCoreEvents();
    expect(calls.some((c) => c.hostId === "lab" && c.method === "state.get")).toBe(true);
    expect(Object.keys(coreStore.getState().agents).filter((k) => k.startsWith("lab::")).sort()).toEqual(["lab::a", "lab::b", "lab::c"]);
    expect(coreStore.getState().hosts.lab?.rev).toBe(40);
  });

  test("openSession loads a snapshot through session.open", async () => {
    const release = openSession("lab::a");
    flushCoreEvents();
    expect(coreStore.getState().sessions["lab::a"]?.status).toBe("loading");
    await settle();
    flushCoreEvents();
    expect(coreStore.getState().sessions["lab::a"]?.status).toBe("live");
    expect(coreStore.getState().sessions["lab::a"]?.itemIds).toEqual(["u1"]);
    release();
  });

  test("demo-kind hosts route to the embedded demo engine", async () => {
    clock.advance(2000);
    flushCoreEvents();
    const s = coreStore.getState();
    expect(s.status.try?.phase).toBe("online");
    expect(Object.keys(s.agents).some((k) => k.startsWith("try::"))).toBe(true);
    calls.length = 0;
    const st = await demoCall(core.host("try").call("state.get", {}));
    expect(st.agents.length).toBeGreaterThan(5);
    expect(calls.some((c) => c.hostId === "try")).toBe(false);
    // Whatever the real core says about the demo host is ignored.
    emit({ type: "hostStatus", hostId: "try", status: { phase: "error", since: 2, attempt: 0 } });
    flushCoreEvents();
    expect(coreStore.getState().status.try?.phase).toBe("online");
    await demoCall(refreshHost("try"));
    flushCoreEvents();
    expect(calls.some((c) => c.hostId === "try")).toBe(false);
  });

  test("isMuted reads settings.mutedAgents; setMuted updates it through settings.set", async () => {
    expect(isMuted("lab::b")).toBe(true);
    expect(isMuted("lab::a")).toBe(false);
    calls.length = 0;
    await useSettings.getState().setMuted("lab::a", true);
    flushCoreEvents();
    expect(calls.some((c) => c.method === "settings.set")).toBe(true);
    expect(isMuted("lab::a")).toBe(true);
  });

  test("back-to-back settings helpers build on each other (no lost writes)", async () => {
    const s = useSettings.getState();
    const a = s.setMuted("lab::x", true);
    const b = s.setMuted("lab::y", true);
    // Optimistic state is visible synchronously, before any flush or response.
    expect(isMuted("lab::x") && isMuted("lab::y")).toBe(true);
    await Promise.all([a, b]);
    await s.saveTemplate({ id: "t1", name: "T", plan: false, prompt: "" });
    await s.removeTemplate("t1");
    await s.saveTemplate({ id: "t2", name: "T2", plan: true, prompt: "go" });
    flushCoreEvents();
    const st = coreStore.getState().settings;
    expect(st?.mutedAgents).toContain("lab::x");
    expect(st?.mutedAgents).toContain("lab::y");
    expect(st?.templates.map((t) => t.id)).toEqual(["t2"]);
  });

  test("internal events share the ordered pipeline", () => {
    pushInternal({ type: "tunnels", tunnels: [] });
    flushCoreEvents();
    expect(coreStore.getState().tunnels).toEqual([]);
  });
});

describe("backend selection", () => {
  const served = { search: "", protocol: "http:", host: "100.64.0.7:7420" };

  test("production ignores a cross-origin ?core=", () => {
    const sel = selectBackend({ ...served, search: "?core=ws://evil.example:7420/ws" }, { tauri: false, prod: true });
    expect(sel).toEqual({ kind: "ws", url: "ws://100.64.0.7:7420/ws", token: undefined, fallback: true });
    const same = selectBackend({ ...served, search: "?core=ws://100.64.0.7:7420/other" }, { tauri: false, prod: true });
    expect(same).toMatchObject({ kind: "ws", url: "ws://100.64.0.7:7420/other", fallback: false });
  });

  test("dev builds still honour ?core=", () => {
    expect(selectBackend({ ...served, search: "?core=ws://127.0.0.1:7420/ws" }, { tauri: false, prod: false })).toMatchObject({ kind: "ws", url: "ws://127.0.0.1:7420/ws" });
  });

  test("the devserver token comes from the meta tag, else ?token=", () => {
    expect(selectBackend(served, { tauri: false, prod: true, metaToken: "m" })).toMatchObject({ token: "m" });
    expect(selectBackend({ ...served, search: "?token=q" }, { tauri: false, prod: true, metaToken: "" })).toMatchObject({ token: "q" });
  });
});
