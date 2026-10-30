/**
 * Words for a host's herdr server health (`HostInfo.herdrHealth`, architecture §3.29): what the board,
 * host card, session view and terminal say while herdr is not up, and what the tools card says about
 * loading a newer installed herdr. Pure: every text takes `now`, so the callers tick and tests pin it.
 */
import type { HerdrHealth, HerdrServerState, HerdrUpdate, HerdrUpdateMode } from "@/core/gen";

/** Panes and agents of this session are gone (or cannot be trusted): down, starting, restarting, not answering. */
export function herdrDown(h: HerdrHealth | undefined): h is HerdrHealth {
  return h !== undefined && (h.state === "down" || h.state === "starting" || h.state === "restarting" || h.state === "unresponsive");
}

/** Anything the board should say about: {@link herdrDown} plus a live handoff in progress. */
export function herdrNotUp(h: HerdrHealth | undefined): h is HerdrHealth {
  return h !== undefined && h.state !== "up";
}

/** Pane processes ended (or may have): the server stopped, as opposed to `unresponsive` (agents keep running). */
export function herdrEnded(h: HerdrHealth): boolean {
  return h.state === "down" || h.state === "starting" || h.state === "restarting";
}

/** "13:58": the user's local 24-hour clock. */
export function herdrClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "12s", "1m 05s", "14 min": a countdown. */
export function inWords(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  if (m < 120) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The restart of a server TeleFlock stopped on purpose (Restart herdr, a load without live handoff). */
function intentional(h: HerdrHealth): boolean {
  return h.cause === "restart" || h.cause === "update" || h.state === "restarting";
}

/**
 * The first line of the notice: what happened. "herdr stopped at 13:58 · 9 agents ended", "herdr crashed at
 * 13:58", "herdr is not answering", "herdr is restarting", "herdr 0.9.6 is loading".
 */
export function herdrHeadline(h: HerdrHealth): string {
  if (h.state === "unresponsive" || h.cause === "notAnswering") return "herdr is not answering";
  if (h.state === "updating") return h.update ? `herdr is loading ${h.update.to}` : "herdr is loading its update";
  if (intentional(h)) return h.update && h.cause === "update" ? `herdr is restarting to load ${h.update.to}` : "herdr is restarting";
  const word = h.cause === "crashed" ? "crashed" : "stopped";
  const at = h.downAt !== undefined ? ` at ${herdrClock(h.downAt)}` : "";
  const ended = h.endedAgents > 0 ? ` · ${plural(h.endedAgents, "agent")} ended` : "";
  return `herdr ${word}${at}${ended}`;
}

/** Why the headline is not the whole story: what TeleFlock does about it (countdown, attempt, error). */
export function herdrStatus(h: HerdrHealth, now: number): string {
  switch (h.state) {
    case "up":
      return h.version ? `herdr ${h.version} is running` : "herdr is running";
    case "unresponsive":
      return "Its agents and terminals keep running. TeleFlock doesn't restart it by itself: restart herdr if it stays stuck.";
    case "updating":
      return "Handing every pane to the new server: agents and terminals keep running.";
    case "restarting":
      return "Stopping herdr to start it again…";
    case "starting":
      return h.attempt > 1 ? `Starting herdr… (attempt ${h.attempt})` : "Starting herdr…";
    case "down": {
      if (h.restartHeld) return "herdr kept stopping soon after each start, so TeleFlock stopped restarting it by itself. Restart herdr starts it.";
      const failed = h.error && h.attempt > 0 ? `Attempt ${h.attempt} failed: ${h.error}` : null;
      if (!h.config.autoRestart) return failed ? `${failed} · automatic restart is off for this host` : "Automatic restart is off for this host";
      if (h.retryAt !== undefined) {
        const left = h.retryAt - now;
        if (failed) return `${failed} · ${left > 0 ? `next try in ${inWords(left)}` : "trying again…"}`;
        return left > 0 ? `Starting it again in ${inWords(left)}` : "Starting it again…";
      }
      return failed ?? "Waiting to start it again";
    }
  }
}

/** The state as a short label (header pill, card badge). */
export function herdrStateWord(state: HerdrServerState): string {
  switch (state) {
    case "up":
      return "herdr up";
    case "unresponsive":
      return "herdr not answering";
    case "down":
      return "herdr stopped";
    case "starting":
      return "herdr starting";
    case "restarting":
      return "herdr restarting";
    case "updating":
      return "herdr updating";
  }
}

/** How long a recovered server announces itself ("herdr is running again"), counted on this device's clock. */
export const BACK_UP_MS = 60_000;

/** The brief note after a server this device saw down is up again (the caller times it); null while it is not up or never was. */
export function herdrBackUp(h: HerdrHealth): string | null {
  if (h.state !== "up" || h.epoch < 2) return null;
  return h.keptPanes ? `herdr${h.version ? ` ${h.version}` : ""} is loaded: agents and terminals kept running` : "herdr is running again";
}

/** "herdr isn't running on forge": the terminal's title and the composer's disabled reason. */
export function herdrNotRunning(hostName: string, h: HerdrHealth | undefined): string {
  return h?.state === "unresponsive" ? `herdr isn't answering on ${hostName}` : `herdr isn't running on ${hostName}`;
}

/** The session strip's sentence for an agent shown while its host's herdr is not up. */
export function herdrAgentLine(h: HerdrHealth): string {
  if (h.state === "unresponsive") return "herdr isn't answering, so TeleFlock can't see this agent. It keeps running; the session comes back when herdr answers.";
  if (intentional(h)) return "herdr is restarting, so this agent's omp ended. TeleFlock brings it back when herdr runs again.";
  const at = h.downAt !== undefined ? ` at ${herdrClock(h.downAt)}` : "";
  return `herdr ${h.cause === "crashed" ? "crashed" : "stopped"}${at}, so this agent's omp ended. TeleFlock brings it back when herdr runs again.`;
}

/** The session header's word for an agent whose host's herdr is not up (instead of Running). */
export function herdrAgentWord(h: HerdrHealth): string {
  if (h.state === "unresponsive") return "herdr not answering";
  if (h.state === "starting") return "herdr starting";
  return h.state === "restarting" ? "herdr restarting" : "herdr stopped";
}

/** A card's time slot for an agent whose host's herdr is not up: when it stopped, instead of a running timer. */
export function herdrCardTime(h: HerdrHealth): string {
  return h.downAt !== undefined ? `since ${herdrClock(h.downAt)}` : "";
}

/** The orb of an agent whose host's herdr is not up: red while the server is stopped, otherwise at rest (never running). */
export function herdrOrbStatus(h: HerdrHealth): "error" | "idle" {
  return h.state === "down" ? "error" : "idle";
}

/** The consequence of restarting a server that still runs (confirm text). */
export function forceRestartWarning(hostName: string): string {
  return `Restart herdr on ${hostName}? Every agent and terminal of this session ends and programs running there stop. TeleFlock brings omp agents back.`;
}

/** What the card says about a pane's error: herdr's server isn't there. Matches the raw socket error and the stable code. */
export function isHerdrDownError(e: { code?: string; message?: string } | undefined): boolean {
  if (!e) return false;
  if (e.code === "server_not_running") return true;
  return /failed to connect to server|is herdr server running|server_not_running|no herdr server is reachable/i.test(e.message ?? "");
}

/** How the load will go, in the words the plan and the confirm share. */
export function modePhrase(mode: HerdrUpdateMode): string {
  return mode === "handoff" ? "Agents and terminals keep running." : "herdr restarts: running programs end, TeleFlock brings omp agents back.";
}

/** One note under the herdr chip: what is installed, what runs, what happens when. */
export interface UpdateNote {
  tone: "info" | "warn" | "ok";
  /** The first sentence(s). */
  text: string;
  /** What the load does to running work (waiting, manual). */
  mode?: string;
  /** What keeps it from loading now, or when it loads. */
  wait?: string;
}

/** The plan or outcome of loading the installed herdr into the running server. */
export function herdrUpdateNote(u: HerdrUpdate, now: number, idleMinutes: number): UpdateNote {
  switch (u.state) {
    case "waiting": {
      const text = `herdr ${u.to} is installed; the running herdr is ${u.from}. Loads by itself after ${idleMinutes} min with nothing running.`;
      let wait: string;
      if (u.idleSince !== undefined) {
        const idle = now - u.idleSince;
        const left = u.dueAt !== undefined ? u.dueAt - now : undefined;
        const mins = Math.floor(idle / 60_000);
        wait = `Idle for ${mins < 1 ? "under a minute" : `${mins} min`}${left === undefined ? "" : left > 0 ? ` · loads in ${inWords(left)}` : " · loads any moment"}`;
      } else wait = u.blockers.length > 0 ? `Waiting: ${u.blockers.join(", ")}` : "Waiting for the session to be idle";
      return { tone: "info", text, mode: modePhrase(u.mode), wait };
    }
    case "manual":
      return { tone: "info", text: `herdr ${u.to} is installed; the running herdr is ${u.from}. Automatic loading is off: Load now.`, mode: modePhrase(u.mode) };
    case "ready":
      return {
        tone: "info",
        text: `herdr update ready · Restart herdr to load ${u.to} (the running herdr is ${u.from}).`,
        mode: "This herdr can't hand its panes over, so loading stops it: running programs end and TeleFlock brings omp agents back. TeleFlock never does that by itself.",
      };
    case "running":
      return { tone: "info", text: `Loading herdr ${u.to}…` };
    case "done":
      return { tone: "ok", text: `Loaded herdr ${u.to} ${u.at !== undefined ? formatAgo(now - u.at) : "just now"}${u.mode === "handoff" ? ": agents kept running" : ""}` };
    case "failed":
      return {
        tone: "warn",
        text: `Loading herdr ${u.to} failed${u.error ? `: ${u.error}` : ""}. ${u.mode === "restart" ? "Restart herdr to try again." : "TeleFlock tries again after the next idle window."}`,
      };
  }
}

/** The sentence under the herdr settings when TeleFlock's copy of herdr's config was edited (else null). */
export function herdrConfigNote(h: HerdrHealth): string | null {
  return h.configEdited
    ? "herdr's managed config (herdr-config.toml in TeleFlock's folder) was edited, so TeleFlock keeps it and no longer copies your config.toml into it. Delete that file to start copying again."
    : null;
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** The Load now confirm: what it does to this host, per mode. */
export function loadNowConfirm(u: HerdrUpdate, hostName: string): { title: string; body: string; confirm: string; danger: boolean } {
  if (u.mode === "handoff")
    return {
      title: `Load herdr ${u.to} on ${hostName}?`,
      body: `herdr moves every pane to ${u.to}; agents and terminals keep running; open terminals reconnect.`,
      confirm: "Load now",
      danger: false,
    };
  return {
    title: `Restart herdr on ${hostName} to load ${u.to}?`,
    body: `This herdr is too old to hand its panes over, so it stops: every agent and terminal on ${hostName} ends and programs running there stop. TeleFlock brings omp agents back.`,
    confirm: "Stop and load",
    danger: true,
  };
}
