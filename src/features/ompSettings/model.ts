/**
 * Pure helpers of the omp settings page: omp's tab/group layout, search, per-type editors,
 * value parsing/validation and model-role selectors. No React, no I/O (tested in model.test.ts).
 */
import type { OmpSetting, OmpSettingChange, OmpSettingOption, OmpSettings, ThinkingLevel } from "@/core/gen";

/** omp's settings tabs in panel order, with their section groups in order (pi-tui `settings-defs`). */
export const OMP_TABS: readonly { id: string; label: string; lead: string; groups: readonly string[] }[] = [
  { id: "appearance", label: "Appearance", lead: "Theme, composer, status line and how the transcript renders.", groups: ["Theme", "Composer", "Status Line", "Display", "Images"] },
  { id: "model", label: "Model", lead: "Thinking, sampling, the system prompt, retries and the helper models.", groups: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"] },
  {
    id: "interaction",
    label: "Interaction",
    lead: "Input, approvals, notifications, speech and what happens at startup.",
    groups: ["Input", "Approvals", "Notifications", "Speech", "Collab", "Stream", "Magic Keywords", "Startup & Updates", "Power", "Agent", "Git", "Skills"],
  },
  { id: "context", label: "Context", lead: "What the model sees, and when and how the conversation compacts.", groups: ["General", "Compaction", "Rules (TTSR)", "Experimental"] },
  { id: "memory", label: "Memory", lead: "What omp remembers across sessions and where it keeps it.", groups: ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"] },
  { id: "files", label: "Files", lead: "How files are read, summarized and edited, and the language servers.", groups: ["Editing", "Reading", "Read Summaries", "LSP"] },
  { id: "shell", label: "Shell", lead: "The bash tool and the eval runtimes.", groups: ["Bash", "Eval & Runtimes"] },
  {
    id: "tools",
    label: "Tools",
    lead: "Which tools the model has, their limits and the external integrations.",
    groups: ["Available Tools", "Todos", "Grep & Browser", "Computer", "IDA Pro", "GitHub", "Output Limits", "Execution", "Discovery & MCP", "Extensions", "Developer"],
  },
  { id: "tasks", label: "Tasks", lead: "Modes, subagents, isolation and custom commands.", groups: ["Modes", "Subagents", "Isolation", "Commands & Skills"] },
  { id: "providers", label: "Providers", lead: "Services, provider protocols, timeouts and privacy.", groups: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"] },
];

/** Settings omp's panel does not show (config.yml / `omp config set` only), grouped by key prefix. */
export const OTHER_TAB = "other";
export const MODEL_ROLES_KEY = "modelRoles";

export interface SettingSection {
  /** omp group name, or the key prefix on the Other tab; absent = the tab's ungrouped settings. */
  title?: string;
  settings: OmpSetting[];
}

export interface SettingTab {
  id: string;
  label: string;
  lead?: string;
  sections: SettingSection[];
  /** Settings on the tab (the model-roles editor counts on Model). */
  count: number;
  modified: number;
}

/** Groups in a known order first, then unknown ones as they appear; ungrouped first (omp's layout). */
function sectionsInOrder(settings: OmpSetting[], key: (s: OmpSetting) => string | undefined, order: readonly string[]): SettingSection[] {
  const byTitle = new Map<string | undefined, OmpSetting[]>();
  for (const s of settings) {
    const k = key(s);
    const list = byTitle.get(k);
    if (list) list.push(s);
    else byTitle.set(k, [s]);
  }
  const titles = [...byTitle.keys()].sort((a, b) => {
    if (a === undefined || b === undefined) return a === undefined ? (b === undefined ? 0 : -1) : 1;
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
  return titles.map((title) => ({ title, settings: byTitle.get(title) ?? [] }));
}

/** Key prefix section of a setting without ui: `thinkingBudgets.low` → `thinkingBudgets`; bare keys → General. */
export function otherSection(id: string): string {
  const dot = id.indexOf(".");
  return dot < 0 ? "General" : id.slice(0, dot);
}

/**
 * omp's tabs (panel order; unknown tabs from newer omp after them) with their groups, then
 * Other for every key omp's panel lacks. Every setting lands on exactly one tab;
 * `modelRoles` is edited by the roles editor on Model.
 */
export function buildTabs(settings: readonly OmpSetting[]): SettingTab[] {
  const tabIds = [...OMP_TABS.map((t) => t.id)];
  for (const s of settings) if (s.tab && !tabIds.includes(s.tab)) tabIds.push(s.tab);
  const roles = settings.find((s) => s.id === MODEL_ROLES_KEY);
  const tabs: SettingTab[] = [];
  for (const id of tabIds) {
    const meta = OMP_TABS.find((t) => t.id === id);
    const inTab = settings.filter((s) => s.tab === id && s.id !== MODEL_ROLES_KEY);
    const extra = id === "model" && roles ? [roles] : [];
    if (inTab.length === 0 && extra.length === 0) continue;
    tabs.push({
      id,
      label: meta?.label ?? id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      lead: meta?.lead,
      sections: sectionsInOrder(inTab, (s) => s.group, meta?.groups ?? []),
      count: inTab.length + extra.length,
      modified: [...inTab, ...extra].filter(isModified).length,
    });
  }
  const other = settings.filter((s) => !s.tab && s.id !== MODEL_ROLES_KEY);
  if (other.length > 0) {
    tabs.push({
      id: OTHER_TAB,
      label: "Other",
      lead: "Settings omp's own panel doesn't show: config.yml and `omp config set` only.",
      sections: sectionsInOrder(other, (s) => otherSection(s.id), ["General"]).map((sec) => (sec.title === undefined ? { ...sec, title: "General" } : sec)),
      count: other.length,
      modified: other.filter(isModified).length,
    });
  }
  return tabs;
}

/** Every term (whitespace-separated) found in the label, description, key, group or tab. */
export function matchesQuery(s: OmpSetting, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [s.label, s.description, s.id, s.group, s.tab, s.id === MODEL_ROLES_KEY ? "model roles role" : undefined].filter(Boolean).join("\n").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(rb, k) && deepEqual(ra[k], rb[k]));
}

/** Differs from omp's default (a credential: one is set). */
export function isModified(s: OmpSetting): boolean {
  if (s.credential) return s.redacted;
  if (s.value === undefined) return false;
  return !deepEqual(s.value, s.default);
}

export type EditorKind = "roles" | "secret" | "switch" | "choice" | "number" | "text" | "members" | "list" | "json";

/**
 * Whether the array holds strings: declared so (`items.type`), else a non-empty value (else
 * default) of strings only. An empty array without item schema (`bash.patterns` holds objects)
 * can't tell, so it gets the JSON editor.
 */
function stringList(s: OmpSetting): boolean {
  const items = s.items;
  if (items && typeof items === "object" && "type" in items) return items.type === "string";
  const v = Array.isArray(s.value) && s.value.length > 0 ? s.value : Array.isArray(s.default) ? s.default : [];
  return v.length > 0 && v.every((x) => typeof x === "string");
}

/** Closed vocabulary of an array: omp's ui options, else the declared item values. */
export function memberChoices(s: OmpSetting): OmpSettingOption[] | undefined {
  if (s.options?.length) return s.options;
  const items = s.items;
  if (items && typeof items === "object" && "values" in items && Array.isArray(items.values)) {
    return items.values.filter((v): v is string => typeof v === "string").map((v) => ({ value: v, label: v }));
  }
  return undefined;
}

/** The control a setting gets. */
export function editorFor(s: OmpSetting): EditorKind {
  if (s.id === MODEL_ROLES_KEY) return "roles";
  if (s.credential) return "secret";
  switch (s.type) {
    case "boolean":
      return "switch";
    case "enum":
      return "choice";
    case "number":
      return "number";
    case "string":
      return "text";
    case "array":
      if (s.editor === "json") return "json";
      if (memberChoices(s)) return "members";
      return stringList(s) ? "list" : "json";
    default:
      return "json";
  }
}

/** Labelled choices of an enum (omp's options when present, else the bare values). */
export function enumChoices(s: OmpSetting): OmpSettingOption[] {
  if (s.options?.length) return s.options;
  return (s.values ?? []).map((v) => ({ value: v, label: v }));
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A finite number (omp rejects anything else). */
export function parseNumber(text: string): Parsed<number> {
  const t = text.trim();
  if (t === "") return { ok: false, error: "Enter a number" };
  const n = Number(t);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "Not a number" };
}

/** JSON of the setting's shape: an array for `array`, an object for `record`. */
export function parseJson(text: string, type: string): Parsed<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON" };
  }
  if (type === "array" && !Array.isArray(value)) return { ok: false, error: "Must be a JSON array […]" };
  if (type === "record" && (typeof value !== "object" || value === null || Array.isArray(value))) return { ok: false, error: "Must be a JSON object {…}" };
  return { ok: true, value };
}

export function formatJson(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v, null, 2);
}

/** Display text of any value (rows, previews). */
export function valueText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ───────────────────────────── conditions ─────────────────────────────

/** omp's `ui.condition` names (`config/settings-ui.ts`): when omp shows the setting. */
const CONDITIONS: Record<string, { hint: string; holds?: (get: (id: string) => unknown, os: string | undefined) => boolean | undefined }> = {
  macOS: { hint: "macOS only", holds: (_get, os) => (os ? os === "macos" : undefined) },
  hasImageProtocol: { hint: "Only in terminals that can show images" },
  nativeRendering: { hint: "Only with native rendering" },
  advisorEnabled: { hint: "Applies when the advisor is on", holds: (get) => get("advisor.enabled") === true },
  vimModeEnabled: { hint: "Applies in Vim mode", holds: (get) => get("tui.vimMode") === true },
  hindsightActive: { hint: "Applies with the Hindsight memory backend", holds: (get) => get("memory.backend") === "hindsight" },
  mnemopiActive: { hint: "Applies with the Mnemopi memory backend", holds: (get) => get("memory.backend") === "mnemopi" },
  autolearnActive: { hint: "Applies when Auto-Learn is on", holds: (get) => get("autolearn.enabled") === true },
  autoThinkingActive: { hint: "Applies when the thinking level is auto", holds: (get) => get("defaultThinkingLevel") === "auto" },
  usageAwareFallbackEnabled: { hint: "Applies with usage-aware fallback on", holds: (get) => get("retry.usageAwareFallback") === true },
  planModeEnabled: { hint: "Applies when plan mode is enabled", holds: (get) => get("plan.enabled") === true },
  planAutosaveEnabled: { hint: "Applies when plan autosave is on", holds: (get) => get("plan.enabled") === true && get("plan.autosave") === true },
  contextFilesExtraNotProject: { hint: "Global list; a project's own list takes its place there" },
};

/** Hint for a condition, and whether it holds on this host (undefined: can't tell from here). */
export function conditionInfo(condition: string, get: (id: string) => unknown, os: string | undefined): { hint: string; holds?: boolean } {
  const c = CONDITIONS[condition];
  if (!c) return { hint: `omp shows it when ${condition.replace(/([A-Z])/g, " $1").toLowerCase()}` };
  return { hint: c.hint, holds: c.holds?.(get, os) };
}

// ───────────────────────────── model roles ─────────────────────────────

/** omp's built-in roles (`config/model-roles.ts`): chat roles, then model-kind roles. */
export const BUILTIN_ROLES: readonly { id: string; name: string; kind: boolean; description: string }[] = [
  { id: "default", name: "Default", kind: false, description: "Main model of new sessions" },
  { id: "smol", name: "Fast", kind: false, description: "Quick, cheap model for light work" },
  { id: "slow", name: "Thinking", kind: false, description: "Deep reasoning for hard problems" },
  { id: "vision", name: "Vision", kind: false, description: "Looks at images for models that can't" },
  { id: "plan", name: "Architect", kind: false, description: "Plan mode" },
  { id: "commit", name: "Commit", kind: false, description: "Commit messages" },
  { id: "tiny", name: "Tiny", kind: false, description: "Titles and names (TeleFlock's AI naming too)" },
  { id: "memory", name: "Memory", kind: false, description: "Memory extraction and recall" },
  { id: "task", name: "Subtask", kind: false, description: "Subagents of the task tool" },
  { id: "advisor", name: "Advisor", kind: false, description: "Second opinion beside the main agent" },
  { id: "widget", name: "Job widgets", kind: false, description: "Live job widgets" },
  { id: "image", name: "Image generation", kind: true, description: "Image model" },
  { id: "web", name: "Web search", kind: true, description: "Search model" },
  { id: "speech", name: "Speech", kind: true, description: "Text to speech" },
  { id: "dictation", name: "Dictation", kind: true, description: "Speech to text" },
  { id: "judge", name: "Judge", kind: true, description: "Grades and compares answers" },
];

/** Role names omp accepts as record keys (a custom role is a plain identifier). */
export const ROLE_NAME = /^[A-Za-z][\w-]{0,31}$/;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/** `provider/id[:thinking]` → model + level. A `:suffix` that is no thinking level stays part of the id (`ollama/llama3:8b`). */
export function parseRoleSelector(selector: string): { model: string; thinking?: ThinkingLevel } {
  const i = selector.lastIndexOf(":");
  if (i > 0) {
    const level = selector.slice(i + 1);
    const known = THINKING_LEVELS.find((l) => l === level);
    if (known) return { model: selector.slice(0, i), thinking: known };
  }
  return { model: selector };
}

export function formatRoleSelector(model: string, thinking?: ThinkingLevel): string {
  return thinking ? `${model}:${thinking}` : model;
}

/** The `modelRoles` record (string values only). */
export function roleRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

export interface RoleRow {
  id: string;
  name?: string;
  description?: string;
  kind: boolean;
  builtin: boolean;
  selector?: string;
}

/** Built-in roles in omp's order, then custom roles (assigned or just added) alphabetically. */
export function roleRows(record: Record<string, string>, added: readonly string[] = []): RoleRow[] {
  const rows: RoleRow[] = BUILTIN_ROLES.map((r) => ({ id: r.id, name: r.name, description: r.description, kind: r.kind, builtin: true, selector: record[r.id] }));
  const custom = [...new Set([...Object.keys(record), ...added])].filter((id) => !BUILTIN_ROLES.some((r) => r.id === id)).sort();
  for (const id of custom) rows.push({ id, kind: false, builtin: false, selector: record[id] });
  return rows;
}

/** New record with `role` set to `selector` (undefined removes the role). Key order kept. */
export function withRole(record: Record<string, string>, role: string, selector: string | undefined): Record<string, string> {
  const next = { ...record };
  if (selector) next[role] = selector;
  else delete next[role];
  return next;
}

/** Applies changes locally (reset = default; a set credential becomes `redacted`). */
export function applyLocal(data: OmpSettings, changes: readonly OmpSettingChange[]): OmpSettings {
  const byKey = new Map(changes.map((c) => [c.key, c]));
  return {
    ...data,
    settings: data.settings.map((s) => {
      const c = byKey.get(s.id);
      if (!c) return s;
      const reset = c.value === undefined || c.value === null;
      if (s.credential) return { ...s, redacted: !reset };
      return { ...s, value: reset ? s.default : c.value };
    }),
  };
}

