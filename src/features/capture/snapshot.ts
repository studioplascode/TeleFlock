import type { AgentView } from "@/core";
import type { NeedsKind, OptionTone } from "@/core/gen";
import { groupOf } from "@/features/dispatch/auto";
import { autoRepoOf, type DispatchWorld, dispatchTarget, dispatchedRepos, hostName, repoNameOf, worldHostIds } from "@/features/dispatch/send";
import { recentRepos } from "@/features/dispatch/thread";
import { hostGroups } from "@/features/hosts/kinds";
import { needsOptions } from "@/features/inbox/answers";
import { NEEDS_WORD } from "@/features/shell/vocab";
import { basename } from "@/features/workspace/shared/paths";

/*
 * What the Quick capture window shows, computed in the main window (which owns the stores and
 * does the work) and posted to the capture window: where a task would go, the repos it can switch
 * to, and the questions waiting on you. Plain data only.
 */

export interface CaptureTarget {
  /** Host id or `auto:<group>`. */
  target: string;
  /** Checkout root (a host) or repo id (Auto). */
  repo: string;
  repoName: string;
  /** The host's name, or `Auto · <group>`. */
  where: string;
  /** Why a task can't go there now (it can still be opened in Dispatch). */
  blocked?: string;
}

export interface CaptureOption {
  id: string;
  label: string;
  recommended: boolean;
  tone: OptionTone;
}

export interface CaptureQuestion {
  agentKey: string;
  requestId: string;
  agent: string;
  /** `<host> · <repo>`. */
  where: string;
  kind: NeedsKind;
  /** The kind as the app names it ("Question", "Approval"). */
  word: string;
  title: string;
  question: string;
  command?: string;
  options: CaptureOption[];
  /** One number key answers it: a single choice, answerable in the app. */
  quick: boolean;
  /** Why it needs TeleFlock itself (several choices, a typed answer, only in the terminal). */
  why?: string;
}

export interface CaptureSnapshot {
  /** Host profiles are in (before that, nothing below is meaningful). */
  ready: boolean;
  /** Where Enter sends a task: Dispatch's current target and repo. */
  target: CaptureTarget | null;
  /** Why there is nowhere to send to ("Add a host first", "Pick a repository in Dispatch first"). */
  blocked: string | null;
  /** Places to send to, most recent first (the current one first). */
  recents: CaptureTarget[];
  /** Oldest first, at most `MAX_QUESTIONS`. */
  questions: CaptureQuestion[];
  needs: number;
}

/** Questions carried at most (number keys stop at 9 anyway). */
export const MAX_QUESTIONS = 9;
/** Repos offered in the window's switcher. */
export const MAX_RECENTS = 8;

export interface CaptureInputs extends DispatchWorld {
  loaded: boolean;
  lastHost: string | null;
  lastRepo: Readonly<Record<string, string>>;
  /** Needs-you agents, oldest request first (`useInbox` order). */
  inbox: readonly AgentView[];
}

function placeOf(w: DispatchWorld, target: string, repo: string): CaptureTarget {
  const group = groupOf(target);
  const blocked = blockedReason(w, target, repo);
  return { target, repo, repoName: repoNameOf(w, target, repo), where: group ? `Auto · ${group}` : hostName(w.profiles, target), ...(blocked ? { blocked } : {}) };
}

/** Why a task can't go to `target`/`repo` now, as Dispatch's composer says it. */
function blockedReason(w: DispatchWorld, target: string | undefined, repo: string | undefined): string | null {
  if (!target) return "Add a host first";
  if (!repo) return "Pick a repository in Dispatch first";
  const online = (h: string) => w.status[h]?.phase === "online";
  const group = groupOf(target);
  if (group) {
    const auto = autoRepoOf(w, group, repo);
    const name = auto?.name ?? basename(repo);
    if (!auto?.candidates.length) return `No host of ${group} has ${name} now`;
    return auto.candidates.some(online) ? null : `No host of ${group} with ${name} is online`;
  }
  return online(target) ? null : `${hostName(w.profiles, target)} is offline`;
}

function questionOf(w: DispatchWorld, a: AgentView): CaptureQuestion | null {
  const needs = a.needs;
  if (!needs) return null;
  const options = needsOptions(needs).map(({ id, label, recommended, tone }) => ({ id, label, recommended, tone }));
  const requestId = needs.requestId ?? "";
  const answerable = needs.answerable && requestId !== "";
  const quick = answerable && !needs.multi && options.length > 0;
  const why = !answerable ? "Answer it in the terminal" : needs.multi ? "Pick the answers in TeleFlock" : options.length === 0 ? "Type the answer in TeleFlock" : undefined;
  const repo = a.repo ?? (a.cwd ? basename(a.cwd) : null);
  return {
    agentKey: a.key,
    requestId,
    agent: a.name,
    where: [hostName(w.profiles, a.hostId), repo].filter(Boolean).join(" · "),
    kind: needs.kind,
    word: NEEDS_WORD[needs.kind],
    title: needs.title,
    question: needs.question,
    ...(needs.command ? { command: needs.command } : {}),
    options,
    quick,
    ...(why ? { why } : {}),
  };
}

/** The capture window's whole picture, from the stores' current values. */
export function buildSnapshot(i: CaptureInputs): CaptureSnapshot {
  const hostIds = worldHostIds(i);
  const { target } = dispatchTarget(i.profiles, hostIds, i.lastHost);
  const repo = target ? i.lastRepo[target] : undefined;

  // Threads dispatched to, the current target's recent repos, and the current pick first.
  const groups = new Set(hostGroups(i.profiles).map((g) => g.toLowerCase()));
  const valid = (t: string) => {
    const g = groupOf(t);
    return g ? groups.has(g.toLowerCase()) : hostIds.includes(t);
  };
  const at = new Map<string, { target: string; repo: string; at: number }>();
  const add = (t: string, r: string, when: number) => {
    if (!t || !r || !valid(t)) return;
    const k = `${t}\u0000${r}`;
    const cur = at.get(k);
    if (!cur || when > cur.at) at.set(k, { target: t, repo: r, at: when });
  };
  for (const [k, list] of Object.entries(i.dispatch.threads)) {
    const [t = "", r = ""] = k.split("\u0000");
    add(t, r, list.reduce((m, e) => Math.max(m, e.createdAt), 0));
  }
  if (target && !groupOf(target)) {
    const done = dispatchedRepos(i.dispatch.threads);
    for (const r of recentRepos(i.states[target], done[target] ?? {})) add(target, r.root, r.at);
  }
  if (target && repo) add(target, repo, Number.POSITIVE_INFINITY);
  const recents = [...at.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_RECENTS)
    .map((p) => placeOf(i, p.target, p.repo));

  const questions: CaptureQuestion[] = [];
  for (const a of i.inbox) {
    if (questions.length === MAX_QUESTIONS) break;
    const q = questionOf(i, a);
    if (q) questions.push(q);
  }

  return {
    ready: i.loaded,
    target: target && repo ? placeOf(i, target, repo) : null,
    blocked: target && repo ? null : blockedReason(i, target, repo),
    recents,
    questions,
    needs: i.inbox.length,
  };
}
