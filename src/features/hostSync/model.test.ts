import { describe, expect, test } from "bun:test";
import { apiError } from "@/core/errors";
import { ManualClock } from "@/core/demo/clock";
import { DemoHostSync } from "@/core/demo/hostSync";
import type { McpServerDraft, SyncApplied, SyncChange, SyncItem, SyncKey, SyncPlan, SyncProfile, SyncSealed, SyncSection } from "@/core/gen";
import {
  appliedSummary,
  applyCopy,
  carrySelection,
  changeLabel,
  chosenIds,
  compareHosts,
  countsLine,
  defaultSelection,
  describeFailure,
  formatValue,
  groupPlan,
  mergeResults,
  missingNeeds,
  planCounts,
  preview,
  reloadSummary,
  secretIds,
  sectionState,
  selectable,
  stepText,
  type SyncCall,
  SyncStepError,
  withIds,
} from "./model";

const MASK = "••••••••";

function item(id: string, section: SyncSection, change: SyncChange, more: Partial<SyncItem> = {}): SyncItem {
  return { id, section, change, label: id.slice(id.indexOf(":") + 1), from: undefined, to: undefined, secret: false, suggested: false, notes: [], ...more };
}

const BRAVE: McpServerDraft = { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: [{ key: "BRAVE_API_KEY", value: MASK, secret: true }], headers: [] };

/** studio-pc → forge, out of section order on purpose. */
const PLAN: SyncPlan = {
  sourceOmp: "18.12.3",
  targetOmp: "18.12.6",
  notes: ["The source runs omp 18.12.3; this host runs omp 18.12.6."],
  items: [
    item("signIn:anthropic|0123456789ab", "signIns", "unknown", { secret: true, place: "anthropic" }),
    item("setting:theme.dark", "settings", "same", { from: "anthracite", to: "anthracite" }),
    item("setting:symbolPreset", "settings", "add", { suggested: true, from: "nerd" }),
    item("setting:steeringMode", "settings", "remove", { to: "all" }),
    item("setting:speech.dictation", "settings", "unsupported", { from: true, notes: ["omp 18.12.6 on this host has no `speech.dictation` setting"] }),
    item("setting:searxng.token", "settings", "add", { secret: true }),
    item("role:default", "roles", "change", { suggested: true, from: { model: "anthropic/claude-opus-5:xhigh" }, to: { model: "anthropic/claude-opus-5:high" } }),
    item("mcp:brave-search", "mcp", "add", { suggested: true, needs: "mcpSecrets:brave-search", from: { server: BRAVE, enabled: true } }),
    item("mcpSecrets:brave-search", "mcp", "add", { secret: true }),
    item("mcp:context7", "mcp", "same"),
  ],
};

const PROFILE: SyncProfile = { ompVersion: "18.12.3", settings: [], mcp: [], signIns: [] };

/** A fake `call` that records every call and answers from `answers` (a value, or an error to throw). */
function recorder(answers: Partial<Record<string, unknown>>) {
  const calls: { hostId: string; method: string; params: unknown }[] = [];
  const call: SyncCall = async (hostId, method, params) => {
    calls.push({ hostId, method, params });
    const a = answers[method];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`unexpected ${method}`);
    return a;
  };
  return { calls, call };
}

const KEY: SyncKey = { transferId: "t-1", publicKey: "cHVibGlj", suite: "x25519-hkdf-sha256-aes256gcm/1", expiresAt: 1 };
const SEALED: SyncSealed = { suite: KEY.suite, transferId: "t-1", senderKey: "c2VuZGVy", nonce: "bm9uY2U=", ciphertext: "Ym94", items: ["setting:searxng.token", "mcpSecrets:brave-search"] };
const APPLIED: SyncApplied = { results: [], plan: PLAN };

