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

export function demoAiLatency(prompt: string): number {
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

function branch(prompt: string): string {
  const w = salient(prompt).slice(0, 3);
  return w.length >= 2 ? w.join("-") : ["update", ...w, "task"].slice(0, 3).join("-");
}

function agentName(prompt: string): string {
  const task = prompt.split("\n\nNames already taken:")[0] ?? prompt;
  const words = salient(task);
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

function templateName(prompt: string): string {
  const model = (line(prompt, "Model") ?? "").split("/").pop()?.split(":")[0] ?? "";
  const thinking = (line(prompt, "Thinking") ?? "").toLowerCase();
  const plan = line(prompt, "Plan mode") === "on";
  const task = (line(prompt, "Prompt") ?? "").toLowerCase();
  const gpt = model.match(/gpt-[\d.]+/)?.[0];
  const family = gpt ? gpt.toUpperCase() : ["opus", "sonnet", "haiku", "luna", "gemini"].find((f) => model.includes(f));
  const who = family ? (gpt ? family : sentenceCase(family)) : "";
  const adj = thinking === "xhigh" ? "Deep" : thinking === "high" ? "Careful" : thinking === "medium" ? "Steady" : thinking === "low" || thinking === "minimal" || thinking === "off" ? "Quick" : "Everyday";
  const role = plan ? "planner" : /review/.test(task) ? "reviewer" : /test/.test(task) ? "tester" : /doc|readme/.test(task) ? "writer" : /fix|bug/.test(task) ? "fixer" : /map|explor/.test(task) ? "explorer" : "worker";
  return [adj, who, role].filter(Boolean).join(" ");
}

/** The demo model's answer for one `ai.complete` task. */
export function demoAiComplete(task: string, prompt: string): Omit<AiCompleteResult, "ms"> {
  const text =
    task === "branch" ? branch(prompt)
    : task === "agentName" ? agentName(prompt)
    : task === "commit" ? commit(prompt)
    : task === "pr" ? pr(prompt)
    : task === "templateName" ? templateName(prompt)
    : titleOf(prompt);
  return { text, model: MODEL };
}
