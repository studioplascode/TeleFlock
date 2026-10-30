import { describe, expect, test } from "bun:test";
import {
  type ChainRow,
  chainKeyKind,
  chainRecord,
  chainRows,
  cleanChains,
  cleanRoles,
  formatChainEntry,
  isWildcard,
  joinChainKey,
  launchOverrides,
  hostTakesRoles,
  nextChainId,
  launchMainText,
  overridesSummary,
  parseChainEntry,
  selectorLabel,
  splitChainKey,
  validateChains,
  validateOverrides,
  validateRoles,
} from "./roles";

const row = (id: number, kind: ChainRow["kind"], value: string, entries: string[] = []): ChainRow => ({ id, kind, value, entries });

describe("role maps", () => {
  test("clean: strings only, trimmed, empties dropped, order kept", () => {
    expect(cleanRoles({ smol: " openai/gpt-5-mini:low ", junk: 3, empty: "  ", designer: "google/gemini-3-pro" })).toEqual({ smol: "openai/gpt-5-mini:low", designer: "google/gemini-3-pro" });
    expect(Object.keys(cleanRoles({ b: "x/y", a: "x/z" }))).toEqual(["b", "a"]);
    expect(cleanRoles(null)).toEqual({});
    expect(cleanRoles(["a/b"])).toEqual({});
    expect(cleanChains({ default: ["a/b", 3, " ", " c/d "], "openai/*": [], bad: "a/b" })).toEqual({ default: ["a/b", "c/d"], "openai/*": [] });
  });

  test("launch spec: each map only when it holds something", () => {
    expect(launchOverrides({}, {})).toEqual({});
    expect(launchOverrides(undefined, undefined)).toEqual({});
    expect(launchOverrides({ smol: "a/b" }, {})).toEqual({ roleModels: { smol: "a/b" } });
    expect(launchOverrides({}, { default: [] })).toEqual({ fallbackChains: { default: [] } });
  });

  test("a tf-hostd from before 0.7 would ignore them: the spec carries none for it", () => {
    expect(hostTakesRoles({ hostdVersion: "0.6.3" })).toBe(false);
    expect(hostTakesRoles({ hostdVersion: "0.7.0" })).toBe(true);
    expect(hostTakesRoles({ hostdVersion: "1.0.0" })).toBe(true);
    expect(hostTakesRoles(undefined)).toBe(true);
    expect(launchOverrides({ smol: "a/b" }, { default: ["c/d"] }, hostTakesRoles({ hostdVersion: "0.6.3" }))).toEqual({});
  });

  test("summary text", () => {
    expect(overridesSummary({}, {})).toBeNull();
    expect(overridesSummary(undefined, undefined)).toBeNull();
    expect(overridesSummary({ smol: "a/b" }, {})).toBe("1 role");
    expect(overridesSummary({ smol: "a/b", slow: "a/c", task: "a/d" }, { default: ["x/y"] })).toBe("3 roles · 1 fallback chain");
    expect(overridesSummary({}, { default: [], "openai/*": ["x/*"] })).toBe("2 fallback chains");
  });

  test("labels: the catalog's name and the level; a launch form's main model", () => {
    const models = [{ provider: "anthropic", id: "claude-opus-5", label: "opus-5", thinking: [] }];
    expect(selectorLabel(models, "anthropic/claude-opus-5:high")).toBe("opus-5 · high");
    expect(selectorLabel(models, "ollama/llama3:8b")).toBe("ollama/llama3:8b");
    expect(launchMainText(models, "anthropic/claude-opus-5", "low", undefined)).toBe("opus-5 · low");
    expect(launchMainText(models, "default", "default", "anthropic/claude-opus-5:high")).toBe("host default (opus-5) · high");
    expect(launchMainText(models, "default", "low", "anthropic/claude-opus-5:high")).toBe("host default (opus-5) · low");
    expect(launchMainText(models, "default", "default", undefined)).toBe("host default");
  });
});

describe("entries", () => {
  test("thinking suffix", () => {
    expect(parseChainEntry("a/b:high")).toEqual({ model: "a/b", thinking: "high", wildcard: false });
    expect(parseChainEntry("ollama/llama3:8b")).toEqual({ model: "ollama/llama3:8b", wildcard: false });
    expect(parseChainEntry("ollama/llama3:8b:low")).toEqual({ model: "ollama/llama3:8b", thinking: "low", wildcard: false });
    expect(parseChainEntry("openai/gpt-5.5")).toEqual({ model: "openai/gpt-5.5", wildcard: false });
    expect(formatChainEntry("a/b", "high")).toBe("a/b:high");
    expect(formatChainEntry("a/b")).toBe("a/b");
  });

  test("wildcard entries never get a suffix", () => {
    expect(parseChainEntry("google/*")).toEqual({ model: "google/*", wildcard: true });
    expect(parseChainEntry("google/*:high")).toEqual({ model: "google/*", wildcard: true });
    expect(parseChainEntry("openrouter/google/*")).toEqual({ model: "openrouter/google/*", wildcard: true });
    expect(formatChainEntry("google/*", "high")).toBe("google/*");
    expect(formatChainEntry("openrouter/google/*", "max")).toBe("openrouter/google/*");
    expect(isWildcard("openai/*")).toBe(true);
    expect(isWildcard("/*")).toBe(false);
    expect(isWildcard("a//*")).toBe(false);
    expect(isWildcard("openai/gpt-5")).toBe(false);
  });
});

