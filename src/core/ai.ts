/**
 * AI naming and drafting through omp's `tiny` model role on the host (`ai.complete`).
 *
 * Every helper resolves to `null` when the caller should use its deterministic fallback: AI naming
 * off, host without `ai.complete` / omp, timeout, error or junk output. Results are cached 10 min
 * per host + task + input; identical in-flight calls share one request; a host answering
 * `unknown_method` / `ai_unavailable` is skipped for 10 min.
 */
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { AiCompleteParams, AiCompleteResult } from "./gen";
import { core } from "./client";
import { isApiError } from "./errors";
import { usePrefs } from "./prefs";

export type AiTask = "branch" | "agentName" | "title" | "commit" | "pr" | "templateName";

export interface AiCallOptions {
  timeoutMs?: number;
  cwd?: string;
}

const CACHE_MS = 10 * 60_000;
const UNAVAILABLE_MS = 10 * 60_000;
/** Host-side budgets (queue + omp run). Naming must stay short; drafts read a patch. */
const NAMING_TIMEOUT_MS = 12_000;
const DRAFT_TIMEOUT_MS = 25_000;
/** Extra client-side wait beyond the host budget before giving up on a silent host. */
const CLIENT_SLACK_MS = 5_000;
/** The app core's host-request timeout is 30 s (`tf-client` link); stay inside it. */
const MAX_TIMEOUT_MS = 28_000;
const TASK_MAX = 2_000;
const PATCH_MAX = 12_000;
const FILES_MAX = 4_000;
const COMMITS_MAX = 30;

/** Single-line on purpose: omp.cmd (Windows npm installs) cannot take newlines in arguments. */
export const AI_SYSTEM: Record<AiTask, string> = {
  branch: "Reply with ONLY a kebab-case git branch slug of 2-5 words describing the task. No prefix, no quotes.",
  agentName:
    "Reply with ONLY a short kebab-case name of 1-2 lowercase words for a coding agent doing this task, like cache-fix or docs. No prefix, no quotes, no explanation.",
  title: "Reply with ONLY a short title for this text: at most 6 words, sentence case, no quotes, no trailing period.",
  commit:
    "Write a git commit message for these changes. Line 1 is the subject: imperative mood, at most 72 characters, no trailing period. Then, only if useful, a blank line and 1-5 short '- ' bullet lines. Reply with ONLY the message: no code fences, no quotes, no commentary.",
  pr: "Write a pull request for these changes. Reply with ONLY two parts and nothing else: first a line starting with 'Title: ' followed by an imperative title of at most 72 characters, then a line containing only 'Body:' followed by markdown lines: a 1-2 sentence summary, then '- ' bullets of the main changes.",
  templateName:
    "Reply with ONLY a short name (1-4 words, sentence case) for a reusable coding-agent preset with these settings, like Careful reviewer or Fast fixer. No quotes, no explanation.",
};

// ───────────────────────────── availability ─────────────────────────────

const useAiHosts = create<{ unavailableUntil: Record<string, number> }>(() => ({ unavailableUntil: {} }));

type Complete = (hostId: string, params: AiCompleteParams) => Promise<AiCompleteResult>;
const realComplete: Complete = (hostId, params) => core.host(hostId).call("ai.complete", params);
let complete: Complete = realComplete;
let now: () => number = () => Date.now();

function hostUnavailable(hostId: string): boolean {
  const until = useAiHosts.getState().unavailableUntil[hostId];
  return until !== undefined && until > now();
}

/** AI naming is on (Settings → AI naming) and the host has not answered "unavailable" lately. */
export function aiNamingEnabled(hostId: string | undefined): boolean {
  return hostId !== undefined && usePrefs.getState().aiNaming && !hostUnavailable(hostId);
}

/** Hook form of {@link aiNamingEnabled}. */
export function useAiNaming(hostId: string | undefined): boolean {
  const on = usePrefs((s) => s.aiNaming);
  const until = useAiHosts((s) => (hostId === undefined ? undefined : s.unavailableUntil[hostId]));
  return on && hostId !== undefined && !(until !== undefined && until > now());
}

