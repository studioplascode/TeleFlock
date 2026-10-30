/**
 * Demo `hostSync.*`: "Make this host like that one" (`tf_proto::hostsync`, tf-hostd `ops/hostsync`,
 * architecture §3.24).
 *
 * Each demo host keeps its own omp setup as a `SyncProfile`. forge and studio-pc differ in every
 * way a plan can show, whichever way round they are compared:
 * - Settings: equal (`theme.dark`), on one host only (`symbolPreset`, `steeringMode`, …), different
 *   (`defaultThinkingLevel`, a long `statusLine.leftSegments`), a credential both have
 *   (`hindsight.apiToken`: can't compare), one only studio-pc has (`searxng.token`), and a key the
 *   target's omp build lacks (forge: `speech.dictation`, studio-pc: `isolation.backend`).
 * - Model roles (`modelRoles` + `retry.fallbackChains`): equal, different, added, removed; a model
 *   the target's catalog lacks (no sign-in for its provider there) gets a note.
 * - MCP servers: equal with secrets on both (context7), different (github on / off; filesystem's
 *   absolute folder and a field TeleFlock doesn't copy), a masked API key the target can't fill
 *   (brave-search needs `mcpSecrets:brave-search`), OAuth (linear), only on forge (postgres).
 * - Sign-ins: one both hosts have (can't compare), OAuth and API keys only one has, an MCP
 *   server's OAuth; OAuth ones carry omp's refresh-token warning.
 *
 * `keyBegin` / `seal` answer obviously fake key material and a "sealed box" that names its items:
 * no secret exists in the demo. `apply` checks the one-time key (unknown, used or past its time:
 * `expired`) and that the sealed items are exactly the secret ones requested (`sealed_invalid`),
 * applies the items in plan order (an `unsupported` one, or one no longer in the plan, fails with
 * its reason) and answers the plan again: copied values are `same`, copied secrets `unknown` (both
 * hosts have one; nothing can compare them). Answers take about a second on the demo clock, so the
 * app's progress shows. Other demo hosts (demo-kind profiles in the real app) get forge's or
 * studio-pc's setup by id.
 */
import type {
  Agent,
  McpKeyValue,
  McpReload,
  McpServerDraft,
  SyncApplied,
  SyncChange,
  SyncItem,
  SyncItemResult,
  SyncKey,
  SyncMcpServer,
  SyncPlan,
  SyncProfile,
  SyncSealed,
  SyncSetting,
  SyncSignIn,
} from "../gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";
import { DEMO_SECRET_MASK as MASK } from "./mcp";
import { base64Utf8, hash } from "./rng";

/** `tf_proto::hostsync::SYNC_SUITE`. */
export const DEMO_SYNC_SUITE = "x25519-hkdf-sha256-aes256gcm/1";
/** How long a one-time key waits for the `hostSync.apply` that uses it. */
export const DEMO_SYNC_KEY_TTL_MS = 10 * 60_000;
/** Demo latency per method (ms): long enough for the app's progress to show. */
const LATENCY: Record<string, number> = { "hostSync.export": 900, "hostSync.plan": 700, "hostSync.keyBegin": 250, "hostSync.seal": 600, "hostSync.apply": 1200 };
const MCP_FILE = "~/.omp/agent/mcp.json";

export interface DemoHostSyncEnv {
  id: string;
  variant: "forge" | "studio";
  clock: DemoClock;
  /** The host's agents: its live omp sessions are the ones an MCP change reloads. */
  agents?(): Agent[];
  /** The host's omp version (`HostInfo.omp`). */
  ompVersion?(): string | undefined;
}

type Seed = "forge" | "studio";
interface RoleValue {
  model?: string;
  fallbacks?: string[];
}

interface SettingDef {
  type: string;
  label?: string;
  tab?: string;
  group?: string;
  credential?: boolean;
}

