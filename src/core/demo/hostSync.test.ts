import { describe, expect, test } from "bun:test";
import { CoreError } from "../errors";
import type { SyncApplied, SyncChange, SyncItem, SyncKey, SyncPlan, SyncProfile, SyncSealed } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { DEMO_SYNC_KEY_TTL_MS, DEMO_SYNC_SUITE, DemoHostSync } from "./hostSync";
import { DEMO_SECRET_MASK as MASK } from "./mcp";

function rig() {
  const clock = new ManualClock();
  const forge = new DemoHostSync({ id: "forge", variant: "forge", clock, ompVersion: () => "18.12.6" });
  const studio = new DemoHostSync({ id: "studio-pc", variant: "studio", clock, ompVersion: () => "18.12.3" });
  /** Calls a method and moves the demo clock past its latency. */
  const call = async <T,>(host: DemoHostSync, method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const p = host.call(method, params);
    clock.advance(2000);
    return (await p) as T;
  };
  return { clock, forge, studio, call };
}

async function failure(p: Promise<unknown>): Promise<CoreError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CoreError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

function item(plan: SyncPlan, id: string): SyncItem {
  const i = plan.items.find((x) => x.id === id);
  if (!i) throw new Error(`no ${id} in ${plan.items.map((x) => x.id).join(", ")}`);
  return i;
}

function choosable(plan: SyncPlan): string[] {
  return plan.items.filter((i) => i.change !== "same" && i.change !== "unsupported").map((i) => i.id);
}