// ───────────────────────────── cache + calls ─────────────────────────────

const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

/** cyrb53: a fast 53-bit string hash (cache keys only). */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ai.complete: no answer")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** One cached, deduplicated `ai.complete` call; `parse` turns the raw text into a value or `null` (junk). */
async function ask<T>(hostId: string, task: AiTask, prompt: string, parse: (text: string) => T | null, opts: AiCallOptions = {}, keyExtra = ""): Promise<T | null> {
  if (!aiNamingEnabled(hostId)) return null;
  const key = `${hostId}\u0000${task}\u0000${hash(`${prompt}\u0000${keyExtra}`)}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_MS) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T | null>;
  const timeoutMs = Math.min(opts.timeoutMs ?? (task === "commit" || task === "pr" ? DRAFT_TIMEOUT_MS : NAMING_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const params: AiCompleteParams = { task, system: AI_SYSTEM[task], prompt, timeoutMs, ...(opts.cwd ? { cwd: opts.cwd } : {}) };
  const run = (async (): Promise<T | null> => {
    try {
      const res = await withDeadline(complete(hostId, params), timeoutMs + CLIENT_SLACK_MS);
      const value = parse(res.text);
      if (value !== null) cache.set(key, { at: now(), value });
      return value;
    } catch (e) {
      if (isApiError(e) && (e.code === "unknown_method" || e.code === "ai_unavailable")) {
        useAiHosts.setState((s) => ({ unavailableUntil: { ...s.unavailableUntil, [hostId]: now() + UNAVAILABLE_MS } }));
      }
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}\n…(truncated)` : t;
}

// ───────────────────────────── public helpers ─────────────────────────────

/** Kebab branch slug, 2–5 words, ≤ 40 chars, starts with a letter, no prefix. */
export function suggestBranch(hostId: string, task: string, opts?: AiCallOptions): Promise<string | null> {
  const prompt = clip(task, TASK_MAX);
  if (!prompt) return Promise.resolve(null);
  return ask(hostId, "branch", prompt, (t) => sanitizeSlug(t, { minWords: 2, maxWords: 5, maxLen: 40 }), opts);
}

/** Kebab agent name, 1–3 words, ≤ 24 chars, unique against `taken` (case-insensitive). */
export function suggestAgentName(hostId: string, task: string, taken: readonly string[], opts?: AiCallOptions): Promise<string | null> {
  const text = clip(task, TASK_MAX);
  if (!text) return Promise.resolve(null);
  const shown = taken.slice(0, 40);
  const prompt = shown.length ? `${text}\n\nNames already taken: ${shown.join(", ")}` : text;
  return ask(hostId, "agentName", prompt, (t) => sanitizeAgentName(t, taken), opts, taken.join("\u0001"));
}

/** ≤ 6 words, sentence case, no quotes or trailing period. */
export function suggestTitle(hostId: string, text: string, opts?: AiCallOptions): Promise<string | null> {
  const prompt = clip(text, TASK_MAX);
  if (!prompt) return Promise.resolve(null);
  return ask(hostId, "title", prompt, (t) => sanitizeTitle(t, 6), opts);
}

export function suggestCommitMessage(
  hostId: string,
  input: { files: string; patch?: string; hint?: string },
  opts?: AiCallOptions,
): Promise<{ subject: string; body?: string } | null> {
  if (!input.files.trim() && !input.patch?.trim()) return Promise.resolve(null);
  const parts: string[] = [];
  if (input.hint?.trim()) parts.push(`Author's note: ${clip(input.hint, TASK_MAX)}`);
  parts.push(`Changed files:\n${clip(input.files, FILES_MAX)}`);
  if (input.patch?.trim()) parts.push(`Patch:\n${clip(input.patch, PATCH_MAX)}`);
  return ask(hostId, "commit", parts.join("\n\n"), parseCommitMessage, opts);
}