describe("hostSync model: the plan", () => {
  test("groups by section in order, folds equal items, omits empty sections", () => {
    const sections = groupPlan(PLAN);
    expect(sections.map((s) => s.section)).toEqual(["settings", "roles", "mcp", "signIns"]);
    expect(sections.map((s) => s.title)).toEqual(["Settings", "Model roles", "MCP servers", "Sign-ins"]);
    const [settings, , mcp] = sections;
    expect(settings?.items.map((i) => i.id)).toEqual(["setting:symbolPreset", "setting:steeringMode", "setting:speech.dictation", "setting:searxng.token"]);
    expect(settings?.same.map((i) => i.id)).toEqual(["setting:theme.dark"]);
    // Unsupported items are listed but can't be chosen.
    expect(settings?.choosable).toEqual(["setting:symbolPreset", "setting:steeringMode", "setting:searxng.token"]);
    expect(mcp?.same.map((i) => i.id)).toEqual(["mcp:context7"]);
    expect(groupPlan({ items: PLAN.items.filter((i) => i.section === "mcp") }).map((s) => s.section)).toEqual(["mcp"]);
    expect(groupPlan({ items: [] })).toEqual([]);
  });

  test("counts differences, secrets and equal items", () => {
    const c = planCounts(PLAN);
    expect(c).toEqual({ differences: 8, secret: 3, same: 2 });
    expect(countsLine(c)).toBe("8 differences · 3 secret · 2 already the same");
    expect(countsLine({ differences: 1, secret: 0, same: 0 })).toBe("1 difference");
    expect(countsLine({ differences: 0, secret: 0, same: 4 })).toBe("No differences · 4 already the same");
  });

  test("selectable: everything but same and unsupported", () => {
    const kinds: SyncChange[] = ["add", "change", "remove", "unknown", "same", "unsupported"];
    expect(kinds.filter((change) => selectable({ change }))).toEqual(["add", "change", "remove", "unknown"]);
  });

  test("the default choice is what tf-hostd suggests", () => {
    expect([...defaultSelection(PLAN)]).toEqual(["setting:symbolPreset", "role:default", "mcp:brave-search"]);
    // A suggestion that can't be applied isn't chosen.
    expect([...defaultSelection({ items: [item("setting:x", "settings", "unsupported", { suggested: true })] })]).toEqual([]);
  });

  test("chosen and secret ids follow plan order and skip what can't be applied", () => {
    const selected = new Set(["mcpSecrets:brave-search", "signIn:anthropic|0123456789ab", "setting:searxng.token", "setting:theme.dark", "setting:speech.dictation", "role:default", "nope"]);
    expect(chosenIds(PLAN, selected)).toEqual(["signIn:anthropic|0123456789ab", "setting:searxng.token", "role:default", "mcpSecrets:brave-search"]);
    expect(secretIds(PLAN, selected)).toEqual(["signIn:anthropic|0123456789ab", "setting:searxng.token", "mcpSecrets:brave-search"]);
    expect(secretIds(PLAN, new Set(["role:default"]))).toEqual([]);
  });

  test("an MCP server chosen without its secrets is flagged, with the item that supplies them", () => {
    const needs = missingNeeds(PLAN, new Set(["mcp:brave-search"]));
    expect([...needs.keys()]).toEqual(["mcp:brave-search"]);
    expect(needs.get("mcp:brave-search")?.id).toBe("mcpSecrets:brave-search");
    expect(missingNeeds(PLAN, new Set(["mcp:brave-search", "mcpSecrets:brave-search"])).size).toBe(0);
    expect(missingNeeds(PLAN, new Set(["mcpSecrets:brave-search"])).size).toBe(0);
    // The plan lacks the needed item: flagged without a way to include it.
    const lonely = { items: [item("mcp:x", "mcp", "change", { needs: "mcpSecrets:x" })] };
    expect(missingNeeds(lonely, new Set(["mcp:x"])).get("mcp:x")).toBeNull();
  });

  test("section checkbox: all, some or none of its choosable items", () => {
    const settings = groupPlan(PLAN)[0];
    if (!settings) throw new Error("no settings");
    expect(sectionState(settings, new Set())).toBe("none");
    expect(sectionState(settings, new Set(["setting:symbolPreset"]))).toBe("some");
    const all = withIds(new Set(["role:default"]), settings.choosable, true);
    expect(sectionState(settings, all)).toBe("all");
    expect([...all]).toEqual(["role:default", "setting:symbolPreset", "setting:steeringMode", "setting:searxng.token"]);
    expect([...withIds(all, settings.choosable, false)]).toEqual(["role:default"]);
  });

  test("a fresh plan keeps the choice, drops what is now equal and picks up new suggestions", () => {
    const after: SyncPlan = {
      ...PLAN,
      items: [
        item("setting:symbolPreset", "settings", "same"),
        item("setting:steeringMode", "settings", "remove"),
        item("role:default", "roles", "change", { suggested: true }),
        item("role:plan", "roles", "add", { suggested: true }),
      ],
    };
    // role:default was suggested before and unticked: it stays unticked.
    expect([...carrySelection(new Set(["setting:symbolPreset", "setting:steeringMode"]), PLAN, after)]).toEqual(["setting:steeringMode", "role:plan"]);
  });
});

