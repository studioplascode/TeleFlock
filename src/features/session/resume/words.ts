import type { AgentEnded, AutoResume, RetryResult, RetryWait } from "@/core/gen";
import { ACTIONS } from "@/features/shell/vocab";

/**
 * Provider stops this build names (`usage`: usage windows tell when they pass); a `restart` ticket has
 * words of its own, any other kind reads as a plain stop. The same words as `RETRY_KINDS`.
 */
const KINDS: Record<string, { word: string; short: string; usage?: true }> = {
  usageLimit: { word: "Usage limit", short: "Limit", usage: true },
  rateLimit: { word: "Rate limit", short: "Limit", usage: true },
  overloaded: { word: "Overloaded", short: "Overloaded" },
  providerError: { word: "Provider error", short: "Provider error" },
};
const STOPPED = { word: "Stopped", short: "Stopped" };

/**
 * An agent's omp ended without anyone closing it (herdr stopped or crashed, a reboot, omp crashed): an
 * ended card (`Parked.ended`) is brought back, a live agent cut off mid-turn goes on where it stopped (§3.25).
 */
const isRestart = (ar: AutoResume) => (ar.kind as string) === "restart";

/** Locale and zone of clock texts: the device's, pinned by tests. `hourCycle: "h23"`: a 24-hour clock whatever the locale. */
export interface ClockOptions {
  locale?: string;
  timeZone?: string;
  hourCycle?: Intl.DateTimeFormatOptions["hourCycle"];
}

/** What a ticket's words need besides the clock: the card's end (`Parked.ended`) when its omp ended. */
export interface TicketOptions extends ClockOptions {
  ended?: AgentEnded;
}

const NEAR_MS = 6 * 86_400_000;

function dayOf(t: number, o: ClockOptions): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: o.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

/** A moment on this device's clock: "03:00" today, "Tue 03:00" within the week around today, "13 Nov, 03:00" beyond. */
export function formatClock(at: number, now: number, o: ClockOptions = {}): string {
  const time = new Intl.DateTimeFormat(o.locale, { hour: "2-digit", minute: "2-digit", hourCycle: o.hourCycle, timeZone: o.timeZone }).format(at);
  if (dayOf(at, o) === dayOf(now, o)) return time;
  if (Math.abs(at - now) < NEAR_MS) return `${new Intl.DateTimeFormat(o.locale, { weekday: "short", timeZone: o.timeZone }).format(at)} ${time}`;
  return `${new Intl.DateTimeFormat(o.locale, { month: "short", day: "numeric", timeZone: o.timeZone }).format(at)}, ${time}`;
}

/** When a resume is due, as the estimate it is (host clock): "~03:00", "~Tue 03:00"; "~now" once due. */
export function formatResumeAt(at: number, now: number, o: ClockOptions = {}): string {
  return at <= now ? "~now" : `~${formatClock(at, now, o)}`;
}

/** The clock a ticket's words need: seconds for a restart's short countdown, else minutes. */
export function ticketTickMs(ar: AutoResume): number {
  return isRestart(ar) && ar.status === "waiting" ? 1000 : 60_000;
}

/** The two actions a ticket offers (strip, card menu): Resume now (`agent.autoResumeNow`), and dropping it (`agent.autoResumeCancel`). */
export interface TicketActions {
  resume: string;
  cancel: string;
  /** It won't resume by itself anyway: cancelling only dismisses it. */
  dismiss: boolean;
  /** One line each: what the action does (tooltips, menu second lines). */
  resumeHint: string;
  cancelHint: string;
}

/** Null while it resumes. A restart ticket continues (an ended card is brought back first); a limit resumes. */
export function ticketActions(ar: AutoResume, o: TicketOptions = {}): TicketActions | null {
  if (ar.status === "resuming") return null;
  const manual = ar.status === "manual";
  if (isRestart(ar)) {
    const resume = manual ? "Continue" : "Continue now";
    if (o.ended) {
      const resumeHint = "Bring it back now: omp reopens its session and it goes on where it stopped";
      return manual
        ? { resume, cancel: "Dismiss", dismiss: true, resumeHint, cancelHint: "Don't bring it back: it moves to Done, where it resumes when you need it" }
        : { resume, cancel: "Don't auto-continue", dismiss: false, resumeHint, cancelHint: "It stays ended until you continue it" };
    }
    const resumeHint = "Go on where it stopped, now";
    return manual
      ? { resume, cancel: "Dismiss", dismiss: true, resumeHint, cancelHint: "Forget this stop; continue it yourself when you want" }
      : { resume, cancel: "Don't auto-continue", dismiss: false, resumeHint, cancelHint: "It stays stopped until you continue it" };
  }
  const resumeHint = ACTIONS.resumeNow.description;
  return manual
    ? { resume: ACTIONS.resumeNow.label, cancel: ACTIONS.dismissAutoResume.label, dismiss: true, resumeHint, cancelHint: ACTIONS.dismissAutoResume.description }
    : { resume: ACTIONS.resumeNow.label, cancel: ACTIONS.noAutoResume.label, dismiss: false, resumeHint, cancelHint: ACTIONS.noAutoResume.description };
}

