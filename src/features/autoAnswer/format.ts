import type { Agent, AutoAnswer, AutoAnswerCountdown, HostInfo } from "@/core/gen";

/*
 * Decide for me (architecture §3.23): the words and numbers every surface shows. Pure, tested
 * (`format.test.ts`). The host owns the clock: `AutoAnswerCountdown.deadline` is host epoch ms.
 */

/** tf-proto `AUTO_ANSWER_MIN_SECS` / `AUTO_ANSWER_MAX_SECS` / `AUTO_ANSWER_DEFAULT_SECS`. */
export const AUTO_ANSWER_MIN_SECS = 60;
export const AUTO_ANSWER_MAX_SECS = 86_400;
export const AUTO_ANSWER_DEFAULT_SECS = 1_200;

/** The editor's wait presets: 5, 10, 20, 30 min, 1 h, 2 h. */
export const WAIT_PRESETS: readonly number[] = [300, 600, 1_200, 1_800, 3_600, 7_200];
/** The editor's custom wait, in whole minutes. */
export const CUSTOM_MIN_MINUTES = 1;
export const CUSTOM_MAX_MINUTES = 1_440;

/** What a policy switched on starts with: 20 min, counting whether or not an app is connected. */
export const NEW_POLICY: AutoAnswer = { enabled: true, afterSecs: AUTO_ANSWER_DEFAULT_SECS, onlyWhenNoApp: false };

/** `12:40`, `1:02:03`: time left on a countdown, whole seconds rounded up, never negative. */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `20 min`, `1 h 30 min`, `2 h`, `45 s`: a wait, in whole minutes rounded up from a minute on (as tf-hostd words it). */
export function formatWait(secs: number): string {
  const s = Number.isFinite(secs) ? Math.max(0, Math.ceil(secs)) : 0;
  if (s < 60) return `${s} s`;
  const mins = Math.ceil(s / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** A policy the host accepts: `afterSecs` a whole number within 1 min–24 h. */
export function clampPolicy(p: AutoAnswer): AutoAnswer {
  const secs = Number.isFinite(p.afterSecs) ? Math.round(p.afterSecs) : AUTO_ANSWER_DEFAULT_SECS;
  return { enabled: p.enabled, afterSecs: Math.min(AUTO_ANSWER_MAX_SECS, Math.max(AUTO_ANSWER_MIN_SECS, secs)), onlyWhenNoApp: p.onlyWhenNoApp };
}

/** Two policies (or two host defaults, `undefined` included) say the same. */
export function samePolicy(a: AutoAnswer | undefined, b: AutoAnswer | undefined): boolean {
  return a === b || (!!a && !!b && a.enabled === b.enabled && a.afterSecs === b.afterSecs && a.onlyWhenNoApp === b.onlyWhenNoApp);
}

/** "after 20 min", "after 20 min · only with no app connected", "off" (absent = off). */
export function policySummary(p: AutoAnswer | undefined): string {
  if (!p?.enabled) return "off";
  const after = `after ${formatWait(p.afterSecs)}`;
  return p.onlyWhenNoApp ? `${after} · only with no app connected` : after;
}

/**
 * The Agent options summary chip of a launch: "Decide for me · 20 min", "· 20 min, no app", "· off";
 * null for the host default (`undefined`: the spec carries nothing).
 */
export function policyChipText(p: AutoAnswer | undefined): string | null {
  if (!p) return null;
  if (!p.enabled) return "Decide for me · off";
  return `Decide for me · ${formatWait(p.afterSecs)}${p.onlyWhenNoApp ? ", no app" : ""}`;
}

/** The editor's Host default choice: "Host default (after 20 min)", "Host default (off)". */
export function hostDefaultLabel(hostDefault: AutoAnswer | undefined): string {
  return `Host default (${policySummary(hostDefault)})`;
}

/** The host has decide for me (`HostInfo.autoAnswer` present; older tf-hostd omit it). */
export function hostDecides(info: Pick<HostInfo, "autoAnswer"> | undefined): boolean {
  return !!info?.autoAnswer;
}

/**
 * What a launch spec (`AgentSpec`, `AutomationDraft`) carries: the agent's own policy, or nothing
 * for the host default and for hosts without decide for me.
 */
export function specAutoAnswer(p: AutoAnswer | undefined, capable: boolean): { autoAnswer?: AutoAnswer } {
  return p && capable ? { autoAnswer: clampPolicy(p) } : {};
}

/** The countdown on the question the agent shows now (`countdown.requestId === needs.requestId`). */
export function currentCountdown(a: Pick<Agent, "autoAnswer" | "needs"> | undefined): AutoAnswerCountdown | undefined {
  const cd = a?.autoAnswer?.countdown;
  const req = a?.needs?.requestId;
  return cd && req !== undefined && cd.requestId === req ? cd : undefined;
}

/** `★ Use SQLite`, `★ A, ★ B` (a multi-select picks every recommended option). */
export function starPicks(labels: readonly string[]): string {
  return labels.length ? labels.map((l) => `★ ${l}`).join(", ") : "★ the recommended option";
}

/** counting: picks at its deadline · due: past it, or being delivered · waiting: stands while an app is connected · cancelled: waits for a person. */
export type CountdownPhase = "counting" | "due" | "waiting" | "cancelled";

export interface CountdownView {
  phase: CountdownPhase;
  /** Time left (ms, ≥ 0): to the deadline while counting, where the clock stands while waiting or cancelled, 0 when due. */
  remainingMs: number;
  /** The ★ options it picks. */
  picks: string;
  /** Ask card line: "auto-picks ★ Use SQLite in 12:40"; cancelled: "Won't auto-pick this question". */
  text: string;
  /** Card chip: "auto-picks in 12:40"; empty when cancelled (cards show nothing then). */
  compact: string;
  /** Tooltip sentence. */
  detail: string;
  /** Only a running countdown before its deadline needs the second clock. */
  ticking: boolean;
}

/** What a countdown shows at `now` (host epoch ms, the app's clock). */
export function countdownState(cd: AutoAnswerCountdown, now: number): CountdownView {
  const picks = starPicks(cd.picks);
  const standing = Math.max(0, cd.remainingMs ?? 0);
  if (cd.status === "cancelled") {
    return { phase: "cancelled", remainingMs: standing, picks, text: "Won't auto-pick this question", compact: "", detail: `Decide for me won't pick ${picks}: this question waits for you.`, ticking: false };
  }
  if (cd.status === "waitingForNoApp") {
    const t = formatCountdown(standing);
    return {
      phase: "waiting",
      remainingMs: standing,
      picks,
      text: `auto-picks ${picks} when no app is connected · ${t} left`,
      compact: `when no app · ${t} left`,
      detail: `Decide for me picks ${picks} after ${formatWait(standing / 1000)} with no app connected. Its clock stands while a TeleFlock app is connected to this host.`,
      ticking: false,
    };
  }
  const left = cd.status === "counting" ? (cd.deadline !== undefined ? cd.deadline - now : standing) : 0;
  if (left <= 0) {
    return { phase: "due", remainingMs: 0, picks, text: `auto-picking ${picks}…`, compact: "auto-picking…", detail: `Nobody answered in time: decide for me is picking ${picks}.`, ticking: false };
  }
  const t = formatCountdown(left);
  return {
    phase: "counting",
    remainingMs: left,
    picks,
    text: `auto-picks ${picks} in ${t}`,
    compact: `auto-picks in ${t}`,
    detail: `Decide for me picks ${picks} in ${formatWait(left / 1000)} unless you answer.`,
    ticking: cd.deadline !== undefined,
  };
}