/** omp's schema entries the profiles use: labels, tabs and groups as omp's settings panel shows them. */
const SETTING_DEFS: Record<string, SettingDef> = {
  "theme.dark": { type: "string", label: "Dark Theme", tab: "appearance", group: "Theme" },
  symbolPreset: { type: "enum", label: "Symbol Preset", tab: "appearance", group: "Theme" },
  "statusLine.leftSegments": { type: "array" },
  defaultThinkingLevel: { type: "enum", label: "Thinking Level", tab: "model", group: "Thinking" },
  "retry.usageAwareFallback": { type: "boolean", label: "Usage-Aware Fallback", tab: "model", group: "Retry & Fallback" },
  "retry.fallbackChains": { type: "record", label: "Retry Fallback Chains", tab: "model", group: "Retry & Fallback" },
  modelRoles: { type: "record" },
  steeringMode: { type: "enum", label: "Steering Mode", tab: "interaction", group: "Input" },
  "tui.vimMode": { type: "boolean", label: "Vim Editing Mode", tab: "interaction", group: "Input" },
  "loop.conditionTimeoutMs": { type: "number", label: "Loop Condition Timeout (ms)", tab: "interaction", group: "Input" },
  "hindsight.apiToken": { type: "string", label: "Hindsight API Token", tab: "memory", group: "Hindsight", credential: true },
  "speech.dictation": { type: "boolean", label: "Dictation", tab: "interaction", group: "Speech" },
  "isolation.backend": { type: "enum", label: "Isolation Backend", tab: "tasks", group: "Isolation" },
  "searxng.endpoint": { type: "string", label: "SearXNG Endpoint", tab: "providers", group: "Services" },
  "searxng.token": { type: "string", credential: true },
};

const TAB_LABEL: Record<string, string> = { appearance: "Appearance", model: "Model", interaction: "Interaction", memory: "Memory", tasks: "Tasks", providers: "Providers" };

/** Keys each demo host's omp build doesn't have (tf-hostd: `unsupported`, "a key the target's omp lacks"). */
const OMP_LACKS: Record<Seed, readonly string[]> = { forge: ["speech.dictation"], studio: ["isolation.backend"] };

/** The global config keys behind model roles: the plan's Model roles section, not Settings. */
const ROLE_KEYS = new Set(["modelRoles", "retry.fallbackChains"]);

// ---------------------------------------------------------------- profiles

function setting(key: string, value?: unknown): SyncSetting {
  const d = SETTING_DEFS[key] ?? { type: "string" };
  const out: SyncSetting = { key, type: d.type, value: d.credential ? undefined : value, secret: d.credential === true };
  if (d.label) out.label = d.label;
  if (d.tab) out.tab = d.tab;
  if (d.group) out.group = d.group;
  return out;
}

/** An env variable / header holding a secret: listed masked. */
function secretKv(key: string): McpKeyValue {
  return { key, value: MASK, secret: true };
}

function stdio(command: string, args: string[], env: McpKeyValue[] = []): McpServerDraft {
  return { transport: "stdio", command, args, env, headers: [] };
}

function http(url: string, headers: McpKeyValue[] = []): McpServerDraft {
  return { transport: "http", url, args: [], env: [], headers };
}

function server(name: string, def: McpServerDraft, more: Partial<Pick<SyncMcpServer, "enabled" | "extra">> = {}): SyncMcpServer {
  return { name, server: def, enabled: more.enabled ?? true, secrets: false, signedIn: false, extra: more.extra ?? [] };
}

/** `<provider>|<12 hex digits>`: the same id on every host for the same account. */
function signInId(provider: string, identity: string): string {
  const hex = `${hash(identity).toString(16).padStart(8, "0")}${hash(`${identity}#`).toString(16).padStart(8, "0")}`;
  return `${provider}|${hex.slice(0, 12)}`;
}

function oauth(provider: string, account: string, org?: string): SyncSignIn {
  return { id: signInId(provider, `${account}|${org ?? ""}`), provider, kind: "oauth", account, ...(org ? { org } : {}) };
}

function apiKey(provider: string, account?: string): SyncSignIn {
  return { id: signInId(provider, `key|${account ?? ""}`), provider, kind: "apiKey", ...(account ? { account } : {}) };
}

function mcpOauth(url: string, account: string): SyncSignIn {
  return { id: signInId("mcp", url), provider: "mcp", kind: "oauth", account, mcpUrl: url };
}

const CONTEXT7 = (): SyncMcpServer => server("context7", stdio("npx", ["-y", "@upstash/context7-mcp"], [secretKv("CONTEXT7_API_KEY")]));
const GITHUB = (enabled: boolean): SyncMcpServer => server("github", http("https://api.githubcopilot.com/mcp/", [secretKv("Authorization")]), { enabled });

