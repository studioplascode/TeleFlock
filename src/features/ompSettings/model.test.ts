import { describe, expect, test } from "bun:test";
import { DemoOmpSettings } from "@/core/demo/ompSettings";
import { OMP_SETTINGS_FIXTURE } from "@/core/demo/ompSettingsFixture";
import type { OmpSetting } from "@/core/gen";
import {
  applyLocal,
  buildTabs,
  conditionInfo,
  editorFor,
  isModified,
  matchesQuery,
  MODEL_ROLES_KEY,
  OMP_TABS,
  OTHER_TAB,
  parseJson,
  parseNumber,
  parseRoleSelector,
  formatRoleSelector,
  roleRecord,
  roleRows,
  withRole,
} from "./model";

const byId = (id: string): OmpSetting => {
  const s = OMP_SETTINGS_FIXTURE.find((x) => x.id === id);
  if (!s) throw new Error(`${id} not in fixture`);
  return s;
};

describe("tabs", () => {
  const tabs = buildTabs(OMP_SETTINGS_FIXTURE);

  test("omp's tab order, Other last, every setting exactly once", () => {
    expect(tabs.map((t) => t.id)).toEqual(["appearance", "model", "interaction", "context", "memory", "files", "shell", "tools", "tasks", "providers", OTHER_TAB]);
    const listed = tabs.flatMap((t) => t.sections.flatMap((s) => s.settings.map((x) => x.id)));
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed, MODEL_ROLES_KEY].sort()).toEqual(OMP_SETTINGS_FIXTURE.map((s) => s.id).sort());
  });

  test("groups follow omp's TAB_GROUPS, ungrouped first; Other groups by key prefix", () => {
    const model = tabs.find((t) => t.id === "model");
    for (const tab of tabs.filter((t) => t.id !== OTHER_TAB)) {
      const order = OMP_TABS.find((t) => t.id === tab.id)?.groups ?? [];
      const idx = tab.sections.map((s) => (s.title === undefined ? -1 : order.indexOf(s.title)));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
    expect(tabs.find((t) => t.id === "appearance")?.sections.map((s) => s.title).slice(0, 2)).toEqual(["Theme", "Composer"]);
    // The roles editor counts on Model.
    expect(model?.count).toBe(model ? model.sections.reduce((n, s) => n + s.settings.length, 0) + 1 : 0);
    const other = tabs.find((t) => t.id === OTHER_TAB);
    expect(other?.sections[0]?.title).toBe("General");
    expect(other?.sections.find((s) => s.title === "thinkingBudgets")?.settings.map((s) => s.id)).toEqual(["thinkingBudgets.low", "thinkingBudgets.high"]);
    expect(other?.sections.flatMap((s) => s.settings).some((s) => s.id === MODEL_ROLES_KEY)).toBe(false);
  });

  test("unknown tabs and groups from a newer omp still show", () => {
    const extra: OmpSetting = { ...byId("theme.dark"), id: "x.y", tab: "future", group: "Brand New" };
    const t = buildTabs([...OMP_SETTINGS_FIXTURE, extra]);
    expect(t.at(-2)?.label).toBe("Future");
    expect(t.at(-2)?.sections[0]?.title).toBe("Brand New");
  });
});

