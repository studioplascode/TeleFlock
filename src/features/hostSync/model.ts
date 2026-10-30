/**
 * Pure model of "Make this host like that one" (`hostSync.*`, architecture §3.24): the plan by
 * section, what can be chosen and what starts chosen, the secrets a choice carries, MCP servers
 * whose secrets stay behind, how values read, results by item, failures as the dialog words them,
 * and the call sequence of a copy (export → plan; key → seal → apply).
 */
import { apiError, type CoreError, toApiError } from "@/core/errors";
import type {
  McpReload,
  McpServerDraft,
  SyncApplied,
  SyncApplyParams,
  SyncChange,
  SyncItem,
  SyncItemResult,
  SyncKey,
  SyncPlan,
  SyncPlanParams,
  SyncProfile,
  SyncSealed,
  SyncSealParams,
  SyncSection,
  SyncSignIn,
} from "@/core/gen";
import { plural, quoteArg } from "@/features/mcp/model";

export const SECTION_ORDER: readonly SyncSection[] = ["settings", "roles", "mcp", "signIns"];

export const SECTION_TITLE: Record<SyncSection, string> = {
  settings: "Settings",
  roles: "Model roles",
  mcp: "MCP servers",
  signIns: "Sign-ins",
};

/** A difference applying changes something: everything but `same` and `unsupported`. */
export function selectable(item: Pick<SyncItem, "change">): boolean {
  return item.change !== "same" && item.change !== "unsupported";
}

// ---------------------------------------------------------------- the plan

export interface PlanSection {
  section: SyncSection;
  title: string;
  /** What differs, in plan order (`unsupported` included: shown, not choosable). */
  items: SyncItem[];
  /** Equal on both hosts: folded away, never choosable. */
  same: SyncItem[];
  /** Ids of `items` that can be chosen. */
  choosable: string[];
}

/** The plan's items by section (settings, roles, MCP servers, sign-ins); sections without items are left out. */
export function groupPlan(plan: Pick<SyncPlan, "items">): PlanSection[] {
  const out: PlanSection[] = [];
  for (const section of SECTION_ORDER) {
    const all = plan.items.filter((i) => i.section === section);
    if (!all.length) continue;
    const items = all.filter((i) => i.change !== "same");
    out.push({ section, title: SECTION_TITLE[section], items, same: all.filter((i) => i.change === "same"), choosable: items.filter(selectable).map((i) => i.id) });
  }
  return out;
}

export interface PlanCounts {
  /** Items that differ (`unsupported` ones included). */
  differences: number;
  /** Differences whose value is a secret. */
  secret: number;
  same: number;
}

export function planCounts(plan: Pick<SyncPlan, "items">): PlanCounts {
  const diff = plan.items.filter((i) => i.change !== "same");
  return { differences: diff.length, secret: diff.filter((i) => i.secret).length, same: plan.items.length - diff.length };
}

/** "5 differences · 2 secret · 7 already the same". */
export function countsLine(c: PlanCounts): string {
  const parts = [c.differences ? plural(c.differences, "difference") : "No differences"];
  if (c.secret) parts.push(`${c.secret} secret`);
  if (c.same) parts.push(`${c.same} already the same`);
  return parts.join(" · ");
}

/** Preselected: what tf-hostd suggests (never a removal or a secret). */
export function defaultSelection(plan: Pick<SyncPlan, "items">): Set<string> {
  return new Set(plan.items.filter((i) => i.suggested && selectable(i)).map((i) => i.id));
}

/**
 * The choice carried over to a fresh plan of the same hosts: chosen items that can still be
 * chosen, plus suggested items the earlier plan didn't have.
 */
export function carrySelection(selected: ReadonlySet<string>, before: Pick<SyncPlan, "items">, after: Pick<SyncPlan, "items">): Set<string> {
  const known = new Set(before.items.map((i) => i.id));
  return new Set(after.items.filter((i) => selectable(i) && (selected.has(i.id) || (i.suggested && !known.has(i.id)))).map((i) => i.id));
}

/** The chosen ids that can be applied, in plan order: `hostSync.apply`'s `items`. */
export function chosenIds(plan: Pick<SyncPlan, "items">, selected: ReadonlySet<string>): string[] {
  return plan.items.filter((i) => selected.has(i.id) && selectable(i)).map((i) => i.id);
}

/** The secret ones among the chosen items, in plan order: what the source seals (`hostSync.seal`'s `items`). */
export function secretIds(plan: Pick<SyncPlan, "items">, selected: ReadonlySet<string>): string[] {
  return plan.items.filter((i) => i.secret && selected.has(i.id) && selectable(i)).map((i) => i.id);
}