const BASIS: Record<string, string> = {
  window: "Resumes when the account's usage window resets.",
  hint: "Resumes at the reset time the provider gave.",
  backoff: "No reset time known: checks usage again at growing intervals.",
};

/** The session header strip of an auto-resume ticket. */
export interface StripWords {
  /** One line: what stopped it and what happens next. */
  text: string;
  /** Tooltip lines: the reason, provider · model, since when, what the time rests on. */
  detail: string[];
  tone: "wait" | "busy" | "manual";
  actions: TicketActions | null;
}

/** The line for a restart ticket: a seconds countdown while it waits (`ticketTickMs`). An ended card is brought back; a live one goes on. */
function restartText(ar: AutoResume, now: number, ended: AgentEnded | undefined): string {
  const left = ar.status === "waiting" && ar.resumeAt != null && ar.resumeAt > now ? countdown(ar.resumeAt - now) : null;
  if (ended) {
    if (ar.status !== "manual") return left ? `Bringing it back in ${left}` : "Bringing it back…";
    // manual: `reason` says why it waits for Continue (the host's setting, Don't, failed tries)
    return ar.reason && ar.reason !== ended.reason ? `Ended: ${ended.reason} · ${ar.reason}` : `Ended: ${ended.reason}`;
  }
  if (ar.status === "manual") return `Cut off mid-turn · ${ar.reason}`;
  if (ar.status === "resuming") return "Continuing…";
  return left ? `Continuing where it stopped in ${left}` : "Continuing where it stopped…";
}

/** An ended card's words (`Parked.ended`): its chip, the strip while it has no ticket (herdr is down), their tooltip. */
export interface EndedWords {
  /** "ended 13:58" (24-hour, like herdr's own words; weekday or date when not today). */
  chip: string;
  /** "Ended at 13:58 (herdr stopped)"; while herdr is down "… · comes back when herdr runs again". */
  text: string;
  /** What it was doing, in hostd's words: "It was in bash: sleep 30", "It was working", "It was writing a reply", "It was idle". */
  detail: string[];
}

export function endedWords(e: AgentEnded, now: number, o: ClockOptions & { herdrDown?: boolean } = {}): EndedWords {
  const at = formatClock(e.at, now, { ...o, hourCycle: "h23" });
  const text = `Ended at ${at} (${e.reason})`;
  const doing = e.turn === "working" ? (e.lastAction ? `It was in ${e.lastAction}` : "It was working") : e.turn === "replying" ? "It was writing a reply" : "It was idle";
  return {
    chip: `ended ${at}`,
    text: o.herdrDown ? `${text} · comes back when herdr runs again` : text,
    detail: e.lastAction && e.turn !== "working" ? [doing, `Last action: ${e.lastAction}`] : [doing],
  };
}

function limitText(ar: AutoResume, now: number, o: ClockOptions): string {
  const kind = KINDS[ar.kind] ?? STOPPED;
  switch (ar.status) {
    case "waiting":
      return ar.resumeAt != null ? `${kind.word} · ${ar.basis === "backoff" ? "checks again" : "resumes"} ${formatResumeAt(ar.resumeAt, now, o)}` : kind.word;
    case "checking":
      return KINDS[ar.kind]?.usage ? "Checking usage…" : "Checking…";
    case "resuming":
      return "Resuming…";
    default:
      return `Won't resume by itself — ${ar.reason}`;
  }
}

export function stripWords(ar: AutoResume, now: number, o: TicketOptions = {}): StripWords {
  const restart = isRestart(ar);
  const ended = restart && o.ended ? endedWords(o.ended, now, o) : undefined;
  const parts = [restart ? restartText(ar, now, o.ended) : limitText(ar, now, o)];
  const n = ar.subagentIds.length;
  const subs = `${n} subagent${n === 1 ? "" : "s"}`;
  if (n > 0) parts.push(ar.root ? `+${subs}` : `${subs} stopped`);
  if (ar.attempts > 0) parts.push(`tried ${ar.attempts}×`);
  const detail = ended ? [ended.text, ...ended.detail] : [ar.reason];
  const who = [ar.provider, ar.model].filter(Boolean).join(" · ");
  if (who) detail.push(who);
  if (!ended) detail.push(`${ar.root ? "Stopped" : "Subagents stopped"} ${formatClock(ar.since, now, o)}`);
  const basis = ar.status === "waiting" && ar.basis && !restart ? BASIS[ar.basis] : undefined;
  if (basis) detail.push(basis);
  const tone = ar.status === "manual" ? "manual" : ar.status === "waiting" ? "wait" : "busy";
  return { text: parts.join(" · "), detail, tone, actions: ticketActions(ar, o) };
}