describe("hostSync model: wording", () => {
  test("change chips", () => {
    expect((["add", "change", "remove", "unknown", "unsupported", "same"] as const).map((c) => changeLabel(c, "forge"))).toEqual([
      "New",
      "Different",
      "Only on forge",
      "Can't compare",
      "Not possible here",
      "Same",
    ]);
  });

  test("settings: plain strings, compact JSON for the rest", () => {
    expect(formatValue("settings", "anthracite")).toBe("anthracite");
    expect(formatValue("settings", 120000)).toBe("120000");
    expect(formatValue("settings", false)).toBe("false");
    expect(formatValue("settings", ["model", "git"])).toBe('["model", "git"]');
    expect(formatValue("settings", { "openai-codex/*": ["openai/*"] })).toBe('{"openai-codex/*": ["openai/*"]}');
    expect(formatValue("settings", "")).toBe("");
    expect(formatValue("settings", undefined)).toBeNull();
    expect(formatValue("settings", null)).toBeNull();
  });

  test("roles: the model, then its fallback chain", () => {
    expect(formatValue("roles", { model: "anthropic/claude-opus-5:high" })).toBe("anthropic/claude-opus-5:high");
    expect(formatValue("roles", { model: "anthropic/claude-opus-5:high", fallbacks: ["openai/gpt-5.5", "google/*"] })).toBe("anthropic/claude-opus-5:high → openai/gpt-5.5, google/*");
    expect(formatValue("roles", { fallbacks: ["openai/gpt-5.5"] })).toBe("not set → openai/gpt-5.5");
    expect(formatValue("roles", {})).toBeNull();
  });

  test("MCP servers: transport, command or URL, env and header names, on or off", () => {
    expect(formatValue("mcp", { server: BRAVE, enabled: true })).toBe(`stdio · npx -y @modelcontextprotocol/server-brave-search · env BRAVE_API_KEY=${MASK} · on`);
    const files: McpServerDraft = { transport: "stdio", command: "npx", args: ["-y", "pkg", "/Users/ada/my code"], cwd: "/srv", env: [{ key: "TOKEN", value: "", secret: true }], headers: [] };
    expect(formatValue("mcp", { server: files, enabled: false })).toBe("stdio · npx -y pkg '/Users/ada/my code' · in /srv · env TOKEN (empty) · off");
    const http: McpServerDraft = { transport: "http", url: "https://api.githubcopilot.com/mcp/", args: [], env: [], headers: [{ key: "Authorization", value: MASK, secret: true }, { key: "X-Team", value: "core", secret: false }], timeoutMs: 60000 };
    expect(formatValue("mcp", { server: http, enabled: true })).toBe(`http · https://api.githubcopilot.com/mcp/ · headers Authorization=${MASK}, X-Team=core · timeout 60000 ms · on`);
    expect(formatValue("mcp", "nonsense")).toBeNull();
  });

  test("sign-ins: who, else API key, and an MCP server's host", () => {
    expect(formatValue("signIns", { id: "anthropic|0", provider: "anthropic", kind: "oauth", account: "ada@example.com", org: "Acme" })).toBe("ada@example.com · Acme");
    expect(formatValue("signIns", { id: "openrouter|0", provider: "openrouter", kind: "apiKey" })).toBe("API key");
    expect(formatValue("signIns", { id: "openai|0", provider: "openai", kind: "apiKey", account: "proj_x" })).toBe("API key · proj_x");
    expect(formatValue("signIns", { id: "mcp|0", provider: "mcp", kind: "oauth", account: "ada@example.com", mcpUrl: "https://mcp.linear.app/mcp" })).toBe("ada@example.com · mcp.linear.app");
    expect(formatValue("signIns", { id: "x|0", provider: "x", kind: "oauth" })).toBe("signed in");
  });

  test("long values are cut with an ellipsis", () => {
    expect(preview("short")).toEqual({ text: "short", cut: false });
    const long = preview("x".repeat(200), 20);
    expect(long.cut).toBe(true);
    expect(long.text).toHaveLength(20);
    expect(long.text.endsWith("…")).toBe(true);
  });

  test("progress lines", () => {
    expect(stepText("export", "studio-pc", "forge")).toBe("Reading studio-pc…");
    expect(stepText("plan", "studio-pc", "forge")).toBe("Comparing with forge…");
    expect(stepText("key", "studio-pc", "forge")).toContain("one-time key");
    expect(stepText("seal", "studio-pc", "forge")).toContain("studio-pc seals");
    expect(stepText("apply", "studio-pc", "forge")).toBe("Applying on forge…");
  });
});

