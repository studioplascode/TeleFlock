import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getAgentViews, getRoute, getWorkspacesSnapshot, useActivity, useHostState, useHosts, useUi } from "@/core";
import type { HostActivityEvent } from "@/core";
import { setupGap } from "./setupGap";

/*
 * First steps (FirstRun P10): a self-retiring checklist in the bento row, ticked by real state changes,
 * never by a script. On the demo flock it walks the six things that make TeleFlock click; on a fresh
 * real host it follows setup → first agent → first answer. Established hosts never see it.
 */

export type DemoStepId = "answerPush" | "approveLimits" | "steerKanban" | "reviewReconnect" | "dispatch" | "palette";
export type RealStepId = "setup" | "agent" | "answer";

export interface Step {
  id: string;
  label: string;
  /** One line: how to do it. */
  how: string;
  done: boolean;
}

export const DEMO_STEPS: readonly { id: DemoStepId; label: string; how: string }[] = [
  { id: "answerPush", label: "Answer push's question", how: "pick an answer on its card in Needs you" },
  { id: "approveLimits", label: "Approve limits' command", how: "Allow on its card, or select it and press A" },
  { id: "steerKanban", label: "Open kanban and steer it", how: "type while it works; Enter lands mid-turn" },
  { id: "reviewReconnect", label: "Open Review for reconnect", how: "the primary button on its card in Review" },
  { id: "dispatch", label: "Dispatch a task", how: "New task (D): pick a repo, type, Enter" },
  { id: "palette", label: "Open the palette", how: "Ctrl+K finds every action and agent" },
];

export const REAL_STEPS: readonly { id: RealStepId; label: string; how: string }[] = [
  { id: "setup", label: "Finish host setup", how: "Fix… on the strip above, or Hosts → Host setup" },
  { id: "agent", label: "Start your first agent", how: "New task (D) or New worktree (N)" },
  { id: "answer", label: "Answer its first question", how: "it lands in Needs you, answer on the card" },
];

interface FirstStepsState {
  demo: DemoStepId[];
  demoRetired: boolean;
  /** The real host being walked through, decided the first time a real host is seen online. */
  realHost?: string;
  real: RealStepId[];
  realRetired: boolean;
  /** Demo steps only count what happens after the demo checklist first appeared. */
  since?: number;
  /** Real-host steps only count what happens after the host was adopted. */
  realSince?: number;
  tick(id: DemoStepId): void;
  tickReal(id: RealStepId): void;
  retireDemo(): void;
  retireReal(): void;
  adoptRealHost(hostId: string, fresh: boolean): void;
  start(): void;
}

export const useFirstSteps = create<FirstStepsState>()(
  persist(
    (set, get) => ({
      demo: [],
      demoRetired: false,
      real: [],
      realRetired: false,
      tick: (id) => {
        if (!get().demo.includes(id)) set((s) => ({ demo: [...s.demo, id] }));
      },
      tickReal: (id) => {
        if (!get().real.includes(id)) set((s) => ({ real: [...s.real, id] }));
      },
      retireDemo: () => set({ demoRetired: true }),
      retireReal: () => set({ realRetired: true }),
      adoptRealHost: (hostId, fresh) => set(fresh ? { realHost: hostId, realSince: Date.now() } : { realHost: hostId, realRetired: true }),
      start: () => {
        if (get().since === undefined) set({ since: Date.now() });
      },
    }),
    {
      name: "tf.firstSteps",
      partialize: ({ demo, demoRetired, realHost, real, realRetired, since, realSince }) => ({ demo, demoRetired, realHost, real, realRetired, since, realSince }),
    },
  ),
);

/* ───────────── the watcher: ticks steps wherever they happen (session, review, palette) ───────────── */

let watching = false;

/** The demo checks that don't need the activity feed, run on route/palette changes and every 2 s. */
function checkDemo(): void {
  const fs = useFirstSteps.getState();
  if (fs.demoRetired) return;
  const demoIds = new Set(useHosts.getState().profiles.filter((p) => p.kind === "demo").map((p) => p.id));
  if (demoIds.size === 0) return;
  const agents = getAgentViews().filter((a) => demoIds.has(a.hostId));
  const kanban = agents.find((a) => a.name === "kanban");
  if (kanban && (kanban.omp?.queue.steering.length ?? 0) > 0) fs.tick("steerKanban");
  const route = getRoute();
  const reconnect = agents.find((a) => a.name === "reconnect");
  if (route.name === "review" && reconnect && route.hostId === reconnect.hostId && route.workspaceId === reconnect.workspaceId) fs.tick("reviewReconnect");
  if (getWorkspacesSnapshot().some((w) => demoIds.has(w.hostId) && w.ws.worktree?.branch?.startsWith("dispatch/"))) fs.tick("dispatch");
}