/**
 * The board card chip: "Limit · ~03:00", "Limit · checking", "Resuming…", "Resume by hand". An ended card has
 * one chip for its end and its restart ticket (`EndedChip`): "coming back", "coming back…", and "ended 13:58"
 * while it waits for Continue; a live agent's restart: "Continuing soon", "Continuing…", "Continue by hand".
 */
export function badgeText(ar: AutoResume, now: number, o: TicketOptions = {}): string {
  if (isRestart(ar)) {
    if (ar.status === "manual") return o.ended ? endedWords(o.ended, now, o).chip : "Continue by hand";
    if (ar.status === "resuming") return o.ended ? "coming back…" : "Continuing…";
    return o.ended ? "coming back" : "Continuing soon";
  }
  const kind = KINDS[ar.kind] ?? STOPPED;
  switch (ar.status) {
    case "waiting":
      return ar.resumeAt != null ? `${kind.short} · ${formatResumeAt(ar.resumeAt, now, o)}` : kind.short;
    case "checking":
      return `${kind.short} · checking`;
    case "resuming":
      return "Resuming…";
    default:
      return "Resume by hand";
  }
}

/** Why a retry found nothing to run, from what the board knows of the agent. */
export function nothingReason(agent: { column: string; needs?: unknown } | undefined): string {
  if (!agent) return "The agent isn't on this host anymore.";
  if (agent.column === "running") return "It's working right now.";
  if (agent.needs) return "It's waiting for your answer.";
  return "Its last turn neither failed nor was stopped.";
}

/** The toast for a retry's answer; none when it simply started (the agent visibly runs again). */
export function retryToast(r: RetryResult, why: string): { title: string; description?: string; status: "done" | "idle" } | null {
  if (r.via === "command") return { title: "Sent /retry to omp", description: "omp runs the last turn again if it failed or was stopped.", status: "done" };
  if (!r.started) return { title: "Nothing to resume", description: why, status: "idle" };
  return null;
}

/** The toast after Don't auto-resume / Don't auto-continue: the ticket stays, waiting for a hand. */
export function dontToast(name: string, ar: AutoResume | undefined, ended: AgentEnded | undefined): { title: string; description: string } {
  if (!ar || !isRestart(ar)) return { title: `${name} won't resume by itself`, description: "Resume it from its session when you're ready (F5)." };
  return ended
    ? { title: `${name} won't come back by itself`, description: "Continue brings it back, from its card or its session." }
    : { title: `${name} won't continue by itself`, description: "Continue it from its card or its session when you're ready." };
}

/**
 * F5 or Alt+R, omp's retry keys (no other modifier). Alt+R is the letter r, or the R key where Alt
 * types a symbol instead (macOS Option+R types "®").
 */
export function isResumeKey(e: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (e.key === "F5") return !e.altKey;
  return e.altKey && (e.key === "r" || e.key === "R" || (e.code === "KeyR" && !/^[a-z]$/i.test(e.key)));
}

// ───────────────── while omp retries a provider error (`OmpInfo.retry`) ─────────────────

/** Kind words of a provider error omp is retrying: the same family as a ticket's (`KINDS`). */
const RETRY_KINDS: Record<RetryWait["kind"], string> = {
  rateLimit: "Rate limit",
  usageLimit: "Usage limit",
  overloaded: "Overloaded",
  other: "Provider error",
};

/** Time left as a clock: "4:54", "0:07", "1:02:03". Rounds up, so "0:00" never shows before it is due. */
export function countdown(leftMs: number): string {
  const s = Math.max(0, Math.ceil(leftMs / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** omp's attempt counter: " (1/10)"; nothing when omp reports none (attempt 0). */
function attemptText(w: RetryWait): string {
  return w.attempt > 0 && w.maxAttempts > 0 ? ` (${w.attempt}/${w.maxAttempts})` : "";
}

/** Whether the retry is due: omp is about to ask again (or already did). */
export const retryDue = (w: RetryWait, now: number) => now >= w.retryAt;

/** The session strip and the card line: "Rate limit · retrying in 4:54 (1/10)", "Rate limit · retrying now… (1/10)". */
export function retryText(w: RetryWait, now: number): string {
  const when = retryDue(w, now) ? "retrying now…" : `retrying in ${countdown(w.retryAt - now)}`;
  return `${RETRY_KINDS[w.kind] ?? RETRY_KINDS.other} · ${when}${attemptText(w)}`;
}

/** The compact chip: "Rate limit · retry 4:54". */
export function retryBadgeText(w: RetryWait, now: number): string {
  const when = retryDue(w, now) ? "retrying" : `retry ${countdown(w.retryAt - now)}`;
  return `${RETRY_KINDS[w.kind] ?? RETRY_KINDS.other} · ${when}`;
}

/** Tooltip lines: what omp heard, and that nobody has to do anything. */
export function retryDetail(w: RetryWait, now: number, o: ClockOptions = {}): string[] {
  const lines = ["omp is waiting to try again on its own; nothing to answer."];
  if (w.error) lines.push(w.error);
  lines.push(`Next attempt ~${formatClock(w.retryAt, now, o)}${attemptText(w)}`);
  return lines;
}
