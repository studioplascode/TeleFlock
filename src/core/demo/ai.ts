/**
 * `ai.complete` for demo hosts: deterministic, plausible answers derived from the prompt text the
 * real helpers in `@/core/ai` send (offline; no model). Latency 600–1400 ms by prompt hash.
 */
import type { AiCompleteResult } from "@/core/gen";
import { hash } from "./rng";

const MODEL = "openai-codex/gpt-6-luna";

const STOP: Record<string, true> = Object.fromEntries(
  [
    "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "at", "by", "from", "this", "that", "it", "its",
    "into", "is", "be", "are", "was", "so", "our", "my", "we", "you", "please", "can", "should", "all", "any", "some",
    "when", "then", "them", "as", "up", "out", "without", "than", "there", "here", "about", "also", "just", "very",
  ].map((w) => [w, true]),
);
const VERBS: Record<string, true> = Object.fromEntries(
  ["add", "fix", "make", "update", "implement", "write", "create", "remove", "refactor", "find", "improve", "review", "bump", "investigate", "change", "move", "rename", "support", "use", "check", "map", "batch", "compress"].map((w) => [w, true]),
);

/** 600–1400 ms by prompt hash; a `ramble` by its model role's speed (tiny 400–700, smol 800–1300, default 1500–2300 ms). */
export function demoAiLatency(prompt: string, task?: string, role?: string): number {
  if (task === "ramble") {
    const [base, span] = role === "default" ? [1500, 801] : role === "smol" ? [800, 501] : [400, 301];
    return base + (hash(prompt) % span);
  }
  return 600 + (hash(prompt) % 801);
}

const salient = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).filter((w) => w.length > 1 && !STOP[w]);

const sentenceCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Lines under `Label:` up to the next blank line. */
function section(prompt: string, label: string): string[] {
  const at = prompt.indexOf(`${label}:\n`);
  if (at < 0) return [];
  const rest = prompt.slice(at + label.length + 2);
  const end = rest.indexOf("\n\n");
  return (end < 0 ? rest : rest.slice(0, end)).split("\n").map((l) => l.trim()).filter(Boolean);
}

function line(prompt: string, label: string): string | undefined {
  return prompt.split("\n").find((l) => l.startsWith(`${label}: `))?.slice(label.length + 2).trim();
}

/** `M src/a.ts` / `src/a.ts | 12 +-` / `+3 -1 src/a.ts` → `{ verb, path }`. */
function changedFiles(prompt: string): { verb: string; path: string }[] {
  return section(prompt, "Changed files").map((l) => {
    const tokens = l.split(/\s+/);
    const path = tokens.find((t) => /[/.]/.test(t) && !/^[+-]?\d/.test(t)) ?? tokens[tokens.length - 1] ?? l;
    const status = tokens[0]?.toUpperCase();
    const verb = status === "A" || status === "??" ? "Add" : status === "D" ? "Remove" : status === "R" ? "Rename" : "Update";
    return { verb, path };
  });
}

function titleOf(text: string, max = 6): string {
  const first = (text.split(/(?<=[.!?])\s|\n/)[0] ?? text).replace(/[.!?:;,]+$/, "");
  const words = first.split(/\s+/).filter(Boolean).slice(0, max);
  while (words.length > 1 && STOP[(words[words.length - 1] ?? "").toLowerCase()]) words.pop();
  return sentenceCase(words.join(" "));
}

/** The user's text a naming prompt wraps in `<tag>…</tag>` (`@/core/ai`'s `delimit`); the whole prompt when unwrapped. */
function inner(prompt: string, tag: string): string {
  return prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? prompt;
}

function branch(prompt: string): string {
  const w = salient(inner(prompt, "task")).slice(0, 3);
  return w.length >= 2 ? w.join("-") : ["update", ...w, "task"].slice(0, 3).join("-");
}

function agentName(prompt: string): string {
  const words = salient(inner(prompt, "task"));
  const nouns = words.filter((w) => !VERBS[w]);
  return (nouns.length ? nouns : words).slice(0, 2).join("-") || "helper";
}

function commit(prompt: string): string {
  const files = changedFiles(prompt);
  const note = line(prompt, "Author's note");
  const names = files.map((f) => f.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? f.path);
  const summary = note
    ? titleOf(note, 7).replace(/^./, (c) => c.toLowerCase())
    : `update ${names.slice(0, 2).join(" and ") || "project files"}${names.length > 2 ? ` (+${names.length - 2} more)` : ""}`;
  const bullets = files.slice(0, 5).map((f) => `- ${f.verb} ${f.path}`);
  return [`feat: ${summary}`.slice(0, 72), ...(bullets.length ? ["", ...bullets] : [])].join("\n");
}

function pr(prompt: string): string {
  const branchName = line(prompt, "Branch")?.split(" → ")[0] ?? "changes";
  const commits = section(prompt, "Commits").map((c) => c.replace(/^-\s*/, ""));
  const files = changedFiles(prompt);
  const fromCommit = commits[0]?.replace(/^\w+(?:\([^)]*\))?!?:\s*/, "");
  const title = sentenceCase(fromCommit || (branchName.split("/").pop() ?? branchName).replace(/[-_]+/g, " "));
  const body = [
    "## Summary",
    `${title}.`,
    ...(commits.length ? ["", "## Changes", ...commits.slice(0, 8).map((c) => `- ${c}`)] : []),
    ...(files.length ? ["", "## Files", ...files.slice(0, 10).map((f) => `- \`${f.path}\``)] : []),
  ];
  return `Title: ${title}\nBody:\n${body.join("\n")}`;
}