export function suggestPullRequest(
  hostId: string,
  input: { branch: string; base: string; commits: string[]; files: string; patch?: string },
  opts?: AiCallOptions,
): Promise<{ title: string; body: string } | null> {
  const parts = [`Branch: ${input.branch} → ${input.base}`];
  const commits = input.commits.map((c) => c.trim()).filter(Boolean).slice(0, COMMITS_MAX);
  if (commits.length) parts.push(`Commits:\n${commits.map((c) => `- ${clip(c.split("\n")[0] ?? c, 200)}`).join("\n")}`);
  if (input.files.trim()) parts.push(`Changed files:\n${clip(input.files, FILES_MAX)}`);
  if (input.patch?.trim()) parts.push(`Patch:\n${clip(input.patch, PATCH_MAX)}`);
  if (parts.length === 1) return Promise.resolve(null);
  return ask(hostId, "pr", parts.join("\n\n"), parsePullRequest, opts);
}

export function suggestTemplateName(
  hostId: string,
  input: { model?: string; thinking?: string; plan?: boolean; prompt?: string },
  opts?: AiCallOptions,
): Promise<string | null> {
  const parts = [
    `Model: ${input.model?.trim() || "host default"}`,
    `Thinking: ${input.thinking?.trim() || "default"}`,
    `Plan mode: ${input.plan ? "on" : "off"}`,
  ];
  if (input.prompt?.trim()) parts.push(`Prompt: ${clip(input.prompt, TASK_MAX)}`);
  return ask(hostId, "templateName", parts.join("\n"), (t) => sanitizeTitle(t, 4), opts);
}

/**
 * Debounced suggestion for the current input; `key` null = nothing to suggest. Re-runs when `key`
 * changes; a result for an older key is dropped.
 */
export function useAiSuggestion<T>(
  hostId: string | undefined,
  key: string | null,
  run: () => Promise<T | null>,
  opts?: { debounceMs?: number },
): { value: T | null; loading: boolean } {
  const enabled = useAiNaming(hostId);
  const active = enabled && key !== null;
  const debounceMs = opts?.debounceMs ?? 900;
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  // Result of the last finished run, tagged with the host + key it was for.
  const [done, setDone] = useState<{ tag: string; value: T | null } | null>(null);
  const tag = `${hostId ?? ""}\u0000${key ?? ""}`;
  useEffect(() => {
    if (!active) return;
    let live = true;
    const t = setTimeout(() => {
      runRef.current().then(
        (value) => live && setDone({ tag, value }),
        () => live && setDone({ tag, value: null }),
      );
    }, debounceMs);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [active, tag, debounceMs]);
  if (!active) return { value: null, loading: false };
  // Waiting out the debounce counts as loading: the "Naming…" state shows at once.
  return done?.tag === tag ? { value: done.value, loading: false } : { value: null, loading: true };
}

// ───────────────────────────── sanitizers (exported for tests) ─────────────────────────────

/** Leading chatter of small models ("Sure! Here is …"). */
const CHATTER_RE = /^(?:sure|okay|ok|certainly|of course|absolutely|great|here(?:'s|’s| is| are)|i (?:would|suggest|recommend|propose)|how about|suggested|based on|a good)\b/i;
/** Labels models put in front of the answer. */
const LABEL_RE = /^(?:(?:git\s+)?branch(?:\s+name)?|slug|(?:agent\s+)?name|title|subject|(?:template|preset)(?:\s+name)?|answer|output|suggestion|result|commit(?:\s+message)?)\s*[:=\-–]\s*/i;
const CONVENTIONAL_RE = /^(?:feat|fix|chore|docs|refactor|test|tests|perf|build|ci|style)(?:\([^)]*\))?!?\s*:\s*/i;
const WRAP_RE = /^[\s"'`*_“”‘’«»]+|[\s"'`*_“”‘’«»]+$/g;
const STOP: Record<string, true> = Object.fromEntries(
  ["a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with", "at", "by", "from", "this", "that", "it", "into", "is", "be"].map((w) => [w, true]),
);
/** Code-fence lines (```lang). */
const FENCE_RE = /^\s*```[^\n]*$/gm;

/** Non-empty lines without code fences or list markers. */
function lines(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```"))
    .map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, ""));
}