/** Start watching for step completions (idempotent; keeps running off the board until the checklist retires). */
function watch(): void {
  if (watching) return;
  watching = true;
  const unsubUi = useUi.subscribe((s) => {
    if (s.paletteOpen) useFirstSteps.getState().tick("palette");
  });
  window.addEventListener("hashchange", checkDemo);
  const timer = window.setInterval(() => {
    checkDemo();
    if (useFirstSteps.getState().demoRetired) {
      unsubUi();
      window.removeEventListener("hashchange", checkDemo);
      window.clearInterval(timer);
      watching = false;
    }
  }, 2000);
}

/** "You answered push" / "You approved limits": the demo writes the local user as "You". */
function answeredByYou(events: readonly HostActivityEvent[], since: number, agentName: string, kinds: readonly string[]): boolean {
  return events.some((e) => e.at >= since && e.agentName === agentName && kinds.includes(e.kind) && e.title.startsWith("You "));
}

export interface FirstStepsView {
  kind: "demo" | "real";
  hostId: string;
  steps: Step[];
  done: number;
  /** Every step ticked (demo: offer "Add your real host"; real host: retires shortly after). */
  complete: boolean;
  retire(): void;
}

/** Demo answers come from the activity feed (wherever you answered). Mount only while the demo checklist shows. */
export function useDemoAnswerTicks(demoHostId: string): void {
  const events = useActivity(demoHostId);
  const since = useFirstSteps((s) => s.since);
  useEffect(() => {
    if (since === undefined) return;
    const fs = useFirstSteps.getState();
    if (answeredByYou(events, since, "push", ["answered", "approved", "denied"])) fs.tick("answerPush");
    if (answeredByYou(events, since, "limits", ["approved"])) fs.tick("approveLimits");
  }, [events, since]);
}

/** A fresh real host's first answer (after it was adopted). Mount only while the real-host checklist shows. */
export function useRealAnswerTicks(hostId: string): void {
  const events = useActivity(hostId);
  const since = useFirstSteps((s) => s.realSince);
  useEffect(() => {
    if (since === undefined) return;
    if (events.some((e) => e.at >= since && (e.kind === "answered" || e.kind === "approved"))) useFirstSteps.getState().tickReal("answer");
  }, [events, since]);
}

/** The checklist for this device's hosts, or null when there's nothing to teach. */
export function useFirstStepsView(): FirstStepsView | null {
  const profiles = useHosts((s) => s.profiles);
  const status = useHosts((s) => s.status);
  const fs = useFirstSteps();
  const demoHost = profiles.find((p) => p.kind === "demo")?.id;
  const realProfile = profiles.find((p) => p.kind !== "demo");
  const realOnline = realProfile && status[realProfile.id]?.phase === "online" ? realProfile.id : undefined;
  const realState = useHostState(fs.realHost ?? realOnline ?? "");
  const showDemo = !!demoHost && !fs.demoRetired && !realProfile;

  useEffect(() => {
    if (!showDemo) return;
    useFirstSteps.getState().start();
    watch();
    checkDemo();
  }, [showDemo]);

  // A real host joining retires the demo tour (its last step was adding one).
  useEffect(() => {
    if (realProfile && demoHost && !fs.demoRetired) fs.retireDemo();
  }, [realProfile, demoHost, fs]);

  // real host: decide once, the first time it's online with state, whether it is fresh (no agents yet)
  useEffect(() => {
    if (fs.realHost || fs.realRetired || !realOnline || !realState) return;
    fs.adoptRealHost(realOnline, realState.agents.length === 0);
  }, [fs, realOnline, realState]);

  useEffect(() => {
    if (!fs.realHost || fs.realRetired || !realState) return;
    if (setupGap(realState.info.setup) === null) fs.tickReal("setup");
    if (realState.agents.length > 0) fs.tickReal("agent");
  }, [fs, realState]);

  // real host: retired a moment after its last tick (long enough to see it land)
  const realComplete = !!fs.realHost && !fs.realRetired && fs.real.length === REAL_STEPS.length;
  useEffect(() => {
    if (!realComplete) return;
    const t = window.setTimeout(() => useFirstSteps.getState().retireReal(), 8000);
    return () => clearTimeout(t);
  }, [realComplete]);

  if (showDemo && demoHost) {
    const steps = DEMO_STEPS.map((s) => ({ ...s, done: fs.demo.includes(s.id) }));
    const done = steps.filter((s) => s.done).length;
    return { kind: "demo", hostId: demoHost, steps, done, complete: done === steps.length, retire: fs.retireDemo };
  }
  if (fs.realHost && !fs.realRetired && profiles.some((p) => p.id === fs.realHost)) {
    const steps = REAL_STEPS.map((s) => ({ ...s, done: fs.real.includes(s.id) }));
    const done = steps.filter((s) => s.done).length;
    return { kind: "real", hostId: fs.realHost, steps, done, complete: done === steps.length, retire: fs.retireReal };
  }
  return null;
}
