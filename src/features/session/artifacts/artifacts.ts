import { create } from "zustand";
import { core, drafts, parseAgentKey, toApiError } from "@/core";
import type { ArtifactContent, ArtifactFile, PlanReview, SessionArtifacts } from "@/core/gen";
import { toast } from "@/design";
import { composerDraftKey, useSessionUi } from "../state";

/**
 * A session's artifacts (`session.artifacts`, architecture §3.20): the `local://` files, subagent
 * outputs and handoffs omp wrote into the session's artifacts dir, plus the plan of a pending plan
 * review. One list per agent key, shared by the inspector rail, the mobile tab and the viewer.
 */

export type ArtifactSection = "review" | "plans" | "notes" | "outputs" | "handoffs";

export const SECTION_LABEL: Record<ArtifactSection, string> = {
  review: "Under review",
  plans: "Plans",
  notes: "Reports & notes",
  outputs: "Subagent outputs",
  handoffs: "Handoffs",
};

export interface ArtifactRow {
  key: string;
  section: ArtifactSection;
  title: string;
  /** `local://…`, `agent://…`, or the handoff's file name. */
  ref: string;
  file?: ArtifactFile;
  /** The pending plan review (its plan text comes with it). */
  review?: PlanReview;
}

/** omp's plan files: `<slug>-plan.md` (plan mode) and its `PLAN.md` alias. */
export function isPlan(f: ArtifactFile): boolean {
  return f.kind === "local" && /plan\.md$/i.test(f.name);
}

const basename = (name: string) => name.slice(name.lastIndexOf("/") + 1);

export interface ArtifactGroup {
  section: ArtifactSection;
  rows: ArtifactRow[];
}

/** Rows by section (pending review first), each newest first; empty sections left out. */
export function artifactRows(files: readonly ArtifactFile[], review: PlanReview | undefined): ArtifactGroup[] {
  const sections: Record<ArtifactSection, ArtifactRow[]> = { review: [], plans: [], notes: [], outputs: [], handoffs: [] };
  const reviewed = review?.path ? files.find((f) => f.url === review.path) : undefined;
  if (review) {
    const name = review.path ? basename(review.path) : "";
    sections.review.push({ key: "review", section: "review", title: review.title || reviewed?.title || name || "Plan", ref: review.path ?? "plan under review", review, file: reviewed });
  }
  for (const f of files) {
    if (f === reviewed) continue;
    const section: ArtifactSection = f.kind === "agent" ? "outputs" : f.kind === "handoff" ? "handoffs" : isPlan(f) ? "plans" : "notes";
    sections[section].push({ key: `${f.kind}:${f.name}`, section, title: f.title || basename(f.name), ref: f.url ?? f.name, file: f });
  }
  return (Object.keys(sections) as ArtifactSection[]).filter((s) => sections[s].length > 0).map((section) => ({ section, rows: sections[section] }));
}

/** 812 B, 4.2 KB, 18 KB, 1.3 MB */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── list store ──

export interface ArtifactList {
  data?: SessionArtifacts;
  /** When the last answer (or error) came. */
  at: number;
  loading: boolean;
  error?: { code: string; message: string; hint?: string };
}

const EMPTY: ArtifactList = { at: 0, loading: false };
/** Refreshes closer together than this are skipped (turn ends, subagents and mounts all ask). */
const REFRESH_MS = 3000;

const useLists = create<{ lists: Record<string, ArtifactList> }>()(() => ({ lists: {} }));

function put(key: string, list: ArtifactList): void {
  useLists.setState((s) => ({ lists: { ...s.lists, [key]: list } }));
}

export function useArtifactList(key: string): ArtifactList {
  return useLists((s) => s.lists[key] ?? EMPTY);
}

/** Lists the agent's artifacts again (`force`: even right after the last answer). */
export async function refreshArtifacts(key: string, force = false): Promise<void> {
  const cur = useLists.getState().lists[key] ?? EMPTY;
  if (cur.loading || (!force && Date.now() - cur.at < REFRESH_MS)) return;
  put(key, { ...cur, loading: true });
  const { hostId, agentId } = parseAgentKey(key);
  try {
    const data = await core.host(hostId).call("session.artifacts", { agentId });
    put(key, { data, at: Date.now(), loading: false });
  } catch (e) {
    const err = toApiError(e);
    put(key, { ...cur, at: Date.now(), loading: false, error: { code: err.code, message: err.message, hint: err.hint } });
  }
}

// ── contents ──

const contents = new Map<string, ArtifactContent>();
const MAX_CONTENTS = 40;

/** One artifact's text, cached per modification time. */
export async function readArtifact(key: string, file: Pick<ArtifactFile, "kind" | "name" | "mtime">): Promise<ArtifactContent> {
  const id = `${key}|${file.kind}|${file.name}|${file.mtime}`;
  const hit = contents.get(id);
  if (hit) return hit;
  const { hostId, agentId } = parseAgentKey(key);
  const content = await core.host(hostId).call("session.artifact", { agentId, kind: file.kind, name: file.name });
  contents.set(id, content);
  if (contents.size > MAX_CONTENTS) contents.delete(contents.keys().next().value as string);
  return content;
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: `Copied ${what}`, status: "done", duration: 2200 });
  } catch (e) {
    toast({ title: "Couldn't copy", description: e instanceof Error ? e.message : String(e), status: "error" });
  }
}

/** Adds `ref` (`local://…`, `agent://…`) to the agent's composer draft and focuses it, so the next
 *  prompt can point the agent at the file. */
export function mentionArtifact(agentKey: string, ref: string): void {
  const dk = composerDraftKey(agentKey);
  const cur = drafts.get(dk).replace(/\s+$/, "");
  drafts.set(dk, cur ? `${cur} ${ref} ` : `${ref} `);
  const ui = useSessionUi.getState();
  ui.setSheet(agentKey, false);
  ui.focusComposer(agentKey);
}