/**
 * Chosen MCP definitions whose `needs` item (the server's secret values) isn't chosen: without it
 * those values stay empty on the target (or it keeps its own, as the item's notes say). Maps the
 * definition's id to the needed item, or null when the plan can't supply it.
 */
export function missingNeeds(plan: Pick<SyncPlan, "items">, selected: ReadonlySet<string>): Map<string, SyncItem | null> {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const out = new Map<string, SyncItem | null>();
  for (const i of plan.items) {
    if (!i.needs || !selected.has(i.id) || !selectable(i) || selected.has(i.needs)) continue;
    const needed = byId.get(i.needs);
    out.set(i.id, needed && selectable(needed) ? needed : null);
  }
  return out;
}

/** `selected` with `ids` turned on or off. */
export function withIds(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** A section header's checkbox: every choosable item chosen, some, or none. */
export function sectionState(section: Pick<PlanSection, "choosable">, selected: ReadonlySet<string>): "all" | "some" | "none" {
  const n = section.choosable.filter((id) => selected.has(id)).length;
  return n === 0 ? "none" : n === section.choosable.length ? "all" : "some";
}

// ---------------------------------------------------------------- wording

/** The change chip: what applying the item does to the target. */
export function changeLabel(change: SyncChange, target: string): string {
  switch (change) {
    case "add":
      return "New";
    case "change":
      return "Different";
    case "remove":
      return `Only on ${target}`;
    case "unknown":
      return "Can't compare";
    case "unsupported":
      return "Not possible here";
    case "same":
      return "Same";
  }
}

/** The change chip's tooltip. */
export function changeHint(item: Pick<SyncItem, "change" | "section">, source: string, target: string): string {
  switch (item.change) {
    case "add":
      return `${source} has it, ${target} doesn't: copying adds it.`;
    case "change":
      return `Both have it, with different values: copying replaces ${target}'s.`;
    case "remove":
      return item.section === "mcp" ? `Only ${target} has it: copying deletes it there.` : `Only ${target} has it: copying resets it to omp's default.`;
    case "unknown":
      return `Both have one, but it's secret and can't be compared: copying replaces ${target}'s.`;
    case "unsupported":
      return `It can't be applied on ${target}.`;
    case "same":
      return "Equal on both hosts.";
  }
}

/** How an absent value reads, per section. */
export const ABSENT: Record<SyncSection, string> = {
  settings: "not set",
  roles: "not set",
  mcp: "none",
  signIns: "not signed in",
};

function compactJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(compactJson).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${compactJson(x)}`).join(", ")}}`;
  return JSON.stringify(v) ?? String(v);
}

/** `{model?, fallbacks?}` → "model → fallback, fallback". */
function roleText(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const r = v as { model?: unknown; fallbacks?: unknown };
  const model = typeof r.model === "string" && r.model ? r.model : null;
  const chain = Array.isArray(r.fallbacks) ? r.fallbacks.filter((x): x is string => typeof x === "string") : [];
  if (!model && !chain.length) return null;
  return chain.length ? `${model ?? ABSENT.roles} → ${chain.join(", ")}` : (model as string);
}

/** `{server, enabled}` → "stdio · npx -y pkg · env A, B=x · on" (secrets are masked already). */
function mcpText(v: unknown): string | null {
  if (!v || typeof v !== "object" || !("server" in v)) return null;
  const { server: d, enabled } = v as { server: McpServerDraft; enabled?: boolean };
  // Masked values read as the mask (that a value is set is no secret); a secret left empty says so.
  const pairs = (list: McpServerDraft["env"]) => list.map((kv) => (kv.secret && kv.value === "" ? `${kv.key} (empty)` : `${kv.key}=${kv.value}`)).join(", ");
  const parts: string[] = [d.transport];
  parts.push(d.transport === "stdio" ? [d.command ?? "", ...(d.args ?? []).map(quoteArg)].join(" ").trim() || "(no command)" : (d.url ?? "(no URL)"));
  if (d.cwd) parts.push(`in ${d.cwd}`);
  if (d.env?.length) parts.push(`env ${pairs(d.env)}`);
  if (d.headers?.length) parts.push(`headers ${pairs(d.headers)}`);
  if (d.timeoutMs !== undefined) parts.push(`timeout ${d.timeoutMs} ms`);
  if (d.oauth?.clientId) parts.push(`OAuth app ${d.oauth.clientId}`);
  if (enabled !== undefined) parts.push(enabled ? "on" : "off");
  return parts.join(" · ");
}