/** Spoken-prompt noise the demo model drops. */
const FILLER_RE = /\b(?:u+m+|u+h+|e+r+m?|h+m+|you know|basically|sort of|kind of|i guess|okay so|ok so|right so|so yeah|yeah)\b,?\s*/gi;
/** One word, then a spoken self-correction, then its replacement: only the replacement stays. */
const CORRECTION_RE = /([\w./-]+),?\s+(?:no,? wait|no no|scratch that|sorry|i mean)\b,?\s+(?:i mean\s+)?([\w./-]+)/i;
/** Where a new request starts. */
const SENTENCE_RE = /\s+(?=(?:and also|and then|oh and|one more thing|and make sure)\b)|(?<!\band)\s+(?=(?:also|then|plus)\b)/i;

/**
 * The demo `ramble` model: the transcript with fillers dropped, one-word self-corrections applied, spoken paths and
 * identifiers written out ("src slash net slash upload dot ts"), and capitalised sentences, split where a new
 * request starts.
 */
function ramble(prompt: string): string {
  let t = inner(prompt, "transcript")
    .replace(/\s+/g, " ")
    .replace(/\s*\bslash\b\s*/gi, "/")
    .replace(/\s+dot\s+(?=[a-z]{1,4}\b)/gi, ".")
    .trim();
  for (let i = 0; i < 8 && CORRECTION_RE.test(t); i++) t = t.replace(CORRECTION_RE, "$2");
  t = t
    .replace(FILLER_RE, "")
    .replace(/^so\s+/i, "")
    .replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1")
    .trim();
  return t
    .split(SENTENCE_RE)
    .map((s) => s.replace(/^(?:and|then|oh and)\s+/i, "").replace(/[\s,.]+$/, ""))
    .filter(Boolean)
    .map((s) => `${sentenceCase(s)}.`)
    .join(" ");
}

function templateName(prompt: string): string {
  const model = (line(prompt, "Model") ?? "").split("/").pop()?.split(":")[0] ?? "";
  const thinking = (line(prompt, "Thinking") ?? "").toLowerCase();
  const plan = line(prompt, "Plan mode") === "on";
  const task = (prompt.includes("<prompt>") ? inner(prompt, "prompt") : "").toLowerCase();
  const gpt = model.match(/gpt-[\d.]+/)?.[0];
  const family = gpt ? gpt.toUpperCase() : ["opus", "sonnet", "haiku", "luna", "gemini"].find((f) => model.includes(f));
  const who = family ? (gpt ? family : sentenceCase(family)) : "";
  const adj = thinking === "xhigh" ? "Deep" : thinking === "high" ? "Careful" : thinking === "medium" ? "Steady" : thinking === "low" || thinking === "minimal" || thinking === "off" ? "Quick" : "Everyday";
  const role = plan ? "planner" : /review/.test(task) ? "reviewer" : /test/.test(task) ? "tester" : /doc|readme/.test(task) ? "writer" : /fix|bug/.test(task) ? "fixer" : /map|explor/.test(task) ? "explorer" : "worker";
  return [adj, who, role].filter(Boolean).join(" ");
}

/** Tool and path noise that is no name (the live line often reads `edit src/core/x.ts`). */
const NOISE: Record<string, true> = Object.fromEntries(["edit", "read", "bash", "grep", "glob", "write", "src", "ts", "tsx", "js", "json", "md", "rs", "now", "running", "reading", "editing", "searching"].map((w) => [w, true]));

/**
 * `Name:` and `Title:` for the session's overall work: its goal, else the first prompt (the objective), else the newest
 * prompt when it opens with a verb (a follow-up like "fine, skip it" says nothing about the work), else the recap, the
 * current title or the last reply, up to a colon; the name is the title's last two nouns, or the live line's when the
 * title has none.
 */
function agentRename(prompt: string): string {
  const tag = (name: string) => (prompt.includes(`<${name}>`) ? inner(prompt, name) : undefined);
  const activity = tag("latest-activity") ?? "";
  const current = tag("current") ?? "";
  const latest = tag("latest-prompt");
  const work = tag("goal") ?? tag("first-prompt") ?? (latest && VERBS[salient(latest)[0] ?? ""] ? latest : undefined);
  const about = work ?? line(activity, "Recap") ?? line(current, "Title") ?? line(activity, "Last reply")?.replace(/^…/, "") ?? line(activity, "Now") ?? "Helper";
  const title = titleOf(about.split(/[:;]\s/)[0] ?? about);
  const nouns = (text: string) => salient(text).filter((w) => !NOISE[w] && !VERBS[w]);
  const words = nouns(title).length ? nouns(title) : nouns(line(activity, "Now") ?? "");
  const name = words.slice(-2).join("-") || line(current, "Name") || "helper";
  return `Name: ${name}\nTitle: ${title}`;
}

/** The demo model's answer for one `ai.complete` task. */
export function demoAiComplete(task: string, prompt: string): Omit<AiCompleteResult, "ms"> {
  const text =
    task === "branch" ? branch(prompt)
    : task === "agentName" ? agentName(prompt)
    : task === "agentRename" ? agentRename(prompt)
    : task === "commit" ? commit(prompt)
    : task === "pr" ? pr(prompt)
    : task === "templateName" ? templateName(prompt)
    : task === "ramble" ? ramble(prompt)
    : titleOf(inner(prompt, "text"));
  return { text, model: MODEL };
}
