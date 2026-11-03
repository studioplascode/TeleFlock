/**
 * `session.digest` for demo hosts (tf-hostd's `ops/digest.rs`): what a demo session is about as a whole, from its
 * transcript (the user's prompts, compaction summaries), its todo list and its subagents, bounded as the host bounds
 * them.
 */
import type { DigestPrompt, SessionDigest, SessionMeta, TranscriptItem } from "@/core/gen";

const PROMPT_MAX = 4_000;
const BETWEEN_MAX = 400;
const BETWEEN_COUNT = 40;
const SUMMARIES = 3;
const SUBAGENTS = 40;
const TASK_MAX = 160;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The digest of a demo session: `items` its transcript, `meta` its todo list and subagents. */
export function demoDigest(items: readonly TranscriptItem[], meta: Pick<SessionMeta, "todos" | "subagents">): SessionDigest {
  const prompts = items.flatMap((it) => (it.kind === "user" && !it.synthetic && it.text.trim() ? [it.text.trim()] : []));
  const between = prompts.slice(1, -1);
  const every = Math.ceil(between.length / BETWEEN_COUNT);
  const picked: DigestPrompt[] = between.flatMap((text, i) => (i % every === 0 ? [{ n: i + 2, text: cut(text.replace(/\s+/g, " "), BETWEEN_MAX) }] : []));
  const subagents = [...meta.subagents]
    .sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER))
    .map((s) => ({ name: s.name, ...(s.description ? { task: cut(s.description, TASK_MAX) } : {}), running: s.status === "running" }));
  const first = prompts[0];
  const newest = prompts.length > 1 ? prompts.at(-1) : undefined;
  return {
    prompts: [...(first ? [{ n: 1, text: cut(first, PROMPT_MAX) }] : []), ...picked, ...(newest ? [{ n: prompts.length, text: cut(newest, PROMPT_MAX) }] : [])],
    promptCount: prompts.length,
    summaries: items.flatMap((it) => (it.kind === "compaction" && it.summary.trim() ? [it.summary.trim()] : [])).slice(-SUMMARIES),
    todos: meta.todos,
    subagents: subagents.slice(-SUBAGENTS),
    subagentCount: subagents.length,
  };
}