/** forge: a Linux build box. */
function forgeProfile(omp: string): SyncProfile {
  return {
    ompVersion: omp,
    settings: [
      setting("theme.dark", "anthracite"),
      setting("defaultThinkingLevel", "high"),
      setting("statusLine.leftSegments", ["model", "mode", "path", "git", "pr", "context_pct"]),
      setting("steeringMode", "all"),
      setting("loop.conditionTimeoutMs", 120000),
      setting("retry.usageAwareFallback", true),
      setting("isolation.backend", "docker"),
      setting("hindsight.apiToken"),
      setting("modelRoles", { default: "anthropic/claude-opus-5:high", smol: "openai-codex/gpt-6-luna:low", slow: "openai/gpt-5.5:xhigh", task: "anthropic/claude-sonnet-5:medium" }),
      setting("retry.fallbackChains", { default: ["anthropic/claude-sonnet-5:high", "openai/gpt-5.5:xhigh"] }),
    ],
    mcp: [
      CONTEXT7(),
      GITHUB(true),
      server("postgres", stdio("uvx", ["mcp-server-postgres", "postgresql://localhost:5432/dev"])),
      server("filesystem", stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/home/demo/code"])),
    ],
    signIns: [oauth("anthropic", "ada@example.com", "Acme"), oauth("openai-codex", "ada@example.com"), apiKey("openai", "proj_teleflock")],
  };
}

/** studio-pc: a Mac. */
function studioProfile(omp: string): SyncProfile {
  return {
    ompVersion: omp,
    settings: [
      setting("theme.dark", "anthracite"),
      setting("symbolPreset", "nerd"),
      setting("defaultThinkingLevel", "xhigh"),
      setting("statusLine.leftSegments", ["model", "path", "git", "pr", "context_pct", "cost", "token_rate", "time_spent", "session_name"]),
      setting("tui.vimMode", true),
      setting("loop.conditionTimeoutMs", 120000),
      setting("speech.dictation", true),
      setting("searxng.endpoint", "https://search.studio.lan"),
      setting("searxng.token"),
      setting("hindsight.apiToken"),
      setting("modelRoles", { default: "anthropic/claude-opus-5:xhigh", smol: "openai-codex/gpt-6-luna:low", slow: "google/gemini-3-pro:high", plan: "anthropic/claude-opus-5:xhigh" }),
      setting("retry.fallbackChains", { default: ["anthropic/claude-sonnet-5:high"] }),
    ],
    mcp: [
      CONTEXT7(),
      GITHUB(false),
      server("filesystem", stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/Users/ada/code"]), { extra: ["autoApprove"] }),
      server("brave-search", stdio("npx", ["-y", "@modelcontextprotocol/server-brave-search"], [secretKv("BRAVE_API_KEY")])),
      server("linear", http("https://mcp.linear.app/mcp")),
    ],
    signIns: [oauth("anthropic", "ada@example.com", "Acme"), oauth("openai-codex", "ada.personal@example.com"), apiKey("openrouter"), mcpOauth("https://mcp.linear.app/mcp", "ada@example.com")],
  };
}

function seedOf(env: DemoHostSyncEnv): Seed {
  if (env.variant === "studio") return "studio";
  if (env.id === "forge") return "forge";
  return hash(env.id) % 2 === 0 ? "forge" : "studio";
}

// ---------------------------------------------------------------- comparing

/** Equal as JSON, whatever the key order. */
function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

function placeOf(s: Pick<SyncSetting, "tab" | "group">): string {
  if (!s.tab) return "Other";
  const tab = TAB_LABEL[s.tab] ?? s.tab;
  return s.group ? `${tab} › ${s.group}` : tab;
}

function recordOf(p: SyncProfile, key: string): Record<string, unknown> {
  const v = p.settings.find((s) => s.key === key)?.value;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Each role's model (`modelRoles`) and fallback chain (`retry.fallbackChains`), in config order. */
function rolesOf(p: SyncProfile): Map<string, RoleValue> {
  const models = recordOf(p, "modelRoles");
  const chains = recordOf(p, "retry.fallbackChains");
  // Chains keyed by a model selector (`provider/…`) aren't roles.
  const names = [...Object.keys(models), ...Object.keys(chains).filter((k) => !(k in models) && !k.includes("/"))];
  const out = new Map<string, RoleValue>();
  for (const name of names) {
    const model = models[name];
    const chain = chains[name];
    const fallbacks = Array.isArray(chain) ? chain.filter((x): x is string => typeof x === "string") : [];
    out.set(name, { ...(typeof model === "string" && model ? { model } : {}), ...(fallbacks.length ? { fallbacks } : {}) });
  }
  return out;
}

function maskedKeys(d: McpServerDraft): { env: string[]; headers: string[] } {
  return { env: d.env.filter((e) => e.value === MASK).map((e) => e.key), headers: d.headers.filter((h) => h.value === MASK).map((h) => h.key) };
}

function hasValue(d: McpServerDraft | undefined, key: string): boolean {
  return !!d && [...d.env, ...d.headers].some((kv) => kv.key === key && kv.value === MASK);
}

function listed(keys: readonly string[]): string {
  return keys.length <= 1 ? (keys[0] ?? "") : `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;
}

function base(id: string, section: SyncItem["section"], label: string, place: string | undefined, from: unknown, to: unknown): SyncItem {
  return { id, section, change: "same", label, ...(place ? { place } : {}), from, to, secret: false, suggested: false, notes: [] };
}

function settingItems(source: SyncProfile, target: SyncProfile, lacks: ReadonlySet<string>): SyncItem[] {
  const src = new Map(source.settings.filter((s) => !ROLE_KEYS.has(s.key)).map((s) => [s.key, s]));
  const dst = new Map(target.settings.filter((s) => !ROLE_KEYS.has(s.key)).map((s) => [s.key, s]));
  const keys = [...src.keys(), ...[...dst.keys()].filter((k) => !src.has(k))];
  return keys.map((key) => {
    const s = src.get(key);
    const t = dst.get(key);
    const meta = (s ?? t) as SyncSetting;
    const item = base(`setting:${key}`, "settings", meta.label ?? key, placeOf(meta), s && !s.secret ? s.value : undefined, t && !t.secret ? t.value : undefined);
    const set = (change: SyncChange, more: Partial<SyncItem> = {}): SyncItem => ({ ...item, change, ...more });
    if (s && lacks.has(key)) return set("unsupported", { notes: [`omp ${target.ompVersion} on this host has no \`${key}\` setting: update omp here, then compare again.`] });
    if (s && !t) return s.secret ? set("add", { secret: true }) : set("add", { suggested: true });
    if (!s && t) return set("remove", { notes: [t.secret ? "This host's value is a credential: removing it deletes it from omp's config here." : "Resets it to omp's default here."] });
    if (s?.secret || t?.secret) return set("unknown", { secret: true });
    return equal(s?.value, t?.value) ? set("same") : set("change", { suggested: true });
  });
}

