/**
 * Demo `omp.settings` / `omp.settingsSet`: a trimmed real omp schema (ompSettingsFixture.ts) with
 * in-memory values, validated the way `omp config set` does (unknown keys, types, enum values,
 * item vocabularies) and with credentials kept write-only.
 */
import type { OmpSetting, OmpSettingChange, OmpSettings, OmpSettingValues, RoleBinding } from "../gen";
import { apiError } from "../errors";
import { HOME, ROLES } from "./data";
import { OMP_SETTINGS_FIXTURE, OMP_VERSION } from "./ompSettingsFixture";

/** A few non-default values so the page shows modified settings. */
const DEMO_VALUES: Record<string, unknown> = {
  "theme.dark": "anthracite",
  "compaction.enabled": true,
  "statusLine.leftSegments": ["model", "mode", "path", "git", "pr", "context_pct"],
  "loop.conditionTimeoutMs": 120000,
  // Codex plan rate-limited → the same models on the API key; the default role's own chain.
  "retry.fallbackChains": { "openai-codex/*": ["openai/*"], default: ["anthropic/claude-sonnet-5:high", "openai/gpt-5.5:xhigh"] },
};

function invalid(key: string, message: string): never {
  throw apiError("invalid_params", `${key}: ${message}`);
}

function itemValues(s: OmpSetting): string[] | undefined {
  const items = s.items;
  if (items && typeof items === "object" && "values" in items && Array.isArray(items.values)) return items.values.filter((v): v is string => typeof v === "string");
  return s.options?.length && s.type === "array" ? s.options.map((o) => o.value) : undefined;
}

/** Checks a value like omp's `Setting.parse` + `accepts`; returns it normalized. */
function checked(s: OmpSetting, v: unknown): unknown {
  switch (s.type) {
    case "boolean":
      return typeof v === "boolean" ? v : invalid(s.id, `Invalid boolean value: ${String(v)}. Use true/false, yes/no, on/off, or 1/0`);
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? v : invalid(s.id, `Invalid number: ${String(v)}`);
    case "string":
      return typeof v === "string" ? v : invalid(s.id, `expects a string`);
    case "enum":
      if (typeof v !== "string" || !s.values?.includes(v)) invalid(s.id, `Invalid value: ${String(v)}. Valid values: ${(s.values ?? []).join(", ")}`);
      return v;
    case "array": {
      if (!Array.isArray(v)) invalid(s.id, `Invalid array JSON: ${JSON.stringify(v)}`);
      const vocab = itemValues(s);
      const bad = vocab ? v.find((x) => typeof x !== "string" || !vocab.includes(x)) : undefined;
      if (bad !== undefined) invalid(s.id, `Unknown entry: ${JSON.stringify(bad)}. Valid entries: ${vocab?.join(", ")}`);
      return v;
    }
    case "record":
      if (typeof v !== "object" || v === null || Array.isArray(v)) invalid(s.id, `Invalid record JSON: ${JSON.stringify(v)}`);
      return v;
    default:
      return v;
  }
}

export class DemoOmpSettings {
  private settings: OmpSetting[];

  constructor() {
    const roles = Object.fromEntries(ROLES.map((r) => [r.role, r.model]));
    this.settings = OMP_SETTINGS_FIXTURE.map((s) => {
      if (s.id === "modelRoles") return { ...s, value: roles };
      if (s.id === "searxng.token") return { ...s, redacted: true };
      return Object.hasOwn(DEMO_VALUES, s.id) ? { ...s, value: DEMO_VALUES[s.id] } : { ...s };
    });
  }

  get(): OmpSettings {
    return { version: OMP_VERSION, source: "schema", settings: this.settings.map((s) => ({ ...s })), configPath: `${HOME}/.omp/agent/config.yml` };
  }

  /**
   * Keys are checked before anything is written; then in order, stopping at the first invalid
   * value (earlier ones stay applied), like tf-hostd.
   */
  set(raw: unknown): OmpSettings {
    const changes = Array.isArray(raw)
      ? raw.map((c): OmpSettingChange => {
          if (!c || typeof c !== "object" || !("key" in c) || typeof c.key !== "string") throw apiError("invalid_params", "each change needs a key");
          return { key: c.key, value: "value" in c ? c.value : undefined };
        })
      : [];
    for (const c of changes) {
      if (!this.settings.some((s) => s.id === c.key)) throw apiError("invalid_params", `unknown omp setting \`${c.key}\``);
    }
    for (const c of changes) {
      const i = this.settings.findIndex((s) => s.id === c.key);
      const s = this.settings[i];
      if (!s) continue;
      const reset = c.value === undefined || c.value === null;
      if (s.credential) this.settings[i] = { ...s, redacted: !reset };
      else this.settings[i] = { ...s, value: reset ? s.default : checked(s, c.value) };
    }
    return this.get();
  }

  /** `omp.settingValues`: current values of known, non-credential keys that have one (like tf-hostd). */
  values(raw: unknown): OmpSettingValues {
    const keys = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
    if (keys.length > 64) throw apiError("invalid_params", "at most 64 keys");
    const values: Record<string, unknown> = {};
    for (const key of keys) {
      const s = this.settings.find((x) => x.id === key);
      if (s && !s.credential && !s.redacted && s.value !== undefined) values[key] = s.value;
    }
    return { values };
  }

  /** `host.models` role bindings from the current `modelRoles`. */
  roles(): RoleBinding[] {
    const v = this.settings.find((s) => s.id === "modelRoles")?.value;
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    return Object.entries(v).flatMap(([role, model]) => (typeof model === "string" ? [{ role, model }] : []));
  }

  /** The current `retry.fallbackChains` (string entries only), like `agent.getRoleModels`' `hostChains`. */
  chains(): Record<string, string[]> {
    const v = this.settings.find((s) => s.id === "retry.fallbackChains")?.value;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(v)) if (Array.isArray(list)) out[key] = list.filter((e): e is string => typeof e === "string");
    return out;
  }
}
