import { type DraftImage, draftKey } from "@/core";
import type { BranchList, ConnStatus, HostProfile, HostState, Settings } from "@/core/gen";
import { IMAGES_TOO_LARGE, imageChars, MAX_PROMPT_IMAGE_CHARS } from "@/core/clipboardImages";
import { explainPick, type HostLoad, hostLoad, pickHost, type QuotaReading, rankHosts } from "@/core/workload";
import { hostGroups, versionBelow } from "@/features/hosts/kinds";
import { basename } from "@/features/workspace/shared/paths";
import { autoTarget, findGroupRepo, groupHosts, groupOf, groupRepos } from "./auto";
import { type DispatchEntry, type DispatchOptions, dispatchTask, entryHost, entryRepo, pendingByHost, threadKey } from "./store";
import { recentRepos, threadBase } from "./thread";

/*
 * One Dispatch send, outside any view: where the task goes (a single host, or the least busy host
 * of an Auto group that has the repo), whether that host can take it, and the `dispatchTask` call.
 * The Dispatch composer and Quick capture (`features/capture`) both send through `sendTask`.
 */

/** Image prompts need hostd 0.5 (older daemons ignore `agent.images`). */
export const IMAGES_MIN_HOSTD = "0.5";

/** The Dispatch store's part a send reads (`useDispatch.getState()` is one). */
export interface DispatchMemory {
  threads: Readonly<Record<string, DispatchEntry[]>>;
  remotes: Readonly<Record<string, string>>;
  bases: Readonly<Record<string, string>>;
  legacyBases: Readonly<Record<string, true>>;
}

/** Everything a send looks at: hosts, their state and the Dispatch memory. */
export interface DispatchWorld {
  profiles: readonly HostProfile[];
  status: Readonly<Record<string, ConnStatus>>;
  states: Readonly<Record<string, HostState>>;
  dispatch: DispatchMemory;
  /** Auto: each candidate host's quota window for the chosen model (`useAutoQuotas`); absent counts as unknown. */
  quotas?: Readonly<Record<string, QuotaReading | null | undefined>>;
}

/** The composer draft (text, images, videos) of a thread: per target + repo. */
export function dispatchDraftKey(target: string, repo: string): string {
  return draftKey("dispatch.task", target, repo);
}