describe("hostSync model: results", () => {
  test("results merge by item, the latest winning", () => {
    const first = mergeResults(undefined, [
      { id: "a", ok: false, error: "boom" },
      { id: "b", ok: true },
    ]);
    const next = mergeResults(first, [{ id: "a", ok: true, note: "fixed" }]);
    expect(next.get("a")).toEqual({ id: "a", ok: true, note: "fixed" });
    expect(next.get("b")).toEqual({ id: "b", ok: true });
    expect(first.get("a")?.ok).toBe(false);
  });

  test("the toast: copied, partly copied, nothing copied", () => {
    expect(appliedSummary({ results: [{ id: "a", ok: true }, { id: "b", ok: true }], mcpReload: { reloaded: 2, queued: 1, restartNeeded: 0, errors: [] } }, "forge")).toEqual({
      title: "Copied 2 changes to forge",
      description: "2 running sessions reloaded their MCP servers · 1 busy session reloads its MCP servers when its turn ends",
      ok: true,
    });
    expect(appliedSummary({ results: [{ id: "a", ok: true }] }, "forge")).toEqual({ title: "Copied 1 change to forge", ok: true });
    expect(appliedSummary({ results: [{ id: "a", ok: true }, { id: "b", ok: false, error: "no" }] }, "forge")).toMatchObject({ title: "Copied 1 of 2 changes to forge", ok: false });
    expect(appliedSummary({ results: [{ id: "b", ok: false, error: "omp said no" }] }, "forge")).toEqual({ title: "Nothing was copied to forge", description: "omp said no", ok: false });
  });

  test("MCP reload summary", () => {
    expect(reloadSummary(undefined)).toBeNull();
    expect(reloadSummary({ reloaded: 0, queued: 0, restartNeeded: 0, errors: [] })).toContain("No omp session was running");
    expect(reloadSummary({ reloaded: 1, queued: 2, restartNeeded: 3, errors: [] })).toBe(
      "1 running session reloaded its MCP servers · 2 busy sessions reload their MCP servers when their turns end · 3 sessions need a restart to pick the changes up",
    );
  });
});

