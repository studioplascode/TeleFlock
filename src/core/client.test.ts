import { afterAll, describe, expect, test } from "bun:test";
import { pulseBus, termBus } from "./buses";
import { checkSessionHeal, closeSession, core, flushCoreEvents, onAppEvent, openSession, pushInternal, refreshHost, selectBackend, startCoreWith, watchActivity } from "./client";
import { ManualClock } from "./demo/clock";
import type { ActivityEvent, Agent, AppEvent, HostProfile, HostState, StatePatch, ToolStatus, TranscriptItem } from "./gen";
import { isMuted, useSettings } from "./hooks";
import { coreStore } from "./store/store";
import { createTauriTransport } from "./transport/tauri";
import type { CoreTransport } from "./transport/types";
import { useUi } from "./ui";

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
/** Answers for the next `session.open`s, first in first used (then the canned snapshot). */
const openAnswers: Promise<unknown>[] = [];
/** What the lab host's `host.activity` answers, newest first. */
const activityLog: ActivityEvent[] = [];
let emit: (e: AppEvent) => void = () => {};
const fake: CoreTransport = {
  kind: "ws",
  async call(hostId, method, params) {
    calls.push({ hostId, method });
    switch (method) {
      case "hosts.list":
        return { profiles: [lab, demoProfile], statuses: [{ hostId: "lab", status: { phase: "online", since: 1, attempt: 0 } }, { hostId: "try", status: { phase: "error", since: 1, attempt: 0 } }] };
      case "settings.get":
        return { motion: "system", notifyNeeds: true, notifyFinished: true, notifyErrors: true, notifySound: false, keepAlive: true, terminalFontSize: 13, defaultPlan: false, deviceName: "test", mutedAgents: ["lab::b"], templates: [], autoUpdate: true };
      case "tunnel.list":
        return { tunnels: [] };
      case "state.get":
        return labState(["a", "b", "c"]);
      case "session.open":
        return openAnswers.shift() ?? { agentId: "a", meta: { fast: false, mode: "normal", todos: [], subagents: [], files: [], queue: { steering: [], followUp: [] }, caps: {} }, items: [{ kind: "user", id: "u1", at: 1, text: "hi", images: [], steering: false, synthetic: false }], hasMore: false };
      case "settings.set":
        return params;
      case "host.activity":
        return { events: [...activityLog], hasMore: false };
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

  test("only the latest session.open of a session counts: an older one failing late changes nothing", async () => {
    let failFirst: (e: unknown) => void = () => {};
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    openAnswers.push(new Promise((_, reject) => (failFirst = reject)));
    openSession("lab::b");
    // Closed while that open is in flight, then opened again (answered at once).
    closeSession("lab::b");
    openSession("lab::b");
    await settle();
    flushCoreEvents();
    expect(coreStore.getState().sessions["lab::b"]?.status).toBe("live");
    failFirst({ code: "not_connected", message: "the session was closed while it opened", retryable: true });
    await settle();
    flushCoreEvents();
    expect(coreStore.getState().sessions["lab::b"]?.status).toBe("live");
    closeSession("lab::b");
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

  test("one throwing listener costs no other event: a Tauri batch still reaches every listener and the store", () => {
    flushCoreEvents();
    const raw: string[] = [];
    const pulses: number[] = [];
    const frames: number[] = [];
    const offs = [
      onAppEvent((e) => {
        if (e.type === "pulse") throw new Error("a raw listener breaks");
      }),
      onAppEvent((e) => raw.push(e.type)),
      pulseBus.subscribe("lab::a", () => {
        throw new Error("a pulse listener breaks");
      }),
      pulseBus.subscribe("lab::a", (p) => pulses.push(p.n)),
      termBus.subscribe("lab", "t9", () => {
        throw new Error("a terminal listener breaks");
      }),
      termBus.subscribe("lab", "t9", (ev) => {
        if (ev.k === "frame") frames.push(ev.seq);
      }),
    ];
    // The shell's channel feeds a listener that throws on every event, then the runtime.
    const tauri = tauriEvents(() => {
      throw new Error("a transport listener breaks");
    }, emit);
    const rev = (coreStore.getState().hosts.lab?.rev ?? 0) + 1;
    quiet(() =>
      tauri.deliver([
        { type: "pulse", hostId: "lab", at: 9, pulses: [{ agentId: "a", kind: "token", n: 4 }] },
        { type: "term", hostId: "lab", termId: "t9", ev: { k: "frame", seq: 7, full: true, cols: 80, rows: 24, data: "" } },
        { type: "hostPatch", hostId: "lab", rev, ops: [{ op: "usage", usage: { costUsd: 42, tokens: 0, input: 0, output: 0 } }] },
      ]),
    );
    flushCoreEvents();
    tauri.close();
    for (const off of offs) off();
    expect(raw).toEqual(["pulse", "term", "hostPatch"]);
    expect(pulses).toEqual([4]);
    expect(frames).toEqual([7]);
    expect(coreStore.getState().hosts.lab?.state.usage.costUsd).toBe(42);
  });

  test("a malformed event costs only itself: the rest of its frame applies, effects included", async () => {
    openAnswers.push(Promise.resolve(snapshotOf("m", [user("u1")])));
    openSession("lab::m");
    await settle();
    flushCoreEvents();
    useUi.getState().setAnswerNext(false);
    const off = coreStore.subscribe(() => {
      throw new Error("a store subscriber breaks");
    });
    const rev = (coreStore.getState().hosts.lab?.rev ?? 0) + 1;
    quiet(() => {
      emit({ type: "hostPatch", hostId: "lab", rev, ops: [{ op: "usage", usage: { costUsd: 43, tokens: 0, input: 0, output: 0 } }] });
      // An upsert without its row: the reducer throws on it.
      emit({ type: "session", hostId: "lab", agentId: "m", ev: { k: "upsert" } } as unknown as AppEvent);
      emit({ type: "session", hostId: "lab", agentId: "m", ev: { k: "upsert", item: said("s1") } });
      emit({ type: "answerNext" });
      flushCoreEvents();
    });
    off();
    expect(coreStore.getState().hosts.lab?.state.usage.costUsd).toBe(43);
    expect(coreStore.getState().sessions["lab::m"]?.itemIds).toEqual(["u1", "s1"]);
    expect(useUi.getState().answerNextOpen).toBe(true);
    useUi.getState().setAnswerNext(false);
    closeSession("lab::m");
  });

  test("an open transcript left behind by its host re-opens itself and settles", async () => {
    const key = "lab::s";
    patchLab([{ op: "agent", id: "s", value: ompAgent("s", "running") }]);
    // Mid-turn: a redacted thought, then two tool calls.
    openAnswers.push(Promise.resolve(snapshotOf("s", [user("u1"), thought("th1"), tool("t1", "pending"), tool("t2", "pending")])));
    openSession(key);
    await settle();
    flushCoreEvents();
    expect(coreStore.getState().sessions[key]?.status).toBe("live");
    // One update arrives; the ones that settle both calls are lost on the way.
    emit({ type: "session", hostId: "lab", agentId: "s", ev: { k: "upsert", item: tool("t1", "running") } });
    // The host says the turn is over: Review, nothing live.
    patchLab([{ op: "agent", id: "s", value: ompAgent("s", "review") }]);
    const t0 = Date.now();
    const opens = () => calls.filter((c) => c.method === "session.open").length;
    const before = opens();
    expect(checkSessionHeal(t0)).toEqual([]);
    expect(checkSessionHeal(t0 + 29_000)).toEqual([]);
    openAnswers.push(Promise.resolve(snapshotOf("s", [user("u1"), thought("th1"), tool("t1", "ok"), tool("t2", "ok"), said("s1")])));
    expect(quiet(() => checkSessionHeal(t0 + 30_000))).toEqual([key]);
    expect(opens()).toBe(before + 1);
    await settle();
    flushCoreEvents();
    const items = coreStore.getState().sessions[key]?.items;
    expect([items?.t1, items?.t2]).toMatchObject([{ status: "ok" }, { status: "ok" }]);
    // It agrees with its host again: nothing more to do.
    expect(checkSessionHeal(t0 + 120_000)).toEqual([]);
    expect(opens()).toBe(before + 1);
    closeSession(key);
  });

  test("an activity feed mounted again shows what its host logged while nobody watched", async () => {
    activityLog.push({ id: "e1", at: 1, agentId: "a", agentName: "a", kind: "modelChanged", title: "Model → sonnet" });
    let unwatch = watchActivity("lab", ["lab"]);
    await settle();
    flushCoreEvents();
    expect(coreStore.getState().activity.lab?.events.map((e) => e.id)).toEqual(["e1"]);
    unwatch();
    // Logged while the Activity page is closed: no lane change or notification refreshes an unwatched feed.
    activityLog.unshift({ id: "e2", at: 2, agentId: "a", agentName: "a", kind: "modelChanged", title: "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued" });
    unwatch = watchActivity("lab", ["lab"]);
    await settle();
    flushCoreEvents();
    expect(coreStore.getState().activity.lab?.events.map((e) => e.id)).toEqual(["e2", "e1"]);
    unwatch();
  });
});

/** Runs `fn` with console.error/warn muted: the failures it provokes are reported there. */
function quiet<T>(fn: () => T): T {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

/** A real Tauri transport on a mocked shell: `deliver(batch)` is one `core_events` channel message to `listeners` (subscribed in order). */
function tauriEvents(...listeners: ((e: AppEvent) => void)[]): { deliver(batch: AppEvent[]): void; close(): void } {
  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  const prev = g.window;
  let onRaw: (raw: { index: number; message: AppEvent[] }) => void = () => {};
  let index = 0;
  g.window = {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: typeof onRaw) => {
        onRaw = cb;
        return 1;
      },
      invoke: () => new Promise(() => {}),
    },
  };
  let offs: (() => void)[] = [];
  try {
    const t = createTauriTransport();
    offs = listeners.map((l) => t.subscribe(l));
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
  return {
    deliver: (batch) => onRaw({ index: index++, message: batch }),
    close: () => {
      for (const off of offs) off();
    },
  };
}

/** Applies `ops` to the lab host as its next revision. */
function patchLab(ops: StatePatch[]): void {
  flushCoreEvents();
  emit({ type: "hostPatch", hostId: "lab", rev: (coreStore.getState().hosts.lab?.rev ?? 0) + 1, ops });
  flushCoreEvents();
}

function ompAgent(id: string, column: "running" | "review"): Agent {
  const running = column === "running";
  return {
    id, name: id, kind: "omp", paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", state: running ? "working" : "idle", stateSince: 1, column, archived: false, turns: 1, title: id,
    live: { streaming: false, thinking: running },
    omp: { link: "live", bridge: true, fast: false, mode: "normal", queue: { steering: [], followUp: [] } },
  };
}

const snapshotOf = (agentId: string, items: TranscriptItem[]) => ({ agentId, meta: { fast: false, mode: "normal", todos: [], subagents: [], files: [], queue: { steering: [], followUp: [] }, caps: {} }, items, hasMore: false });
const user = (id: string): TranscriptItem => ({ kind: "user", id, at: 1, text: "go", images: [], steering: false, synthetic: false });
const thought = (id: string): TranscriptItem => ({ kind: "thinking", id, at: 2, text: "", streaming: false, redacted: true });
const said = (id: string): TranscriptItem => ({ kind: "assistant", id, at: 3, text: "Done.", streaming: false });
const tool = (id: string, status: ToolStatus): TranscriptItem => ({ kind: "tool", id, at: 4, callId: id, tool: "bash", title: "bun test", args: {}, status, truncated: false });

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