describe("chain keys", () => {
  test("kind classification", () => {
    expect(chainKeyKind("default")).toBe("role");
    expect(chainKeyKind("designer")).toBe("role");
    expect(chainKeyKind("anthropic/claude-opus-5")).toBe("model");
    expect(chainKeyKind("anthropic/claude-opus-5:high")).toBe("model");
    expect(chainKeyKind("google-antigravity/*")).toBe("provider");
    expect(chainKeyKind("openrouter/google/*")).toBe("prefix");
  });

  test("split and join", () => {
    expect(splitChainKey("default")).toEqual({ kind: "role", value: "default" });
    expect(splitChainKey("openai/gpt-5.5")).toEqual({ kind: "model", value: "openai/gpt-5.5" });
    expect(splitChainKey("openai/*")).toEqual({ kind: "provider", value: "openai" });
    expect(splitChainKey("openrouter/google/*")).toEqual({ kind: "prefix", value: "openrouter/google" });
    expect(joinChainKey("provider", " openai ")).toBe("openai/*");
    expect(joinChainKey("prefix", "openrouter/google")).toBe("openrouter/google/*");
    expect(joinChainKey("role", "smol")).toBe("smol");
    expect(joinChainKey("provider", "")).toBe("");
    for (const key of ["default", "openai/gpt-5.5:high", "openai/*", "openrouter/google/*"]) {
      const { kind, value } = splitChainKey(key);
      expect(joinChainKey(kind, value)).toBe(key);
    }
  });
});

describe("chain rows", () => {
  test("record → rows → record keeps the record's order", () => {
    const record = { "openrouter/google/*": ["google/*"], default: ["openai/gpt-5.5:high", "anthropic/*"], "openai-codex/*": ["openai/*"], "x/y": [] };
    const rows = chainRows(record);
    expect(rows.map((r) => [r.kind, r.value])).toEqual([
      ["prefix", "openrouter/google"],
      ["role", "default"],
      ["provider", "openai-codex"],
      ["model", "x/y"],
    ]);
    expect(chainRecord(rows)).toEqual(record);
    expect(Object.keys(chainRecord(rows))).toEqual(Object.keys(record));
    expect(nextChainId(rows)).toBe(5);
    expect(nextChainId([])).toBe(1);
  });

  test("incomplete keys and repeats stay out of the record (the first of a key wins)", () => {
    const rows = [row(1, "role", "smol", ["a/b"]), row(2, "provider", ""), row(3, "role", "smol", ["c/d"]), row(4, "prefix", "openrouter/"), row(5, "provider", "openai", [])];
    expect(chainRecord(rows)).toEqual({ smol: ["a/b"], "openai/*": [] });
  });
});

describe("validation", () => {
  test("roles", () => {
    expect(validateRoles({ smol: "openai/gpt-5-mini:low", designer: "a/b,c/d:high" }).ok).toBe(true);
    const bad = validateRoles({ "9lives": "a/b", smol: "no-provider", slow: "a/b c", tiny: "/x", task: "x/" });
    expect(bad.ok).toBe(false);
    expect(Object.keys(bad.errors).sort()).toEqual(["9lives", "slow", "smol", "task", "tiny"]);
    expect(bad.errors.slow).toMatch(/spaces/);
    expect(bad.errors.smol).toMatch(/provider\/model/);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`r${i}`, "a/b"]));
    expect(validateRoles(many).general).toEqual(["At most 64 roles"]);
    expect(validateRoles({ r: `a/${"x".repeat(300)}` }).errors.r).toMatch(/256/);
  });

  test("chains: keys per kind, repeats, entries, limits; an empty chain is fine", () => {
    expect(validateChains([row(1, "role", "default", []), row(2, "provider", "openai", ["openrouter/*", "a/b:low"])]).ok).toBe(true);
    const c = validateChains([
      row(1, "role", ""),
      row(2, "role", "bad role"),
      row(3, "model", "openai/*"),
      row(4, "provider", "open ai"),
      row(5, "prefix", "openrouter"),
      row(6, "role", "default", ["a b/c", "x/y"]),
      row(7, "role", "default"),
      row(8, "provider", "google", Array.from({ length: 17 }, () => "a/b")),
    ]);
    expect(c.ok).toBe(false);
    const keys = c.rows.map((r) => r.key);
    expect(keys[0]).toBe("Pick a role");
    expect(keys[1]).toMatch(/Letters/);
    expect(keys[2]).toMatch(/Wildcards/);
    expect(keys[3]).toMatch(/provider/);
    expect(keys[4]).toMatch(/provider\/prefix/);
    expect(keys[5]).toBeUndefined();
    expect(keys[6]).toBe("Another chain already uses this key");
    expect(keys[7]).toBeUndefined();
    expect(c.rows[5]?.entries[0]).toMatch(/spaces/);
    expect(c.rows[5]?.entries[1]).toBeUndefined();
    expect(c.rows[7]?.chain).toBe("At most 16 fallbacks per chain");
    const many = Array.from({ length: 65 }, (_, i) => row(i + 1, "provider", `p${i}`));
    expect(validateChains(many).general).toEqual(["At most 64 fallback chains"]);
  });

  test("both maps as the host gets them", () => {
    expect(validateOverrides({ smol: "a/b" }, { "openai/*": ["openrouter/*"], default: [] }).ok).toBe(true);
    const v = validateOverrides({ smol: "a b" }, { default: ["nope"] });
    expect(v.ok).toBe(false);
    expect(v.roles.errors.smol).toBeDefined();
    expect(v.chains.rows[0]?.entries[0]).toBeDefined();
  });
});