describe("hostSync model: calls", () => {
  test("compare: export on the source, then plan on the target with that export", async () => {
    const r = recorder({ "hostSync.export": PROFILE, "hostSync.plan": PLAN });
    const phases: string[] = [];
    const out = await compareHosts(r.call, "studio-pc", "forge", (p) => phases.push(p));
    expect(out).toEqual({ profile: PROFILE, plan: PLAN });
    expect(phases).toEqual(["export", "plan"]);
    expect(r.calls).toEqual([
      { hostId: "studio-pc", method: "hostSync.export", params: {} },
      { hostId: "forge", method: "hostSync.plan", params: { source: PROFILE } },
    ]);
  });

  test("apply without secrets: one call on the target, nothing sealed", async () => {
    const r = recorder({ "hostSync.apply": APPLIED });
    const phases: string[] = [];
    const out = await applyCopy(r.call, { sourceId: "studio-pc", targetId: "forge", profile: PROFILE, plan: PLAN, selected: new Set(["role:default", "setting:symbolPreset", "setting:theme.dark"]) }, (p) => phases.push(p));
    expect(out).toBe(APPLIED);
    expect(phases).toEqual(["apply"]);
    expect(r.calls).toEqual([{ hostId: "forge", method: "hostSync.apply", params: { source: PROFILE, items: ["setting:symbolPreset", "role:default"] } }]);
    expect(Object.hasOwn(r.calls[0]?.params as object, "sealed")).toBe(false);
  });

  test("apply with secrets: key on the target, sealed on the source for exactly those, relayed to the target", async () => {
    const r = recorder({ "hostSync.keyBegin": KEY, "hostSync.seal": SEALED, "hostSync.apply": APPLIED });
    const phases: string[] = [];
    const selected = new Set(["mcpSecrets:brave-search", "mcp:brave-search", "setting:searxng.token", "setting:symbolPreset"]);
    await applyCopy(r.call, { sourceId: "studio-pc", targetId: "forge", profile: PROFILE, plan: PLAN, selected }, (p) => phases.push(p));
    expect(phases).toEqual(["key", "seal", "apply"]);
    expect(r.calls.map((c) => [c.hostId, c.method])).toEqual([
      ["forge", "hostSync.keyBegin"],
      ["studio-pc", "hostSync.seal"],
      ["forge", "hostSync.apply"],
    ]);
    expect(r.calls[0]?.params).toEqual({});
    expect(r.calls[1]?.params).toEqual({ transferId: "t-1", publicKey: "cHVibGlj", items: ["setting:searxng.token", "mcpSecrets:brave-search"] });
    const apply = r.calls[2]?.params as { source: SyncProfile; items: string[]; sealed: SyncSealed };
    expect(apply.items).toEqual(["setting:symbolPreset", "setting:searxng.token", "mcp:brave-search", "mcpSecrets:brave-search"]);
    expect(apply.source).toBe(PROFILE);
    // The sealed box is relayed untouched.
    expect(apply.sealed).toBe(SEALED);
  });

  /** The `SyncStepError` `p` rejects with. */
  async function stepFailure(p: Promise<unknown>): Promise<SyncStepError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof SyncStepError) return e;
      throw e;
    }
    throw new Error("expected a rejection");
  }

  test("a failed step rejects with the step, the host and the host's error; later steps don't run", async () => {
    const r = recorder({ "hostSync.keyBegin": KEY, "hostSync.seal": apiError("unknown_method", "unknown method hostSync.seal"), "hostSync.apply": APPLIED });
    const selected = new Set(["setting:searxng.token"]);
    const f = await stepFailure(applyCopy(r.call, { sourceId: "studio-pc", targetId: "forge", profile: PROFILE, plan: PLAN, selected }));
    expect([f.step, f.hostId, f.error.code, f.error.message]).toEqual(["seal", "studio-pc", "unknown_method", "unknown method hostSync.seal"]);
    expect(r.calls.map((c) => c.method)).toEqual(["hostSync.keyBegin", "hostSync.seal"]);

    const k = recorder({ "hostSync.keyBegin": new Error("socket closed") });
    const keyErr = await stepFailure(applyCopy(k.call, { sourceId: "studio-pc", targetId: "forge", profile: PROFILE, plan: PLAN, selected }));
    expect([keyErr.step, keyErr.hostId, keyErr.error.code, keyErr.error.message]).toEqual(["key", "forge", "internal", "socket closed"]);

    const c = recorder({ "hostSync.export": apiError("timeout", "no answer in 180 s") });
    const cmpErr = await stepFailure(compareHosts(c.call, "studio-pc", "forge"));
    expect([cmpErr.step, cmpErr.hostId, cmpErr.error.code]).toEqual(["export", "studio-pc", "timeout"]);
  });

  test("nothing chosen: no call", async () => {
    const r = recorder({});
    const err = await stepFailure(applyCopy(r.call, { sourceId: "studio-pc", targetId: "forge", profile: PROFILE, plan: PLAN, selected: new Set(["setting:theme.dark"]) }));
    expect(err.error.code).toBe("invalid_params");
    expect(r.calls).toEqual([]);
  });

  test("failures by error code", () => {
    const names: Record<string, string> = { forge: "forge", "studio-pc": "studio-pc" };
    const nameOf = (id: string) => names[id] ?? id;
    const view = (step: SyncStepError["step"], hostId: string, code: string, hint?: string) => describeFailure(new SyncStepError(step, hostId, apiError(code, `${code} happened`, { hint })), nameOf, "studio-pc", "forge");
    const old = view("seal", "studio-pc", "unknown_method");
    expect(old.title).toBe("studio-pc runs an older tf-hostd");
    expect(old.hint).toContain("Reconnect studio-pc");
    expect(old.restart).toBe(false);
    expect(view("plan", "forge", "unsupported", "Update omp to 18.13")).toEqual({ title: "Couldn't compare with forge", message: "unsupported happened", hint: "Update omp to 18.13", restart: false });
    expect(view("apply", "forge", "expired")).toMatchObject({ restart: true, title: "The one-time key ran out" });
    expect(view("apply", "forge", "sealed_invalid")).toMatchObject({ restart: true });
    expect(view("apply", "forge", "invalid_params").restart).toBe(true);
    expect(view("apply", "forge", "timeout")).toMatchObject({ restart: true, title: "forge took too long" });
    expect(view("export", "studio-pc", "omp_error").title).toBe("omp on studio-pc reported an error");
    expect(view("key", "forge", "io_error")).toMatchObject({ title: "Couldn't get a one-time key from forge", restart: false });
  });
});