/** A sign-in's identity: "account · org", "API key", plus an MCP server's host. */
export function signInText(v: unknown): string | null {
  if (!v || typeof v !== "object" || !("provider" in v)) return null;
  const s = v as SyncSignIn;
  let server: string | undefined;
  if (s.mcpUrl) {
    try {
      server = new URL(s.mcpUrl).host;
    } catch {
      server = s.mcpUrl;
    }
  }
  const who = s.kind === "apiKey" ? ["API key", s.account] : [s.account, s.org];
  return [...who, server].filter(Boolean).join(" · ") || "signed in";
}

/** One side of an item (`from` / `to`) as text; null when that host doesn't have it. */
export function formatValue(section: SyncSection, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  switch (section) {
    case "settings":
      // omp config values: strings as they are, everything else as compact JSON.
      return typeof value === "string" ? value : compactJson(value);
    case "roles":
      return roleText(value);
    case "mcp":
      return mcpText(value);
    case "signIns":
      return signInText(value);
  }
}

/** Values longer than this fold behind "Show all". */
export const PREVIEW_CHARS = 96;

/** `text` cut to `max` characters with an ellipsis. */
export function preview(text: string, max = PREVIEW_CHARS): { text: string; cut: boolean } {
  return text.length <= max ? { text, cut: false } : { text: `${text.slice(0, max - 1).trimEnd()}…`, cut: true };
}

// ---------------------------------------------------------------- results

/** `results` merged over `prev` by item id (the latest answer wins). */
export function mergeResults(prev: ReadonlyMap<string, SyncItemResult> | undefined, results: readonly SyncItemResult[]): Map<string, SyncItemResult> {
  const out = new Map(prev);
  for (const r of results) out.set(r.id, r);
  return out;
}

/** The toast after a copy. */
export function appliedSummary(applied: Pick<SyncApplied, "results" | "mcpReload">, target: string): { title: string; description?: string; ok: boolean } {
  const n = applied.results.length;
  const failed = applied.results.filter((r) => !r.ok);
  if (!failed.length) {
    const reload = reloadSummary(applied.mcpReload);
    return { title: `Copied ${plural(n, "change")} to ${target}`, ...(reload ? { description: reload } : {}), ok: true };
  }
  if (failed.length === n) return { title: `Nothing was copied to ${target}`, description: failed[0]?.error ?? "Every change failed", ok: false };
  return { title: `Copied ${n - failed.length} of ${n} changes to ${target}`, description: `${failed.length} failed: see the list`, ok: false };
}

/**
 * What reloading MCP servers did to the target's running omp sessions ("2 running sessions reloaded
 * their MCP servers · 1 busy session reloads when its turn ends · 1 session needs a restart …");
 * null when the copy changed no MCP server.
 */
export function reloadSummary(r: McpReload | undefined): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.reloaded) parts.push(`${plural(r.reloaded, "running session")} reloaded ${r.reloaded === 1 ? "its" : "their"} MCP servers`);
  if (r.queued) parts.push(r.queued === 1 ? "1 busy session reloads its MCP servers when its turn ends" : `${r.queued} busy sessions reload their MCP servers when their turns end`);
  if (r.restartNeeded) parts.push(`${plural(r.restartNeeded, "session")} ${r.restartNeeded === 1 ? "needs" : "need"} a restart to pick the changes up`);
  return parts.length ? parts.join(" · ") : "No omp session was running: new ones start with the changed MCP servers";
}

// ---------------------------------------------------------------- calls

export type SyncMethod = "hostSync.export" | "hostSync.plan" | "hostSync.keyBegin" | "hostSync.seal" | "hostSync.apply";
/** Calls `method` on host `hostId`: `core.host(hostId).call` in the app, the demo engine in tests. */
export type SyncCall = (hostId: string, method: SyncMethod, params: unknown) => Promise<unknown>;

/** export/plan: comparing; key/seal/apply: copying. */
export type SyncStep = "export" | "plan" | "key" | "seal" | "apply";
export type ComparePhase = Extract<SyncStep, "export" | "plan">;
export type ApplyPhase = Extract<SyncStep, "key" | "seal" | "apply">;

/** A failed step: which call, on which host, and the host's `ApiError`. */
export class SyncStepError extends Error {
  constructor(
    readonly step: SyncStep,
    readonly hostId: string,
    readonly error: CoreError,
  ) {
    super(error.message);
    this.name = "SyncStepError";
  }
}

async function run<T>(call: SyncCall, step: SyncStep, hostId: string, method: SyncMethod, params: unknown): Promise<T> {
  try {
    return (await call(hostId, method, params)) as T;
  } catch (err) {
    throw new SyncStepError(step, hostId, toApiError(err));
  }
}