/** Strips labels and wrapping quotes / backticks / emphasis. */
function unwrap(s: string): string {
  let t = s.trim();
  for (let i = 0; i < 3; i++) {
    const next = t.replace(WRAP_RE, "").replace(LABEL_RE, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** Chatter with a colon ("Here is a name: foo") → the part after it; pure chatter → null. */
function dechat(line: string): string | null {
  if (!CHATTER_RE.test(line)) return line;
  const i = line.lastIndexOf(":");
  if (i < 0) return null;
  const rest = line.slice(i + 1).trim();
  return rest || null;
}

/** Candidate answers in priority order: quoted tokens, slug-shaped lines, then plain lines. */
function slugCandidates(text: string): string[] {
  const ls = lines(text);
  const out: string[] = [];
  for (const l of ls) {
    for (const m of l.matchAll(/[`"“'‘]([A-Za-z][\w./-]{0,79})[`"”'’]/g)) if (m[1]) out.push(m[1]);
  }
  for (const l of ls) {
    const u = unwrap(dechat(l) ?? "");
    if (/^[A-Za-z][\w./-]*$/.test(u)) out.push(u);
  }
  for (const l of ls) {
    const d = dechat(l);
    if (d) out.push(unwrap(d));
  }
  return out;
}

function slugify(raw: string, o: { minWords: number; maxWords: number; maxLen: number }): string | null {
  let s = unwrap(raw).replace(CONVENTIONAL_RE, "");
  if (s.includes("/")) s = s.split("/").filter(Boolean).pop() ?? "";
  s = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  let words = s.split("-").filter(Boolean);
  // A sentence, not a name.
  if (words.length > o.maxWords * 2 + 2) return null;
  if (words.length > o.maxWords) {
    const lean = words.filter((w, i) => i === 0 || !STOP[w]);
    if (lean.length >= o.minWords) words = lean;
  }
  words = words.slice(0, o.maxWords);
  while (words.length > o.minWords && words.join("-").length > o.maxLen) words.pop();
  while (words.length > o.minWords && STOP[words[words.length - 1] ?? ""]) words.pop();
  let out = words.join("-");
  if (out.length > o.maxLen) out = out.slice(0, o.maxLen).replace(/-+$/, "");
  if (words.length < o.minWords || !/^[a-z]/.test(out)) return null;
  return out;
}

/** A kebab slug out of a small model's reply, or null when nothing usable is in it. */
export function sanitizeSlug(text: string, o: { minWords: number; maxWords: number; maxLen: number }): string | null {
  for (const c of slugCandidates(text)) {
    const s = slugify(c, o);
    if (s) return s;
  }
  return null;
}

export function sanitizeAgentName(text: string, taken: readonly string[]): string | null {
  const base = sanitizeSlug(text, { minWords: 1, maxWords: 3, maxLen: 24 });
  if (!base) return null;
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    let stem = base;
    while (stem.length + suffix.length > 24) {
      const cut = stem.lastIndexOf("-");
      stem = cut > 0 ? stem.slice(0, cut) : stem.slice(0, 24 - suffix.length);
    }
    const name = `${stem}${suffix}`;
    if (!used.has(name)) return name;
  }
  return null;
}

/** Short sentence-case title (≤ `maxWords` words), or null. */
export function sanitizeTitle(text: string, maxWords: number): string | null {
  let line: string | null = null;
  for (const l of lines(text)) {
    const d = dechat(l);
    if (d && unwrap(d)) {
      line = unwrap(d);
      break;
    }
  }
  if (!line) return null;
  let words = line
    .replace(/^#+\s*/, "")
    .replace(/[.!?:;,…]+$/u, "")
    .replace(WRAP_RE, "")
    .split(/\s+/)
    .filter(Boolean);
  const alpha = words.filter((w) => /[a-z]/i.test(w));
  if (!alpha.length) return null;
  if (alpha.length > 1 && alpha.every((w) => w === w.toUpperCase())) {
    words = words.map((w) => w.toLowerCase());
  } else if (alpha.length > 1 && alpha.slice(1).every((w) => /^[A-Z]/.test(w) || STOP[w])) {
    // Title Case (every word after the first capitalised, small words aside) → sentence case;
    // only simple capitalised words are lowered, so API, GitHub and iOS stay.
    words = words.map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w));
  }
  if (words.length > maxWords) {
    words = words.slice(0, maxWords);
    while (words.length > 1 && STOP[(words[words.length - 1] ?? "").toLowerCase()]) words.pop();
  }
  const first = words[0] ?? "";
  words[0] = /^[a-z]/.test(first) ? first[0]!.toUpperCase() + first.slice(1) : first;
  const out = words.join(" ").replace(/[.!?:;,…"'`]+$/u, "").trim();
  return out && /[a-z]/i.test(out) ? out : null;
}

/** Cuts at a word boundary to ≤ `max` chars. */
function capWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1).lastIndexOf(" ");
  return (cut > max / 2 ? s.slice(0, cut) : s.slice(0, max)).replace(/[\s,;:–-]+$/, "");
}

export function parseCommitMessage(text: string): { subject: string; body?: string } | null {
  const ls = text.replace(/\r/g, "").replace(FENCE_RE, "").split("\n");
  while (ls.length && (!ls[0]!.trim() || (CHATTER_RE.test(ls[0]!.trim()) && /:\s*$/.test(ls[0]!.trim())))) ls.shift();
  if (!ls.length) return null;
  const subject = capWords(
    unwrap(dechat(ls[0]!.trim()) ?? "")
      .replace(/\.+$/, "")
      .trim(),
    72,
  );
  if (!/[a-z]/i.test(subject)) return null;
  const rest = ls.slice(1).join("\n").trim().replace(/^body\s*:\s*/i, "").trim();
  const body = rest.length > 2_000 ? rest.slice(0, 2_000).trimEnd() : rest;
  return body ? { subject, body } : { subject };
}

function cleanPrTitle(s: string): string {
  return capWords(unwrap(s.replace(/^#+\s*/, "")).replace(/\.+$/, "").trim(), 72);
}

export function parsePullRequest(text: string): { title: string; body: string } | null {
  const t = text.replace(/\r/g, "").replace(FENCE_RE, "").trim();
  if (!t) return null;
  const json = t.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const v = JSON.parse(json[0]) as { title?: unknown; body?: unknown };
      if (typeof v.title === "string" && cleanPrTitle(v.title)) return { title: cleanPrTitle(v.title), body: typeof v.body === "string" ? v.body.trim() : "" };
    } catch {
      // not JSON; fall through to the line format
    }
  }
  const all = t.split("\n");
  const ti = all.findIndex((l) => /^\s*(?:\*\*)?title(?:\*\*)?\s*:/i.test(l));
  let title: string;
  let bodyLines: string[];
  if (ti >= 0) {
    title = all[ti]!.replace(/^\s*(?:\*\*)?title(?:\*\*)?\s*:\s*(?:\*\*)?/i, "");
    bodyLines = all.slice(ti + 1);
  } else {
    const fi = all.findIndex((l) => l.trim() && !(CHATTER_RE.test(l.trim()) && /:\s*$/.test(l.trim())));
    if (fi < 0) return null;
    title = all[fi]!;
    bodyLines = all.slice(fi + 1);
  }
  const bi = bodyLines.findIndex((l) => /^\s*(?:\*\*)?body(?:\*\*)?\s*:/i.test(l));
  if (bi >= 0) bodyLines = [bodyLines[bi]!.replace(/^\s*(?:\*\*)?body(?:\*\*)?\s*:\s*(?:\*\*)?/i, ""), ...bodyLines.slice(bi + 1)];
  const clean = cleanPrTitle(title);
  if (!/[a-z]/i.test(clean)) return null;
  return { title: clean, body: bodyLines.join("\n").trim() };
}

// ───────────────────────────── test seam ─────────────────────────────

/** Tests only: swap the transport and clock, reset caches and the unavailable memo. */
export const aiTesting = {
  setComplete(fn: Complete | null): void {
    complete = fn ?? realComplete;
  },
  setNow(fn: (() => number) | null): void {
    now = fn ?? (() => Date.now());
  },
  reset(): void {
    cache.clear();
    inflight.clear();
    useAiHosts.setState({ unavailableUntil: {} });
  },
};