describe("hostSync model: against the demo hosts", () => {
  /** Runs `p` while moving the demo clock, so each step's answer comes. */
  async function drive<T>(clock: ManualClock, p: Promise<T>): Promise<T> {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 200 && !settled; i++) {
      // Let the answered step's continuations run (they start the next call), then move demo time.
      for (let k = 0; k < 20; k++) await Promise.resolve();
      clock.advance(250);
    }
    return p;
  }

  test("compare, then copy everything with its secrets: the target matches", async () => {
    const clock = new ManualClock();
    const hosts: Record<string, DemoHostSync> = {
      forge: new DemoHostSync({ id: "forge", variant: "forge", clock }),
      "studio-pc": new DemoHostSync({ id: "studio-pc", variant: "studio", clock }),
    };
    const call: SyncCall = (hostId, method, params) => {
      const host = hosts[hostId];
      if (!host) throw apiError("not_found", hostId);
      return host.call(method, params as Record<string, unknown>);
    };
    const phases: string[] = [];
    const { profile, plan } = await drive(clock, compareHosts(call, "studio-pc", "forge", (p) => phases.push(p)));
    const selected = withIds(defaultSelection(plan), plan.items.filter(selectable).map((i) => i.id), true);
    const secrets = secretIds(plan, selected);
    expect(secrets.length).toBeGreaterThan(0);
    const applied = await drive(clock, applyCopy(call, { sourceId: "studio-pc", targetId: "forge", profile, plan, selected }, (p) => phases.push(p)));
    expect(phases).toEqual(["export", "plan", "key", "seal", "apply"]);
    expect(applied.results.map((r) => r.id)).toEqual(chosenIds(plan, selected));
    expect(applied.results.every((r) => r.ok)).toBe(true);
    expect(applied.mcpReload).toBeDefined();
    // Left: what isn't possible on forge, and secrets both hosts now have (never comparable).
    const left = applied.plan.items.filter((i) => i.change !== "same");
    expect(new Set(left.map((i) => i.change))).toEqual(new Set<SyncChange>(["unsupported", "unknown"]));
    expect(planCounts(applied.plan).differences).toBe(left.length);
  });
});