describe("editors", () => {
  test("per type", () => {
    expect(editorFor(byId(MODEL_ROLES_KEY))).toBe("roles");
    expect(editorFor(byId("auth.broker.token"))).toBe("secret");
    expect(editorFor(byId("compaction.enabled"))).toBe("switch");
    expect(editorFor(byId("providers.tinyModelDevice"))).toBe("choice");
    expect(editorFor(byId("loop.conditionTimeoutMs"))).toBe("number");
    expect(editorFor(byId("theme.dark"))).toBe("text");
    expect(editorFor(byId("compaction.methodOrder"))).toBe("members");
    expect(editorFor(byId("statusLine.leftSegments"))).toBe("members");
    expect(editorFor(byId("contextFiles.extra"))).toBe("json");
    expect(editorFor(byId("workspace.additionalDirectories"))).toBe("list");
    expect(editorFor(byId("retry.fallbackChains"))).toBe("json");
    expect(editorFor({ ...byId("workspace.additionalDirectories"), value: [{ path: "/x" }] })).toBe("json");
  });

  test("numbers and JSON validate like omp", () => {
    expect(parseNumber(" -5 ")).toEqual({ ok: true, value: -5 });
    expect(parseNumber("0.25")).toEqual({ ok: true, value: 0.25 });
    expect(parseNumber("").ok).toBe(false);
    expect(parseNumber("12px").ok).toBe(false);
    expect(parseNumber("Infinity").ok).toBe(false);
    expect(parseJson('{"a":1}', "record")).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJson("[1]", "record").ok).toBe(false);
    expect(parseJson("null", "record").ok).toBe(false);
    expect(parseJson('["a"]', "array")).toEqual({ ok: true, value: ["a"] });
    expect(parseJson("{}", "array").ok).toBe(false);
    expect(parseJson("{nope", "record").ok).toBe(false);
  });

  test("modified, search, conditions", () => {
    const dark = byId("theme.dark");
    expect(isModified(dark)).toBe(false);
    expect(isModified({ ...dark, value: "x" })).toBe(true);
    expect(isModified({ ...byId("statusLine.leftSegments"), value: [...(byId("statusLine.leftSegments").default as string[])] })).toBe(false);
    expect(isModified({ ...byId("auth.broker.token"), redacted: true })).toBe(true);
    expect(matchesQuery(dark, "dark THEME")).toBe(true);
    expect(matchesQuery(dark, "theme.dark")).toBe(true);
    expect(matchesQuery(dark, "dark nope")).toBe(false);
    expect(matchesQuery(byId(MODEL_ROLES_KEY), "role")).toBe(true);
    const get = (id: string) => (id === "tui.vimMode" ? true : undefined);
    expect(conditionInfo("vimModeEnabled", get, "linux")).toEqual({ hint: "Applies in Vim mode", holds: true });
    expect(conditionInfo("macOS", get, "linux").holds).toBe(false);
    expect(conditionInfo("macOS", get, "macos").holds).toBe(true);
    expect(conditionInfo("hasImageProtocol", get, "linux").holds).toBeUndefined();
    expect(conditionInfo("someNewThing", get, "linux").hint).toContain("some new thing");
  });

  test("local apply: reset goes back to the default, credentials only flip redacted", () => {
    const data = { version: "1", source: "schema", settings: [{ ...byId("theme.dark"), value: "x" }, byId("auth.broker.token")] };
    const next = applyLocal(data, [{ key: "theme.dark", value: null }, { key: "auth.broker.token", value: "s" }]);
    expect(next.settings[0]?.value).toBe(byId("theme.dark").default);
    expect(next.settings[1]?.redacted).toBe(true);
    expect(next.settings[1]?.value).toBeUndefined();
  });
});

describe("model roles", () => {
  test("selectors", () => {
    expect(parseRoleSelector("anthropic/claude-opus-5-5:max")).toEqual({ model: "anthropic/claude-opus-5-5", thinking: "max" });
    expect(parseRoleSelector("ollama/llama3:8b")).toEqual({ model: "ollama/llama3:8b" });
    expect(parseRoleSelector("openai/gpt-5")).toEqual({ model: "openai/gpt-5" });
    expect(formatRoleSelector("openai/gpt-5", "high")).toBe("openai/gpt-5:high");
    expect(formatRoleSelector("openai/gpt-5")).toBe("openai/gpt-5");
  });

  test("rows: built-ins in omp's order, then custom roles", () => {
    const record = roleRecord({ designer: "openai/gpt-5", default: "a/b:high", junk: 3 });
    expect(record).toEqual({ designer: "openai/gpt-5", default: "a/b:high" });
    const rows = roleRows(record, ["zeta"]);
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(["default", "smol", "slow"]);
    expect(rows.filter((r) => !r.builtin).map((r) => r.id)).toEqual(["designer", "zeta"]);
    expect(rows.find((r) => r.id === "web")?.kind).toBe(true);
    expect(withRole(record, "designer", undefined)).toEqual({ default: "a/b:high" });
    expect(withRole(record, "tiny", "x/y")).toEqual({ ...record, tiny: "x/y" });
  });
});

describe("demo host", () => {
  test("validates and round-trips like omp config set", () => {
    const demo = new DemoOmpSettings();
    const get = (id: string) => demo.get().settings.find((s) => s.id === id);
    expect(get("theme.dark")?.value).toBe("anthracite");
    demo.set([{ key: "theme.dark" }]);
    expect(get("theme.dark")?.value).toBe(get("theme.dark")?.default);
    expect(() => demo.set([{ key: "providers.tinyModelDevice", value: "bogus" }])).toThrow(/Valid values/);
    expect(() => demo.set([{ key: "statusLine.leftSegments", value: ["model", "bogus"] }])).toThrow(/Unknown entry/);
    expect(() => demo.set([{ key: "compaction.enabled", value: false }, { key: "nope", value: 1 }])).toThrow(/unknown omp setting/);
    expect(get("compaction.enabled")?.value).toBe(true);
    demo.set([{ key: MODEL_ROLES_KEY, value: { default: "openai/gpt-5.5:high", designer: "google/gemini-3-pro" } }]);
    expect(demo.roles()).toEqual([
      { role: "default", model: "openai/gpt-5.5:high" },
      { role: "designer", model: "google/gemini-3-pro" },
    ]);
    demo.set([{ key: "auth.broker.token", value: "secret" }]);
    expect(get("auth.broker.token")).toMatchObject({ redacted: true });
    expect(get("auth.broker.token")?.value).toBeUndefined();
  });
});
