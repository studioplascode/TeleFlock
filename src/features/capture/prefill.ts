import { invoke } from "@tauri-apps/api/core";
import { drafts, getHostStates, navigate, parseAgentKey, useHosts } from "@/core";
import { attachImages, fitImages } from "@/core/clipboardImages";
import { type DraftImage, getDraftImages, hydrateDraftImages, updateDraftImages } from "@/core/draftImages";
import type { HostProfile, HostState } from "@/core/gen";
import { isAndroid, isTauri, toast } from "@/design";
import { canonicalRemote, groupHosts } from "@/features/dispatch/auto";
import { dispatchDraftKey, dispatchTarget, worldHostIds } from "@/features/dispatch/send";
import { useDispatch } from "@/features/dispatch/store";
import { composerDraftKey, useSessionUi } from "@/features/session/state";
import { type AppliedPrefill, usePrefill } from "./store";
import { type PrefilledTask, imageFilesOf, mergeDraftText } from "./task";

/*
 * The one entry point for a task that starts outside the app's composers (Android share sheet,
 * desktop Quick capture → "Open in Dispatch"): Dispatch opens on the right repository with the
 * task in its composer, ready to edit and send, or to hand to an existing agent instead.
 */

/** A Dispatch thread: host id or `auto:<group>`, and the repo (root, or Auto's repo id). */
export interface Place {
  target: string;
  repo: string;
}

export interface PlaceInputs {
  profiles: readonly HostProfile[];
  states: Readonly<Record<string, HostState>>;
  lastHost: string | null;
  lastRepo: Readonly<Record<string, string>>;
  /** Canonical remote per host + checkout root (Dispatch's learned `remotes`). */
  remotes: Readonly<Record<string, string>>;
}

/** Checkout roots of repository `id` (`github.com/o/r`) per host: learned remotes and live workspaces. */
function clonesOf(i: PlaceInputs, hostIds: readonly string[], id: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, remote] of Object.entries(i.remotes)) {
    const [h = "", root = ""] = k.split("\u0000");
    if (remote === id && hostIds.includes(h) && !out.has(h)) out.set(h, root);
  }
  for (const h of hostIds) {
    for (const ws of i.states[h]?.workspaces ?? []) {
      if (ws.repo && !out.has(h) && canonicalRemote(ws.repo.remoteUrl) === id) out.set(h, ws.repo.root);
    }
  }
  return out;
}

/**
 * Where a prefilled task lands. A task about a repository (a shared GitHub issue or pull request)
 * goes to a clone of it: on the current target when it has one (an Auto group keeps the task in
 * the group, keyed by the repository), else on the first host that has one. Otherwise: Dispatch's
 * current target and its last repo. `repo: null` = none picked yet (Dispatch asks; the task waits).
 */
export function prefillPlace(i: PlaceInputs, about?: string): { target: string | undefined; repo: string | null } {
  const hostIds = worldHostIds(i);
  const { target, group } = dispatchTarget([...i.profiles], hostIds, i.lastHost);
  if (about) {
    const clones = clonesOf(i, hostIds, about);
    if (group && target && groupHosts([...i.profiles], group).some((p) => clones.has(p.id))) return { target, repo: about };
    const here = target && !group ? clones.get(target) : undefined;
    if (target && here) return { target, repo: here };
    const first = hostIds.find((h) => clones.has(h));
    const root = first ? clones.get(first) : undefined;
    if (first && root) return { target: first, repo: root };
  }
  return { target, repo: target ? (i.lastRepo[target] ?? null) : null };
}

/** Host profiles are in: the target can be told (a share can open the app cold). */
function hostsLoaded(): Promise<void> {
  if (useHosts.getState().loaded) return Promise.resolve();
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (!useHosts.getState().loaded) return;
      window.clearInterval(timer);
      resolve();
    }, 100);
  });
}

let seq = 0;