/** Reads the source (`hostSync.export`) and has the target compare itself with it (`hostSync.plan`). */
export async function compareHosts(call: SyncCall, sourceId: string, targetId: string, onPhase?: (phase: ComparePhase) => void): Promise<{ profile: SyncProfile; plan: SyncPlan }> {
  onPhase?.("export");
  const profile = await run<SyncProfile>(call, "export", sourceId, "hostSync.export", {});
  onPhase?.("plan");
  const params: SyncPlanParams = { source: profile };
  const plan = await run<SyncPlan>(call, "plan", targetId, "hostSync.plan", params);
  return { profile, plan };
}

export interface CopyRequest {
  sourceId: string;
  targetId: string;
  /** The source's export the plan was made from. */
  profile: SyncProfile;
  plan: SyncPlan;
  selected: ReadonlySet<string>;
}

/**
 * Applies the chosen items on the target. With secrets among them: the target makes a one-time
 * key (`hostSync.keyBegin`), the source seals exactly those secrets for it (`hostSync.seal`) and
 * the sealed box goes to the target with the rest (`hostSync.apply`); the app only relays it.
 * Rejects with a `SyncStepError` naming the step and host that failed.
 */
export async function applyCopy(call: SyncCall, req: CopyRequest, onPhase?: (phase: ApplyPhase) => void): Promise<SyncApplied> {
  const items = chosenIds(req.plan, req.selected);
  if (!items.length) throw new SyncStepError("apply", req.targetId, apiError("invalid_params", "Nothing is chosen to copy"));
  const secrets = secretIds(req.plan, req.selected);
  const params: SyncApplyParams = { source: req.profile, items };
  if (secrets.length) {
    onPhase?.("key");
    const key = await run<SyncKey>(call, "key", req.targetId, "hostSync.keyBegin", {});
    onPhase?.("seal");
    const seal: SyncSealParams = { transferId: key.transferId, publicKey: key.publicKey, items: secrets };
    params.sealed = await run<SyncSealed>(call, "seal", req.sourceId, "hostSync.seal", seal);
  }
  onPhase?.("apply");
  return run<SyncApplied>(call, "apply", req.targetId, "hostSync.apply", params);
}

/** The progress line of a step. */
export function stepText(step: SyncStep, source: string, target: string): string {
  switch (step) {
    case "export":
      return `Reading ${source}…`;
    case "plan":
      return `Comparing with ${target}…`;
    case "key":
      return `${target} makes a one-time key for this copy…`;
    case "seal":
      return `${source} seals the secrets for that key…`;
    case "apply":
      return `Applying on ${target}…`;
  }
}

export interface FailureView {
  title: string;
  message: string;
  hint?: string;
  /** Compare the hosts again rather than repeat the step (a spent key, a plan that moved on). */
  restart: boolean;
}

const DOING: Record<SyncStep, (source: string, target: string) => string> = {
  export: (s) => `read omp's setup on ${s}`,
  plan: (_s, t) => `compare with ${t}`,
  key: (_s, t) => `get a one-time key from ${t}`,
  seal: (s) => `seal the secrets on ${s}`,
  apply: (_s, t) => `apply the changes on ${t}`,
};

/** A failed step as the dialog says it, by the protocol's error codes. */
export function describeFailure(f: Pick<SyncStepError, "step" | "hostId" | "error">, nameOf: (hostId: string) => string, sourceId: string, targetId: string): FailureView {
  const host = nameOf(f.hostId);
  const source = nameOf(sourceId);
  const target = nameOf(targetId);
  const { code, message, hint } = f.error;
  const couldnt = `Couldn't ${DOING[f.step](source, target)}`;
  switch (code) {
    case "unknown_method":
      return { title: `${host} runs an older tf-hostd`, message: `TeleFlock's host daemon on ${host} can't copy omp's setup yet.`, hint: `Reconnect ${host} to update it, then try again.`, restart: false };
    case "unsupported":
      return { title: couldnt, message, hint, restart: false };
    case "expired":
      return { title: "The one-time key ran out", message, hint: hint ?? `Start the copy again: ${target} makes a new key.`, restart: true };
    case "sealed_invalid":
      return { title: "The sealed secrets didn't match", message, hint: hint ?? "Start the copy again.", restart: true };
    case "invalid_params":
      return { title: couldnt, message, hint: hint ?? "Compare the hosts again, then retry.", restart: true };
    case "omp_error":
      return { title: `omp on ${host} reported an error`, message, hint, restart: false };
    case "timeout":
      return { title: `${host} took too long`, message, hint: hint ?? "It may still be working: compare again to see what changed.", restart: true };
    case "not_connected":
      return { title: `${host} isn't connected`, message, hint: hint ?? `Reconnect ${host}, then try again.`, restart: false };
    default:
      return { title: couldnt, message, hint, restart: false };
  }
}