/** Host ids in profile order, then hosts with state but no profile (as `useHostIds`). */
export function worldHostIds(w: Pick<DispatchWorld, "profiles" | "states">): string[] {
  const ids = w.profiles.map((p) => p.id);
  for (const id of Object.keys(w.states)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** A host's display name. */
export function hostName(profiles: readonly Pick<HostProfile, "id" | "name">[], id: string): string {
  return profiles.find((p) => p.id === id)?.name ?? id;
}

/**
 * Dispatch's target: the last host or host group used (`auto:<group>`, spelled as the profiles
 * spell the group), else the first host. `group` is set for Auto.
 */
export function dispatchTarget(profiles: readonly HostProfile[], hostIds: readonly string[], lastHost: string | null): { target: string | undefined; group: string | null } {
  const lastGroup = groupOf(lastHost)?.toLowerCase();
  const group = lastGroup ? (hostGroups(profiles).find((g) => g.toLowerCase() === lastGroup) ?? null) : null;
  if (group) return { target: autoTarget(group), group };
  return { target: lastHost && hostIds.includes(lastHost) ? lastHost : hostIds[0], group: null };
}

/** When each host last got a dispatch to each of its repos: `{ [hostId]: { [root]: at } }`. */
export function dispatchedRepos(threads: Readonly<Record<string, DispatchEntry[]>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [k, list] of Object.entries(threads)) {
    for (const e of list) {
      const per = (out[entryHost(k, e)] ??= {});
      const root = entryRepo(k, e);
      per[root] = Math.max(per[root] ?? 0, e.createdAt);
    }
  }
  return out;
}

/** Current load of `ids` (Auto): health, agents, the dispatches on their way to each, and its quota for the chosen model. */
export function loadsOf(
  ids: readonly string[],
  states: Readonly<Record<string, HostState>>,
  status: Readonly<Record<string, ConnStatus>>,
  threads: Readonly<Record<string, DispatchEntry[]>>,
  quotas?: Readonly<Record<string, QuotaReading | null | undefined>>,
): HostLoad[] {
  const running = new Set<string>();
  for (const h of ids) for (const a of states[h]?.agents ?? []) if (a.column === "running") running.add(a.id);
  const pending = pendingByHost(threads, running, Date.now());
  return ids.map((h) => {
    const agents = states[h]?.agents ?? [];
    return hostLoad({
      hostId: h,
      online: status[h]?.phase === "online",
      health: states[h]?.health,
      running: agents.filter((a) => a.column === "running").length,
      needs: agents.filter((a) => a.column === "needs").length,
      pending: pending[h] ?? 0,
      quota: quotas?.[h],
    });
  });
}

/** Image prompts need a hostd known to be 0.5+ (older ones drop `agent.images` silently). */
export function takesImages(w: Pick<DispatchWorld, "profiles" | "states">, hostId: string): boolean {
  const version = w.states[hostId]?.info.hostdVersion;
  return w.profiles.find((p) => p.id === hostId)?.kind === "demo" || (!!version && !versionBelow(version, IMAGES_MIN_HOSTD));
}

/** An Auto target's repository as the group sees it: its hosts with a checkout of it, and its name. */
export function autoRepoOf(w: DispatchWorld, group: string, repo: string): { name: string; roots: Record<string, string>; candidates: string[] } | null {
  const members = groupHosts(w.profiles, group).map((p) => p.id);
  const done = dispatchedRepos(w.dispatch.threads);
  const pooled = groupRepos(
    members.map((h) => ({ hostId: h, recents: recentRepos(w.states[h], done[h] ?? {}) })),
    w.dispatch.remotes,
  );
  const found = findGroupRepo(pooled, repo);
  return found ? { name: found.name, roots: found.roots, candidates: members.filter((h) => found.roots[h]) } : null;
}

/**
 * The composer's agent options: the last ones used (a template that is gone falls back to none),
 * else the Settings defaults for new agents.
 */
export function dispatchOptions(stored: DispatchOptions | null, s: Pick<Settings, "templates" | "defaultModel" | "defaultThinking" | "defaultPlan">): DispatchOptions {
  if (stored) return stored.templateId && !s.templates.some((t) => t.id === stored.templateId) ? { ...stored, templateId: null } : stored;
  return { templateId: null, model: s.defaultModel ?? "default", thinking: s.defaultThinking ?? "default", plan: s.defaultPlan };
}

/** A repository's name in a target (Auto: the group's name for it; a host: its recent repos' name, else the folder). */
export function repoNameOf(w: DispatchWorld, target: string, repo: string): string {
  const group = groupOf(target);
  if (group) return autoRepoOf(w, group, repo)?.name ?? basename(repo);
  return recentRepos(w.states[target], {}).find((r) => r.root === repo)?.name ?? basename(repo);
}

export interface SendRequest {
  /** Host id or `auto:<group>`. */
  target: string;
  /** Checkout root (a host) or repo id (Auto). */
  repo: string;
  prompt: string;
  images: readonly DraftImage[];
  /** Videos attached in the composer (`@/core/draftVideos` ids). */
  videos?: readonly string[];
  options: DispatchOptions;
  /**
   * The single host's branch list for `repo`, when the caller has it: the name is deduped against
   * its branches and the base resolved from it. Absent (or Auto): both happen on the host the task
   * goes to, right before it is created.
   */
  branches?: BranchList;
  /** What the base reads as until the host resolved it (Auto: the next host's base). */
  baseHint?: { shown: string; param?: string };
}

export type SendPlan =
  | { ok: true; hostId: string; args: Parameters<typeof dispatchTask>[0] }
  | { ok: false; title: string; description?: string };

/**
 * Where and how a task would be sent, or why it can't be (the text of the toast to show). Pure:
 * every input comes from `w`, so a send outside the Dispatch view decides exactly like the view.
 */
export function planSend(w: DispatchWorld, req: SendRequest): SendPlan {
  const { target, repo, images } = req;
  const key = threadKey(target, repo);
  const nameOf = (id: string) => hostName(w.profiles, id);
  if (imageChars(images) > MAX_PROMPT_IMAGE_CHARS) return { ok: false, title: "The images are too large", description: `${IMAGES_TOO_LARGE} Remove some.` };
  const group = groupOf(target);
  let to: string | undefined = group ? undefined : target;
  let root = repo;
  let placed: string | undefined;
  if (group) {
    const auto = autoRepoOf(w, group, repo);
    const repoName = auto?.name ?? basename(repo);
    if (!auto || !auto.candidates.length) {
      return { ok: false, title: `No host of ${group} has ${repoName}`, description: "Pick another repository, or a single host to browse for it." };
    }
    const able = images.length ? auto.candidates.filter((h) => takesImages(w, h)) : auto.candidates;
    if (!able.length) {
      return {
        ok: false,
        title: `No host of ${group} with ${repoName} can take images yet`,
        description: `Images need TeleFlock host daemon ${IMAGES_MIN_HOSTD} or newer on ${auto.candidates.map(nameOf).join(", ")}: update one from Hosts, or send the task without images.`,
      };
    }
    // Fresh numbers: the dispatches just sent count against their host right away.
    const ranked = rankHosts(loadsOf(able, w.states, w.status, w.dispatch.threads, w.quotas));
    const pick = pickHost(ranked);
    if (!pick) {
      return { ok: false, title: `No host of ${group} with ${repoName}${able.length < auto.candidates.length ? " that takes images" : ""} is online`, description: able.map(nameOf).join(", ") };
    }
    to = pick.hostId;
    root = auto.roots[pick.hostId] ?? repo;
    placed = explainPick(pick, ranked, nameOf);
  }
  if (!to) return { ok: false, title: "Add a host first" };
  if (images.length && !takesImages(w, to)) {
    const version = w.states[to]?.info.hostdVersion;
    return {
      ok: false,
      title: `${nameOf(to)} can't take images yet`,
      description: `${version ? `Its TeleFlock host daemon (${version}) is older than ${IMAGES_MIN_HOSTD}` : `Its TeleFlock host daemon version isn't known yet (images need ${IMAGES_MIN_HOSTD} or newer)`}: update it from Hosts, or send the task without images.`,
    };
  }
  const stored = w.dispatch.bases[key];
  const legacy = w.dispatch.legacyBases[key] === true;
  const list = group ? undefined : req.branches;
  const base = list ? threadBase(list, stored, legacy) : (req.baseHint ?? threadBase(undefined, stored, legacy));
  const agents = (w.states[to]?.agents ?? []).map((a) => a.name);
  return {
    ok: true,
    hostId: to,
    args: {
      key,
      hostId: to,
      repo: root,
      prompt: req.prompt,
      images,
      videos: req.videos,
      base: base.param,
      baseLabel: base.shown,
      placed,
      options: req.options,
      taken: list ? [...list.branches.map((b) => b.name), ...agents] : agents,
      // Without the host's own branch list, the name and the base are settled on the host itself.
      resolveBase: list ? undefined : { stored, legacy },
    },
  };
}

/** `planSend`, then the send itself: the entry joins the thread and its worktree is created in the background. */
export function sendTask(w: DispatchWorld, req: SendRequest): (SendPlan & { ok: false }) | { ok: true; hostId: string; entry: DispatchEntry } {
  const plan = planSend(w, req);
  if (!plan.ok) return plan;
  return { ok: true, hostId: plan.hostId, entry: dispatchTask(plan.args) };
}