describe("demo hostSync", () => {
  test("export: each host's own setup, nothing secret in it", async () => {
    const r = rig();
    const forge = await r.call<SyncProfile>(r.forge, "hostSync.export");
    const studio = await r.call<SyncProfile>(r.studio, "hostSync.export");
    expect(forge.ompVersion).toBe("18.12.6");
    expect(studio.ompVersion).toBe("18.12.3");
    expect(forge.settings.map((s) => s.key)).toContain("steeringMode");
    expect(studio.settings.map((s) => s.key)).not.toContain("steeringMode");
    // Credentials are listed without a value.
    for (const s of [...forge.settings, ...studio.settings].filter((x) => x.secret)) expect(s.value).toBeUndefined();
    expect(studio.settings.find((s) => s.key === "searxng.token")).toMatchObject({ secret: true, type: "string" });
    expect(studio.settings.find((s) => s.key === "theme.dark")).toMatchObject({ value: "anthracite", label: "Dark Theme", tab: "appearance", group: "Theme" });
    // MCP secrets are masked, and flagged.
    const brave = studio.mcp.find((m) => m.name === "brave-search");
    expect(brave).toMatchObject({ secrets: true, enabled: true });
    expect(brave?.server.env).toEqual([{ key: "BRAVE_API_KEY", value: MASK, secret: true }]);
    expect(studio.mcp.find((m) => m.name === "linear")).toMatchObject({ signedIn: true, secrets: false });
    expect(studio.mcp.find((m) => m.name === "filesystem")?.extra).toEqual(["autoApprove"]);
    for (const kv of [...forge.mcp, ...studio.mcp].flatMap((m) => [...m.server.env, ...m.server.headers])) {
      if (kv.secret) expect([MASK, ""]).toContain(kv.value);
    }
    // Sign-ins by identity: the same account has the same id on both hosts.
    expect(forge.signIns.every((s) => /^[a-z-]+\|[0-9a-f]{12}$/.test(s.id))).toBe(true);
    const claude = forge.signIns.find((s) => s.provider === "anthropic");
    expect(claude).toMatchObject({ kind: "oauth", account: "ada@example.com", org: "Acme" });
    expect(studio.signIns.find((s) => s.provider === "anthropic")?.id).toBe(claude?.id);
    expect(studio.signIns.find((s) => s.provider === "openrouter")).toMatchObject({ kind: "apiKey" });
  });

  test("plan: every section and change kind, with needs, notes, secrets and same items", async () => {
    const r = rig();
    const source = await r.call<SyncProfile>(r.studio, "hostSync.export");
    const plan = await r.call<SyncPlan>(r.forge, "hostSync.plan", { source });
    expect(plan).toMatchObject({ sourceOmp: "18.12.3", targetOmp: "18.12.6" });
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(new Set(plan.items.map((i) => i.section))).toEqual(new Set(["settings", "roles", "mcp", "signIns"]));
    expect(new Set(plan.items.map((i) => i.change))).toEqual(new Set<SyncChange>(["add", "change", "remove", "same", "unknown", "unsupported"]));
    // Sections in order.
    const order = plan.items.map((i) => ["settings", "roles", "mcp", "signIns"].indexOf(i.section));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(item(plan, "setting:theme.dark").change).toBe("same");
    expect(item(plan, "setting:symbolPreset")).toMatchObject({ change: "add", suggested: true, from: "nerd", place: "Appearance › Theme", label: "Symbol Preset" });
    expect(item(plan, "setting:defaultThinkingLevel")).toMatchObject({ change: "change", suggested: true, from: "xhigh", to: "high" });
    expect(item(plan, "setting:steeringMode")).toMatchObject({ change: "remove", suggested: false, to: "all" });
    // forge's omp build lacks the key: not possible here, and said why.
    expect(item(plan, "setting:speech.dictation")).toMatchObject({ change: "unsupported", suggested: false, from: true, label: "Dictation", place: "Interaction › Speech" });
    expect(item(plan, "setting:speech.dictation").notes[0]).toContain("omp 18.12.6 on this host has no `speech.dictation` setting");
    expect(item(plan, "setting:hindsight.apiToken")).toMatchObject({ change: "unknown", secret: true, suggested: false });
    expect(item(plan, "setting:searxng.token")).toMatchObject({ change: "add", secret: true, suggested: false });
    expect(item(plan, "setting:searxng.token").from).toBeUndefined();

    expect(item(plan, "role:default")).toMatchObject({ change: "change", suggested: true, from: { model: "anthropic/claude-opus-5:xhigh", fallbacks: ["anthropic/claude-sonnet-5:high"] } });
    expect(item(plan, "role:smol").change).toBe("same");
    expect(item(plan, "role:plan")).toMatchObject({ change: "add", suggested: true });
    expect(item(plan, "role:task")).toMatchObject({ change: "remove", suggested: false });
    // No google sign-in on forge: still suggested, with a note.
    expect(item(plan, "role:slow")).toMatchObject({ change: "change", suggested: true });
    expect(item(plan, "role:slow").notes).toEqual(["`google/gemini-3-pro` isn't among this host's models (no google sign-in here)."]);

    expect(item(plan, "mcp:context7").change).toBe("same");
    expect(item(plan, "mcpSecrets:context7")).toMatchObject({ change: "unknown", secret: true });
    expect(item(plan, "mcp:brave-search")).toMatchObject({ change: "add", suggested: true, needs: "mcpSecrets:brave-search" });
    expect(item(plan, "mcp:brave-search").notes.join(" ")).toContain("BRAVE_API_KEY");
    expect(item(plan, "mcpSecrets:brave-search")).toMatchObject({ change: "add", secret: true, suggested: false });
    // forge keeps its own Authorization header: nothing needed.
    expect(item(plan, "mcp:github")).toMatchObject({ change: "change", from: { enabled: false }, to: { enabled: true } });
    expect(item(plan, "mcp:github").needs).toBeUndefined();
    expect(item(plan, "mcp:filesystem").notes.join(" ")).toContain("autoApprove");
    expect(item(plan, "mcp:filesystem").notes.join(" ")).toContain("`/Users/ada/code` is an absolute path");
    expect(item(plan, "mcp:linear").notes.join(" ")).toContain("OAuth");
    expect(item(plan, "mcp:postgres")).toMatchObject({ change: "remove", suggested: false });

    const signIns = plan.items.filter((i) => i.section === "signIns");
    expect(signIns.every((i) => i.secret && !i.suggested)).toBe(true);
    expect(signIns.find((i) => i.place === "anthropic")?.change).toBe("unknown");
    expect(signIns.find((i) => i.place === "openrouter")).toMatchObject({ change: "add", label: "API key", notes: [] });
    expect(signIns.find((i) => i.place === "mcp")).toMatchObject({ change: "add", label: "mcp.linear.app" });
    // OAuth sign-ins carry omp's refresh-token warning.
    const oauthIds = source.signIns.filter((s) => s.kind === "oauth").map((s) => `signIn:${s.id}`);
    expect(oauthIds.length).toBe(3);
    for (const id of oauthIds) expect(item(plan, id).notes[0]).toContain("rotate refresh tokens");

    // Never suggested: a removal or a secret.
    expect(plan.items.filter((i) => i.suggested && (i.change === "remove" || i.secret))).toEqual([]);
  });

  test("plan the other way round: studio-pc's omp lacks forge's key, studio-pc's own credential would go", async () => {
    const r = rig();
    const source = await r.call<SyncProfile>(r.forge, "hostSync.export");
    const plan = await r.call<SyncPlan>(r.studio, "hostSync.plan", { source });
    expect(item(plan, "setting:isolation.backend")).toMatchObject({ change: "unsupported", from: "docker" });
    expect(item(plan, "setting:speech.dictation")).toMatchObject({ change: "remove", to: true });
    expect(item(plan, "setting:searxng.token")).toMatchObject({ change: "remove", secret: false, suggested: false });
    expect(item(plan, "setting:searxng.token").notes[0]).toContain("credential");
    expect(item(plan, "mcp:postgres")).toMatchObject({ change: "add", suggested: true });
    expect(item(plan, "mcp:brave-search").change).toBe("remove");
    expect(item(plan, "mcp:filesystem").notes.join(" ")).toContain("`/home/demo/code`");
    expect(plan.items.some((i) => i.change === "unsupported" && i.section === "signIns")).toBe(false);
  });

  test("keyBegin and seal answer fake key material and a box that names its items", async () => {
    const r = rig();
    const key = await r.call<SyncKey>(r.forge, "hostSync.keyBegin");
    expect(key.suite).toBe(DEMO_SYNC_SUITE);
    expect(key.expiresAt).toBe(r.clock.now() - 2000 + DEMO_SYNC_KEY_TTL_MS);
    expect(atob(key.publicKey)).toContain("demo");
    const source = await r.call<SyncProfile>(r.studio, "hostSync.export");
    const plan = await r.call<SyncPlan>(r.forge, "hostSync.plan", { source });
    const secrets = plan.items.filter((i) => i.secret && i.change !== "unsupported").map((i) => i.id);
    const sealed = await r.call<SyncSealed>(r.studio, "hostSync.seal", { transferId: key.transferId, publicKey: key.publicKey, items: secrets });
    expect(sealed).toMatchObject({ suite: DEMO_SYNC_SUITE, transferId: key.transferId, items: secrets });
    expect(atob(sealed.ciphertext)).toMatch(/^demo sealed box/);
    for (const field of [sealed.senderKey, sealed.nonce]) expect(atob(field)).toContain("demo");
    // A secret the source doesn't have can't be sealed.
    const err = await failure(r.call(r.forge, "hostSync.seal", { transferId: key.transferId, publicKey: key.publicKey, items: ["setting:searxng.token"] }));
    expect(err.code).toBe("invalid_params");
  });

  test("apply: applied items become same, copied secrets can't be compared, MCP reload reported", async () => {
    const r = rig();
    const source = await r.call<SyncProfile>(r.studio, "hostSync.export");
    const plan = await r.call<SyncPlan>(r.forge, "hostSync.plan", { source });
    const items = choosable(plan);
    const secrets = plan.items.filter((i) => items.includes(i.id) && i.secret).map((i) => i.id);
    const key = await r.call<SyncKey>(r.forge, "hostSync.keyBegin");
    const sealed = await r.call<SyncSealed>(r.studio, "hostSync.seal", { transferId: key.transferId, publicKey: key.publicKey, items: secrets });
    const applied = await r.call<SyncApplied>(r.forge, "hostSync.apply", { source, items, sealed });
    expect(applied.results.map((x) => x.id)).toEqual(items);
    expect(applied.results.every((x) => x.ok)).toBe(true);
    expect(applied.mcpReload).toEqual({ reloaded: 0, queued: 0, restartNeeded: 0, errors: [] });
    for (const id of items) {
      const before = item(plan, id);
      const after = applied.plan.items.find((i) => i.id === id);
      // A removed item is gone from both hosts; a copied secret is on both but can't be compared.
      if (before.change === "remove") expect(after).toBeUndefined();
      else expect(after?.change).toBe(before.secret ? "unknown" : "same");
    }
    expect(items.filter((id) => item(plan, id).change === "remove")).toEqual(["setting:steeringMode", "setting:retry.usageAwareFallback", "setting:isolation.backend", "role:task", "mcp:postgres"]);
    // The plan asked again agrees, and what wasn't possible still isn't.
    const again = await r.call<SyncPlan>(r.forge, "hostSync.plan", { source });
    expect(again.items.filter((i) => i.change !== "same" && i.change !== "unknown").map((i) => i.id)).toEqual(
      again.items.filter((i) => i.change === "unsupported").map((i) => i.id),
    );
    // The key was spent.
    const reuse = await failure(r.call(r.forge, "hostSync.apply", { source, items: [secrets[0]], sealed: { ...sealed, items: [secrets[0]] } }));
    expect(reuse.code).toBe("expired");
  });

  test("apply: an MCP server without its secrets is left with empty values", async () => {
    const r = rig();
    const source = await r.call<SyncProfile>(r.studio, "hostSync.export");
    const applied = await r.call<SyncApplied>(r.forge, "hostSync.apply", { source, items: ["mcp:brave-search"] });
    expect(applied.results[0]).toMatchObject({ id: "mcp:brave-search", ok: true });
    expect(applied.results[0]?.note).toContain("BRAVE_API_KEY");
    const forge = await r.call<SyncProfile>(r.forge, "hostSync.export");
    expect(forge.mcp.find((m) => m.name === "brave-search")?.server.env).toEqual([{ key: "BRAVE_API_KEY", value: "", secret: true }]);
    expect(item(applied.plan, "mcpSecrets:brave-search").change).toBe("add");
    expect(item(applied.plan, "mcp:brave-search")).toMatchObject({ change: "change", needs: "mcpSecrets:brave-search" });
  });

  test("apply: an unsupported item and one no longer in the plan fail with their reason; the rest apply", async () => {
    const r = rig();
    const source = await r.call<SyncProfile>(r.studio, "hostSync.export");
    const applied = await r.call<SyncApplied>(r.forge, "hostSync.apply", { source, items: ["setting:nope", "setting:speech.dictation", "setting:symbolPreset", "setting:theme.dark"] });
    expect(applied.results).toEqual([
      { id: "setting:theme.dark", ok: true, note: "Already the same." },
      { id: "setting:symbolPreset", ok: true },
      { id: "setting:speech.dictation", ok: false, error: expect.stringContaining("no `speech.dictation` setting") },
      { id: "setting:nope", ok: false, error: "No longer in the plan: compare the hosts again." },
    ]);
    expect(applied.mcpReload).toBeUndefined();
    expect(item(applied.plan, "setting:symbolPreset").change).toBe("same");
  });

  test("apply refuses sealed items that aren't exactly the chosen secrets, secrets without a box and stale keys", async () => {
    const r = rig();
    const source = await r.call<SyncProfile>(r.studio, "hostSync.export");
    const chosen = ["setting:searxng.token", "mcpSecrets:brave-search"];
    const key = await r.call<SyncKey>(r.forge, "hostSync.keyBegin");
    const sealed = await r.call<SyncSealed>(r.studio, "hostSync.seal", { transferId: key.transferId, publicKey: key.publicKey, items: [chosen[0]] });
    const mismatch = await failure(r.call(r.forge, "hostSync.apply", { source, items: chosen, sealed }));
    expect(mismatch.code).toBe("sealed_invalid");

    const unsealed = await failure(r.call(r.forge, "hostSync.apply", { source, items: chosen }));
    expect(unsealed.code).toBe("invalid_params");

    const late = await r.call<SyncKey>(r.forge, "hostSync.keyBegin");
    const box = await r.call<SyncSealed>(r.studio, "hostSync.seal", { transferId: late.transferId, publicKey: late.publicKey, items: chosen });
    r.clock.advance(DEMO_SYNC_KEY_TTL_MS);
    const expired = await failure(r.call(r.forge, "hostSync.apply", { source, items: chosen, sealed: box }));
    expect(expired.code).toBe("expired");

    const empty = await failure(r.call(r.forge, "hostSync.apply", { source, items: [] }));
    expect(empty.code).toBe("invalid_params");
  });

  test("the demo engine routes hostSync.* to each demo host", async () => {
    const clock = new ManualClock();
    const engine = new DemoEngine({ mode: "backend", clock });
    engine.subscribe(() => {});
    clock.advance(5000);
    const p = engine.callHost("forge", "hostSync.export", {});
    clock.advance(2000);
    const profile = (await p) as SyncProfile;
    expect(profile.settings.find((s) => s.key === "isolation.backend")?.value).toBe("docker");
    engine.dispose();
  });
});