function roleItems(source: SyncProfile, target: SyncProfile): SyncItem[] {
  const src = rolesOf(source);
  const dst = rolesOf(target);
  const names = [...src.keys(), ...[...dst.keys()].filter((k) => !src.has(k))];
  // The target's model catalog: models of providers it has a sign-in for.
  const providers = new Set(target.signIns.map((s) => s.provider));
  return names.map((name) => {
    const s = src.get(name);
    const t = dst.get(name);
    const item = base(`role:${name}`, "roles", name, "Model › Roles", s, t);
    if (!s) return { ...item, change: "remove", notes: ["Removes the role here: sessions use the default model for it."] };
    if (t && equal(s, t)) return item;
    const provider = s.model?.split("/")[0];
    const notes = s.model && provider && !providers.has(provider) ? [`\`${s.model.replace(/:[^/:]*$/, "")}\` isn't among this host's models (no ${provider} sign-in here).`] : [];
    return { ...item, change: t ? "change" : "add", suggested: true, notes };
  });
}

function mcpItems(source: SyncProfile, target: SyncProfile): SyncItem[] {
  const src = new Map(source.mcp.map((m) => [m.name, m]));
  const dst = new Map(target.mcp.map((m) => [m.name, m]));
  const names = [...src.keys(), ...[...dst.keys()].filter((k) => !src.has(k))];
  const value = (m: SyncMcpServer | undefined) => (m ? { server: m.server, enabled: m.enabled } : undefined);
  const out: SyncItem[] = [];
  for (const name of names) {
    const s = src.get(name);
    const t = dst.get(name);
    const item = base(`mcp:${name}`, "mcp", name, MCP_FILE, value(s), value(t));
    if (!s) {
      out.push({ ...item, change: "remove", notes: ["Deletes it from omp's MCP config here."] });
      continue;
    }
    const masked = maskedKeys(s.server);
    const keys = [...masked.env, ...masked.headers];
    const own = keys.length > 0 && keys.every((k) => hasValue(t?.server, k));
    if (t && equal(value(s), value(t))) out.push(item);
    else {
      const notes: string[] = [];
      let needs: string | undefined;
      if (keys.length && own) notes.push(`Keeps this host's own value for ${listed(keys)}.`);
      else if (keys.length) {
        needs = `mcpSecrets:${name}`;
        notes.push(`Without its secrets, ${listed(keys)} ${keys.length === 1 ? "is" : "are"} left empty here.`);
      }
      if (s.signedIn) notes.push("Signed in with OAuth on the source: its sign-in is under Sign-ins.");
      if (s.extra.length) notes.push(`Not copied: ${listed(s.extra)} (TeleFlock doesn't edit ${s.extra.length === 1 ? "it" : "them"}).`);
      const paths = [s.server.cwd ?? "", ...s.server.args].filter((a) => a.startsWith("/"));
      if (paths.length) notes.push(`${listed(paths.map((p) => `\`${p}\``))} ${paths.length === 1 ? "is an absolute path" : "are absolute paths"} on the source: check ${paths.length === 1 ? "it exists" : "they exist"} here.`);
      out.push({ ...item, change: t ? "change" : "add", suggested: true, ...(needs ? { needs } : {}), notes });
    }
    if (keys.length) {
      const where = [masked.env.length ? `env ${masked.env.join(", ")}` : "", masked.headers.length ? `header ${masked.headers.join(", ")}` : ""].filter(Boolean).join(" · ");
      out.push({ ...base(`mcpSecrets:${name}`, "mcp", `${name}: secret values`, where, undefined, undefined), change: own ? "unknown" : "add", secret: true });
    }
  }
  return out;
}

function signInLabel(s: SyncSignIn): string {
  if (s.mcpUrl) {
    try {
      return new URL(s.mcpUrl).host;
    } catch {
      return s.mcpUrl;
    }
  }
  if (s.kind === "apiKey") return s.account ? `API key · ${s.account}` : "API key";
  return s.account ?? s.provider;
}

/** omp's own warning on copying an OAuth login. */
const REFRESH_NOTE = "Providers that rotate refresh tokens may sign the source out of this account once this host refreshes it.";

function signInItems(source: SyncProfile, target: SyncProfile): SyncItem[] {
  return source.signIns.map((s) => {
    const t = target.signIns.find((x) => x.id === s.id);
    const item = base(`signIn:${s.id}`, "signIns", signInLabel(s), s.provider, s, t);
    return { ...item, change: t ? "unknown" : "add", secret: true, notes: s.kind === "oauth" ? [REFRESH_NOTE] : [] };
  });
}

// ---------------------------------------------------------------- params

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw apiError("invalid_params", `missing ${what}`);
  return v as Record<string, unknown>;
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v) throw apiError("invalid_params", `missing ${key}`);
  return v;
}

function strings(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw apiError("invalid_params", `${key}: expected a list of item ids`);
  return v as string[];
}

function profileParam(v: unknown): SyncProfile {
  const p = obj(v, "source");
  if (typeof p.ompVersion !== "string" || !Array.isArray(p.settings) || !Array.isArray(p.mcp) || !Array.isArray(p.signIns)) {
    throw apiError("invalid_params", "source: expected the source host's hostSync.export");
  }
  return p as unknown as SyncProfile;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return s.size === b.length && b.every((x) => s.has(x));
}

// ---------------------------------------------------------------- host

/** One demo host's side of `hostSync.*`. */
export class DemoHostSync {
  private profile: SyncProfile;
  /** Setting keys this host's omp build doesn't have. */
  private readonly lacks: ReadonlySet<string>;
  /** Live one-time keys: transfer id → expiry. */
  private readonly keys = new Map<string, number>();
  private seq = 0;

  constructor(private readonly env: DemoHostSyncEnv) {
    const seed = seedOf(env);
    const omp = env.ompVersion?.() ?? "18.12.3";
    this.lacks = new Set(OMP_LACKS[seed]);
    this.profile = seed === "studio" ? studioProfile(omp) : forgeProfile(omp);
  }

  /**
   * Answers after the method's demo latency. Throws tf-hostd's `ApiError`s at once, like the other
   * demo modules (a rejected promise would sit unhandled through `DemoHost.call`'s own latency).
   */
  call(method: string, p: Record<string, unknown>): Promise<unknown> {
    const out = this.answer(method, p);
    // Executor form (demo clock): tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    return new Promise((resolve) => this.env.clock.after(LATENCY[method] ?? 0, () => resolve(out)));
  }

  private answer(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "hostSync.export":
        return this.export();
      case "hostSync.plan":
        return this.plan(profileParam(p.source));
      case "hostSync.keyBegin":
        return this.keyBegin();
      case "hostSync.seal":
        return this.seal(p);
      case "hostSync.apply":
        return this.apply(p);
      default:
        throw apiError("unknown_method", `unknown method ${method}`);
    }
  }

  /** What this host has, nothing secret: credentials without values, MCP secrets masked. */
  export(): SyncProfile {
    const p = structuredClone(this.profile);
    p.ompVersion = this.env.ompVersion?.() ?? p.ompVersion;
    for (const m of p.mcp) {
      const k = maskedKeys(m.server);
      m.secrets = k.env.length + k.headers.length > 0;
      m.signedIn = !!m.server.url && p.signIns.some((s) => s.mcpUrl === m.server.url);
    }
    return p;
  }

  private plan(source: SyncProfile): SyncPlan {
    const target = this.export();
    const items = [...settingItems(source, target, this.lacks), ...roleItems(source, target), ...mcpItems(source, target), ...signInItems(source, target)];
    const notes: string[] = [];
    if (source.ompVersion !== target.ompVersion) notes.push(`The source runs omp ${source.ompVersion}; this host runs omp ${target.ompVersion}.`);
    if (items.some((i) => (i.section === "settings" || i.section === "roles") && i.change !== "same")) {
      notes.push("omp sessions already running here keep their settings and model roles until they restart.");
    }
    if (source.signInsNote) notes.push(`Sign-ins: ${source.signInsNote}`);
    if (source.mcpNote) notes.push(`MCP servers: ${source.mcpNote}`);
    return { sourceOmp: source.ompVersion, targetOmp: target.ompVersion, items, notes };
  }

  private keyBegin(): SyncKey {
    this.seq += 1;
    const transferId = `demo-transfer-${this.env.id}-${this.seq}`;
    const expiresAt = this.env.clock.now() + DEMO_SYNC_KEY_TTL_MS;
    this.keys.set(transferId, expiresAt);
    return { transferId, publicKey: base64Utf8(`demo one-time key #${this.seq}`.padEnd(32, ".")), suite: DEMO_SYNC_SUITE, expiresAt };
  }

  /** Whether this host has the secret a (target's) secret item asks for. */
  private canSeal(id: string): boolean {
    const [kind, ...rest] = id.split(":");
    const name = rest.join(":");
    if (kind === "setting") return this.profile.settings.some((s) => s.key === name && s.secret);
    if (kind === "mcpSecrets") {
      const m = this.profile.mcp.find((x) => x.name === name);
      return !!m && maskedKeys(m.server).env.length + maskedKeys(m.server).headers.length > 0;
    }
    if (kind === "signIn") return this.profile.signIns.some((s) => s.id === name);
    return false;
  }

  private seal(p: Record<string, unknown>): SyncSealed {
    const transferId = str(p, "transferId");
    const publicKey = str(p, "publicKey");
    const items = strings(p, "items");
    if (!items.length) throw apiError("invalid_params", "items: nothing to seal");
    const missing = items.find((id) => !this.canSeal(id));
    if (missing) throw apiError("invalid_params", `${missing}: this host has no secret for it`, { hint: "Compare the hosts again" });
    this.seq += 1;
    return {
      suite: DEMO_SYNC_SUITE,
      transferId,
      senderKey: base64Utf8(`demo sender key #${this.seq}`.padEnd(32, ".")),
      nonce: base64Utf8("demo-nonce12"),
      ciphertext: base64Utf8(`demo sealed box for ${publicKey.slice(0, 12)}: ${items.join(", ")}`),
      items: [...items],
    };
  }

  /** Spends the one-time key `sealed` was made for; throws unless it opens exactly `secrets`. */
  private open(sealed: SyncSealed, secrets: readonly string[]): void {
    const expiresAt = this.keys.get(sealed.transferId);
    this.keys.delete(sealed.transferId);
    if (expiresAt === undefined || expiresAt < this.env.clock.now()) {
      throw apiError("expired", "The one-time key for this copy expired or was already used", { hint: "Start the copy again" });
    }
    if (sealed.suite !== DEMO_SYNC_SUITE || !Array.isArray(sealed.items) || !sameSet(sealed.items, secrets)) {
      throw apiError("sealed_invalid", "The sealed secrets don't match the chosen items", { hint: "Start the copy again" });
    }
  }

  private apply(p: Record<string, unknown>): SyncApplied {
    const source = profileParam(p.source);
    const ids = strings(p, "items");
    if (!ids.length) throw apiError("invalid_params", "items: nothing to apply");
    // The plan again first, so nothing stale is applied.
    const plan = this.plan(source);
    const requested = new Set(ids);
    const secrets = plan.items.filter((i) => requested.has(i.id) && i.secret && i.change !== "same" && i.change !== "unsupported").map((i) => i.id);
    if (p.sealed !== undefined && p.sealed !== null) this.open(obj(p.sealed, "sealed") as unknown as SyncSealed, secrets);
    else if (secrets.length) throw apiError("invalid_params", `${secrets[0]} is a secret: it travels sealed`, { hint: "Seal it on the source first (hostSync.seal)" });

    const results: SyncItemResult[] = [];
    let mcpChanged = false;
    for (const item of plan.items) {
      if (!requested.has(item.id)) continue;
      const r = this.applyItem(item, source, requested);
      results.push(r);
      if (r.ok && item.section === "mcp" && item.change !== "same") mcpChanged = true;
    }
    const known = new Set(plan.items.map((i) => i.id));
    for (const id of ids) if (!known.has(id)) results.push({ id, ok: false, error: "No longer in the plan: compare the hosts again." });
    return { results, plan: this.plan(source), ...(mcpChanged ? { mcpReload: this.reload() } : {}) };
  }

  private applyItem(item: SyncItem, source: SyncProfile, requested: ReadonlySet<string>): SyncItemResult {
    const { id } = item;
    if (item.change === "same") return { id, ok: true, note: "Already the same." };
    if (item.change === "unsupported") return { id, ok: false, error: item.notes[0] ?? "Not possible on this host" };
    const [kind, ...rest] = id.split(":");
    const name = rest.join(":");
    switch (kind) {
      case "setting":
        return this.applySetting(id, name, item, source);
      case "role":
        return this.applyRole(id, name, source);
      case "mcp":
        return this.applyMcp(id, name, source, requested.has(`mcpSecrets:${name}`));
      case "mcpSecrets":
        return this.applyMcpSecrets(id, name, source);
      case "signIn":
        return this.applySignIn(id, name, source);
      default:
        return { id, ok: false, error: `unknown item ${id}` };
    }
  }

  private applySetting(id: string, key: string, item: SyncItem, source: SyncProfile): SyncItemResult {
    const settings = this.profile.settings;
    const at = settings.findIndex((s) => s.key === key);
    if (item.change === "remove") {
      if (at >= 0) settings.splice(at, 1);
      return { id, ok: true };
    }
    const src = source.settings.find((s) => s.key === key);
    if (!src) return { id, ok: false, error: `the source has no ${key}` };
    // A credential arrives in the sealed box; the demo keeps only that it is set.
    const next: SyncSetting = src.secret ? setting(key) : structuredClone(src);
    if (at >= 0) settings[at] = next;
    else settings.push(next);
    return { id, ok: true };
  }

  private writeRecord(key: string, record: Record<string, unknown>): void {
    const settings = this.profile.settings;
    const at = settings.findIndex((s) => s.key === key);
    if (Object.keys(record).length === 0) {
      if (at >= 0) settings.splice(at, 1);
    } else if (at >= 0) settings[at] = { ...(settings[at] as SyncSetting), value: record };
    else settings.push(setting(key, record));
  }

  private applyRole(id: string, role: string, source: SyncProfile): SyncItemResult {
    const value = rolesOf(source).get(role);
    const models = { ...recordOf(this.profile, "modelRoles") };
    const chains = { ...recordOf(this.profile, "retry.fallbackChains") };
    delete models[role];
    delete chains[role];
    if (value?.model) models[role] = value.model;
    if (value?.fallbacks?.length) chains[role] = [...value.fallbacks];
    this.writeRecord("modelRoles", models);
    this.writeRecord("retry.fallbackChains", chains);
    const provider = value?.model?.split("/")[0];
    if (provider && !this.profile.signIns.some((s) => s.provider === provider)) {
      return { id, ok: true, note: `${value?.model} isn't usable here yet: no ${provider} sign-in` };
    }
    return { id, ok: true };
  }

  private applyMcp(id: string, name: string, source: SyncProfile, withSecrets: boolean): SyncItemResult {
    const servers = this.profile.mcp;
    const at = servers.findIndex((m) => m.name === name);
    const src = source.mcp.find((m) => m.name === name);
    if (!src) {
      if (at >= 0) servers.splice(at, 1);
      return { id, ok: true };
    }
    const own = at >= 0 ? (servers[at] as SyncMcpServer).server : undefined;
    const empty: string[] = [];
    // Masked values: this host's own when it has one, the sealed one when its secrets come too, else empty.
    const fill = (kv: McpKeyValue): McpKeyValue => {
      if (kv.value !== MASK) return { ...kv };
      if (hasValue(own, kv.key) || withSecrets) return { ...kv };
      empty.push(kv.key);
      return { ...kv, value: "" };
    };
    const def: McpServerDraft = { ...structuredClone(src.server), env: src.server.env.map(fill), headers: src.server.headers.map(fill) };
    const next: SyncMcpServer = { name, server: def, enabled: src.enabled, secrets: false, signedIn: false, extra: [] };
    if (at >= 0) servers[at] = next;
    else servers.push(next);
    return empty.length ? { id, ok: true, note: `${listed(empty)} ${empty.length === 1 ? "is" : "are"} empty here: copy its secrets to fill ${empty.length === 1 ? "it" : "them"}` } : { id, ok: true };
  }

  private applyMcpSecrets(id: string, name: string, source: SyncProfile): SyncItemResult {
    const mine = this.profile.mcp.find((m) => m.name === name);
    if (!mine) return { id, ok: false, error: `This host has no MCP server named ${name}: copy the server too` };
    const src = source.mcp.find((m) => m.name === name);
    if (!src) return { id, ok: false, error: `the source has no MCP server named ${name}` };
    const masked = maskedKeys(src.server);
    const set = (list: McpKeyValue[], keys: string[]) => {
      for (const key of keys) {
        const kv = list.find((x) => x.key === key);
        if (kv) {
          kv.value = MASK;
          kv.secret = true;
        } else list.push(secretKv(key));
      }
    };
    set(mine.server.env, masked.env);
    set(mine.server.headers, masked.headers);
    return { id, ok: true };
  }

  private applySignIn(id: string, signInId: string, source: SyncProfile): SyncItemResult {
    const src = source.signIns.find((s) => s.id === signInId);
    if (!src) return { id, ok: false, error: "the source no longer has this sign-in" };
    const list = this.profile.signIns;
    const at = list.findIndex((s) => s.id === signInId);
    if (at >= 0) list[at] = { ...src };
    else list.push({ ...src });
    return { id, ok: true, ...(src.kind === "oauth" && !src.mcpUrl ? { note: "Signed in here with the same account" } : {}) };
  }

  /** What `/mcp reload` did to this host's omp sessions. */
  private reload(): McpReload {
    const r: McpReload = { reloaded: 0, queued: 0, restartNeeded: 0, errors: [] };
    for (const a of this.env.agents?.() ?? []) {
      if (a.kind !== "omp" || a.parked || !a.omp) continue;
      if (a.omp.link !== "live") r.restartNeeded += 1;
      else if (a.state === "working") r.queued += 1;
      else r.reloaded += 1;
    }
    return r;
  }
}

const hosts = new WeakMap<object, DemoHostSync>();

/** The `hostSync.*` side of a demo host (`owner`), made on first use. */
export function demoHostSync(owner: object, env: () => DemoHostSyncEnv): DemoHostSync {
  let h = hosts.get(owner);
  if (!h) {
    h = new DemoHostSync(env());
    hosts.set(owner, h);
  }
  return h;
}
