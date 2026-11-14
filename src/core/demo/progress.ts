/**
 * The main agent's own progress estimates in the demo (`OmpInfo.progress`, which TeleFlock's bridge ≥ 2.6.0
 * gets by asking omp a few times per turn): when a turn is asked, how far along its scripted work is by the
 * agent's own (biased) judgement, and its current step in its words. `AgentSim` keeps the schedule.
 */
import type { Step, ToolSpec } from "./scripts";

/**
 * When the demo asks, ms into a turn: the bridge's 2, 5, 10, 30 and 60 minutes ten times faster, then
 * every 6 minutes. The app shows time left from the 60 s answer on (a minute of the turn behind it).
 */
export const PROGRESS_ASKS: readonly number[] = [12_000, 30_000, 60_000, 180_000, 360_000];
const ASK_EVERY = 360_000;
const LAST_ASK = PROGRESS_ASKS[PROGRESS_ASKS.length - 1] as number;
/** What an answer the agent waits for stands for in its own reckoning: the work after it is unknown until then. */
const ANSWER_MS = 40_000;

/** The first ask after `elapsed` ms into a turn. */
export function nextAsk(elapsed: number): number {
  return PROGRESS_ASKS.find((t) => t > elapsed) ?? LAST_ASK + (Math.floor((elapsed - LAST_ASK) / ASK_EVERY) + 1) * ASK_EVERY;
}

/** The latest ask at or before `elapsed` ms into a turn; undefined before the first. */
export function lastAsk(elapsed: number): number | undefined {
  if (elapsed >= LAST_ASK) return LAST_ASK + Math.floor((elapsed - LAST_ASK) / ASK_EVERY) * ASK_EVERY;
  return PROGRESS_ASKS.findLast((t) => t <= elapsed);
}

/** How long a scripted step takes as the agent sees it ahead (`charsPerSec`: its writing speed). */
export function stepMs(step: Step, charsPerSec: number): number {
  switch (step.t) {
    case "think":
    case "retry":
    case "wait":
      return step.ms;
    case "say":
      return (step.text.length / charsPerSec) * 1000;
    case "tool":
      return step.spec.ms;
    case "ui":
      return ANSWER_MS;
    default:
      return 0;
  }
}

/**
 * The percentage an agent gives `elapsed` ms into a turn with `remaining` ms of work ahead: the true share,
 * misjudged by up to ±12 % in its own direction (each agent by its id), whole, 1..99 while it runs.
 */
export function estimatePct(elapsed: number, remaining: number, agentId: string): number {
  let h = 7;
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  const bias = 1 + ((h % 7) - 3) * 0.04;
  const share = elapsed / Math.max(1, elapsed + remaining);
  return Math.max(1, Math.min(99, Math.round(share * 100 * bias)));
}

const VERB: Record<string, string> = { bash: "Running", read: "Reading", edit: "Editing", write: "Writing", grep: "Searching the code for", web_search: "Searching the web for", fetch: "Reading" };

/** At most 80 characters, as the bridge keeps a stage. */
const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79).trimEnd()}…` : s);

/** A step's stage in the agent's words: a tool's intent (or what it runs on), a thought's first sentence; undefined for the rest. */
export function stageOf(step: Step | undefined): string | undefined {
  if (step?.t === "tool") return clip(toolStage(step.spec));
  if (step?.t === "think") return clip(step.text.split(/(?<=[.!?])\s/)[0] ?? step.text);
  if (step?.t === "say") return "Writing up the result";
  return undefined;
}

function toolStage(spec: ToolSpec): string {
  if (spec.intent) return spec.intent;
  const verb = VERB[spec.tool];
  return verb ? `${verb} ${spec.title}` : spec.title;
}
