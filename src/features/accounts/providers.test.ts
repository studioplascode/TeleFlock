import { describe, expect, test } from "bun:test";
import { DEMO_LOGIN_PROVIDERS } from "@/core/demo/accounts";
import type { LinkedAccount, LoginProvider } from "@/core/gen";
import { alternateLogin, baseLogin, byListOrder, pickerSections, providerDetail, providerLook } from "./providers";

/** omp 18.13.3's `/login` list. */
const ALL = DEMO_LOGIN_PROVIDERS;
const p = (id: string): LoginProvider => ALL.find((x) => x.id === id) as LoginProvider;

describe("picker", () => {
  test("every account appears once: paired logins are one entry", () => {
    const { popular, rest } = pickerSections(ALL);
    const entries = [...popular, ...rest];
    const ids = entries.map((e) => e.provider.id);
    expect(ids).not.toContain("openai-codex-device");
    expect(ids).not.toContain("zai-coding-plan");
    expect(entries.find((e) => e.provider.id === "openai-codex")?.alternate?.id).toBe("openai-codex-device");
    expect(entries.find((e) => e.provider.id === "zai")?.alternate?.id).toBe("zai-coding-plan");
    // No two entries read the same.
    const names = entries.map((e) => `${providerLook(e.provider.id, e.provider.name).name}|${providerDetail(e.provider) ?? ""}`);
    expect(new Set(names).size).toBe(names.length);
    expect(popular.map((e) => e.provider.id).slice(0, 2)).toEqual(["openai-codex", "anthropic"]);
  });

  test("the account's other login is offered from the first, and leads back to it", () => {
    expect(alternateLogin("openai-codex", ALL)).toMatchObject({ provider: { id: "openai-codex-device" }, device: true });
    expect(baseLogin("openai-codex-device", ALL)).toMatchObject({ provider: { id: "openai-codex" }, back: "Back to the browser sign-in" });
    expect(alternateLogin("zai", ALL)).toMatchObject({ provider: { id: "zai-coding-plan" }, device: false });
    expect(baseLogin("zai-coding-plan", ALL)?.provider.id).toBe("zai");
    expect(alternateLogin("anthropic", ALL)).toBeUndefined();
    expect(baseLogin("anthropic", ALL)).toBeUndefined();
  });

  test("subtitles add to the name, never repeat it", () => {
    expect(providerDetail(p("zai"))).toBe("GLM Coding Plan");
    expect(providerDetail(p("gitlab-duo"))).toBe("Non-Agentic");
    expect(providerDetail(p("minimax-code"))).toBe("Token Plan · International");
    expect(providerDetail(p("minimax-code-cn"))).toBe("Token Plan");
    expect(providerDetail(p("moonshot"))).toBe("Kimi API");
    expect(providerDetail(p("ollama"))).toBe("Local OpenAI-compatible");
    expect(providerDetail(p("firepass"))).toBe("Fireworks subscription");
    expect(providerDetail(p("google-gemini-cli"))).toBe("Sign in with Google");
    for (const id of ["kimi-code", "devin", "xai", "gitlab-duo-agent", "deepseek"]) expect(providerDetail(p(id))).toBeUndefined();
    for (const x of ALL) {
      const detail = providerDetail(x)?.toLowerCase();
      if (detail) expect(detail).not.toBe(providerLook(x.id, x.name).name.toLowerCase());
    }
  });
});

describe("account list order", () => {
  const acct = (label: string, over: Partial<LinkedAccount> = {}): LinkedAccount => ({
    key: `anthropic|email:${label}`,
    provider: "anthropic",
    kind: "oauth",
    label,
    disabled: false,
    preferred: false,
    sessions: 0,
    windows: [],
    ...over,
  });

  test("linked order with expired logins last; preferring one moves nothing", () => {
    const you = acct("you@flock.dev", { credentialId: 1, linkedAt: 100 });
    const team = acct("team@acme.io", { credentialId: 2, linkedAt: 200 });
    const old = acct("old@flock.dev", { credentialId: 3, linkedAt: 300, disabled: true });
    const report = acct("broker@acme.io");
    expect([old, report, team, you].sort(byListOrder)).toEqual([you, team, report, old]);
    const preferTeam = [{ ...you, preferred: false }, { ...team, preferred: true }, old];
    expect([...preferTeam].reverse().sort(byListOrder).map((a) => a.label)).toEqual(["you@flock.dev", "team@acme.io", "old@flock.dev"]);
  });
});