/** Adds `task` to draft `key` (text appended, images scaled and capped) and remembers what it added. */
async function applyTo(key: string, task: PrefilledTask, id: string): Promise<AppliedPrefill> {
  const before = drafts.get(key);
  const after = mergeDraftText(before, task.text);
  drafts.set(key, after);
  await hydrateDraftImages(key);
  const had = getDraftImages(key);
  const { skipped } = task.images.length ? await attachImages(key, imageFilesOf(task.images)) : { skipped: undefined };
  const images = getDraftImages(key).filter((img) => !had.includes(img));
  const applied: AppliedPrefill = { id, key, source: task.source, before, after, images, ...(skipped ? { skipped } : {}), at: Date.now() };
  usePrefill.setState({ applied, waiting: null });
  return applied;
}

/** Desktop: bring the main window forward (Quick capture lives in its own window). */
export function revealMain(): void {
  if (isTauri() && !isAndroid) invoke("capture_show_main").catch((e: unknown) => console.warn("capture: couldn't show the main window", e));
}

/**
 * Open Dispatch with `task` in its composer, on `place` or where `prefillPlace` puts it. With no
 * repository picked yet the task waits and lands in the first thread picked (`applyWaiting`).
 */
export async function openPrefilledTask(task: PrefilledTask, place?: Place): Promise<void> {
  await hostsLoaded();
  const d = useDispatch.getState();
  const { profiles } = useHosts.getState();
  const where = place ?? prefillPlace({ profiles, states: getHostStates(), lastHost: d.lastHost, lastRepo: d.lastRepo, remotes: d.remotes }, task.repo);
  const id = `prefill-${Date.now().toString(36)}-${(seq++).toString(36)}`;
  if (where.target) d.select(where.target, where.repo ?? undefined);
  if (where.target && where.repo) {
    const applied = await applyTo(dispatchDraftKey(where.target, where.repo), task, id);
    if (applied.skipped) toast({ title: "Some images were left out", description: applied.skipped, status: "error" });
  } else {
    usePrefill.setState({ waiting: { id, task }, applied: null });
  }
  navigate({ name: "dispatch" });
  revealMain();
}

/** The waiting task (no repo was picked when it came in) goes into the thread now on screen. */
export async function applyWaiting(target: string, repo: string): Promise<void> {
  const waiting = usePrefill.getState().waiting;
  if (!waiting) return;
  usePrefill.setState({ waiting: null });
  await applyTo(dispatchDraftKey(target, repo), waiting.task, waiting.id);
}

/** Forget the banner (the draft stays as it is). */
export function dismissPrefill(): void {
  usePrefill.setState({ applied: null, waiting: null });
}

/**
 * "Send to agent…": what the prefilled task put in the Dispatch draft (as edited since) moves to
 * `agentKey`'s composer; anything the draft held before stays in Dispatch. Opens the session with
 * the composer focused, so one more tap sends it.
 */
export function moveToAgent(agentKey: string): void {
  const a = usePrefill.getState().applied;
  if (!a) return;
  const cur = drafts.get(a.key);
  const kept = a.before.trimEnd();
  const text = kept && cur.startsWith(kept) ? cur.slice(kept.length).trim() : cur.trim();
  drafts.set(a.key, kept && cur.startsWith(kept) ? a.before : "");
  const moving: DraftImage[] = getDraftImages(a.key).filter((img) => a.images.includes(img));
  updateDraftImages(a.key, (list) => list.filter((img) => !moving.includes(img)));

  const to = composerDraftKey(agentKey);
  drafts.set(to, mergeDraftText(drafts.get(to), text));
  let skipped: string | undefined;
  if (moving.length) {
    updateDraftImages(to, (list) => {
      const fit = fitImages(list, moving);
      skipped = fit.skipped;
      return fit.images;
    });
  }
  usePrefill.setState({ applied: null });
  const { hostId, agentId } = parseAgentKey(agentKey);
  navigate({ name: "agent", hostId, agentId });
  useSessionUi.getState().focusComposer(agentKey);
  if (skipped) toast({ title: "Some images were left out", description: skipped, status: "error" });
}
