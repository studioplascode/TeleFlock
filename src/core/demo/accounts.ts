/**
 * Demo `accounts.*`: omp's login providers (18.13's `/login` list), the credentials the demo host
 * stores (the accounts `host.limits` reports, an API key, an expired login) and scripted links
 * through the demo `auth.*` flows (`./auth`). Links, unlinks and the preferred account change what
 * `host.limits` reports too, so Usage and Accounts agree.
 */
import type { AccountLimits, AccountsSnapshot, Agent, AuthFlow, LimitAccount, LinkedAccount, LoginProvider } from "../gen";
import { apiError } from "../errors";
import type { DemoAuthFlows, DemoAuthScript } from "./auth";
import { demoLimits } from "./limits";

/** `omp auth-broker list --json` of omp 18.13.3 (its `/login` order). */
export const DEMO_LOGIN_PROVIDERS: LoginProvider[] = (
  [
    ["openai-codex", "ChatGPT Plus/Pro (Codex Subscription)"],
    ["anthropic", "Anthropic (Claude Pro/Max)"],
    ["zai", "Z.AI (GLM Coding Plan)"],
    ["zai-coding-plan", "Z.AI (GLM Coding Plan · Sign in)"],
    ["kimi-code", "Kimi Code"],
    ["openrouter", "OpenRouter"],
    ["github-copilot", "GitHub Copilot"],
    ["cursor", "Cursor (Claude, GPT, etc.)"],
    ["devin", "Devin"],
    ["google-antigravity", "Google Antigravity (Gemini, Claude, GPT-OSS)"],
    ["google-gemini-cli", "Google Cloud Code Assist (Gemini CLI)"],
    ["openai-codex-device", "ChatGPT Plus/Pro (Codex, headless/device)"],
    ["xai", "xAI API"],
    ["xai-oauth", "xAI Grok OAuth (SuperGrok or X Premium+)"],
    ["gitlab-duo", "GitLab Duo Non-Agentic"],
    ["gitlab-duo-agent", "GitLab Duo Agent"],
    ["alibaba-coding-plan", "Alibaba Coding Plan"],
    ["alibaba-token-plan", "QwenCloud Token Plan"],
    ["zhipu-coding-plan", "Zhipu Coding Plan (智谱)"],
    ["qwen-portal", "Qwen Portal"],
    ["minimax-code", "MiniMax Token Plan (International)"],
    ["minimax-code-cn", "MiniMax Token Plan (China)"],
    ["xiaomi", "Xiaomi MiMo"],
    ["firepass", "Fire Pass (Fireworks subscription)"],
    ["cline-pass", "ClinePass"],
    ["factory-droid", "Factory Droid"],
    ["deepseek", "DeepSeek"],
    ["muse-code", "Muse Code (Subscription)"],
    ["moonshot", "Moonshot (Kimi API)"],
    ["cerebras", "Cerebras"],
    ["fireworks", "Fireworks"],
    ["together", "Together"],
    ["nvidia", "NVIDIA"],
    ["deepinfra", "DeepInfra"],
    ["huggingface", "Hugging Face Inference"],
    ["perplexity", "Perplexity (Pro/Max)"],
    ["venice", "Venice"],
    ["vercel-ai-gateway", "Vercel AI Gateway"],
    ["cloudflare-ai-gateway", "Cloudflare AI Gateway"],
    ["cloudflare-workers-ai", "Cloudflare Workers AI"],
    ["snowflake", "Snowflake Cortex"],
    ["litellm", "LiteLLM"],
    ["kilo", "Kilo Gateway"],
    ["opencode-zen", "OpenCode Zen"],
    ["opencode-go", "OpenCode Go"],
    ["tavily", "Tavily"],
    ["exa", "Exa"],
    ["ollama", "Ollama (Local OpenAI-compatible)"],
    ["ollama-cloud", "Ollama Cloud"],
    ["lm-studio", "LM Studio (Local OpenAI-compatible)"],
    ["vllm", "vLLM (Local OpenAI-compatible)"],
  ] as const
).map(([id, name]) => ({ id, name }));

/** Callback ports of omp's loopback logins (pi-catalog auth rules). */
const CALLBACK_PORTS: Record<string, [number, string]> = {
  "openai-codex": [1455, "/auth/callback"],
  anthropic: [54545, "/callback"],
  openrouter: [54549, "/callback"],
  devin: [59653, "/callback"],
  "google-antigravity": [51121, "/oauth-callback"],
  "google-gemini-cli": [8085, "/oauth2callback"],
  "gitlab-duo": [8080, "/callback"],
};
const DEVICE: Record<string, true> = { "openai-codex-device": true, "github-copilot": true, "kimi-code": true, "xai-oauth": true, "factory-droid": true, "muse-code": true, kilo: true, cursor: true };
const PASTE: Record<string, true> = { "zai-coding-plan": true, "gitlab-duo-agent": true };
/** Where `-device` logins store their credentials. */
const STORE_AS: Record<string, string> = { "openai-codex-device": "openai-codex", "zai-coding-plan": "zai" };

interface Cred {
  id: number;
  provider: string;
  oauth: boolean;
  label: string;
  org?: string;
  plan?: string;
  linkedAt: number;
  disabled?: string;
}

export interface DemoAccountsHost {
  id: string;
  now(): number;
  agents(): Agent[];
  readonly auth: DemoAuthFlows;
}

export class DemoAccounts {
  private creds: Cred[];
  private nextId: number;
  private preferred = new Set<string>();
  private linked = 0;

  constructor(private readonly host: DemoAccountsHost) {
    const t = host.now();
    const base = demoLimits(host.id, t, [], true).accounts;
    this.creds = base.map((a, i) => ({
      id: i + 1,
      provider: a.provider,
      oauth: true,
      label: a.label,
      org: a.org,
      plan: a.plan,
      linkedAt: t - (40 - i * 9) * 86_400_000,
      disabled: a.disabled ? "oauth refresh failed: invalid_grant (Refresh token expired)" : undefined,
    }));
    this.creds.push({ id: this.creds.length + 1, provider: "openrouter", oauth: false, label: `API key #${this.creds.length + 1}`, linkedAt: t - 12 * 86_400_000 });
    this.nextId = this.creds.length + 1;
    const first = this.creds[0];
    if (first) this.preferred.add(keyOf(first));
  }

  /** `host.limits`, minus unlinked accounts, plus linked ones (no report yet). */
  limits(withDisabled: boolean): AccountLimits {
    const base = demoLimits(this.host.id, this.host.now(), this.host.agents(), withDisabled);
    const live = new Set(this.creds.filter((c) => c.oauth).map(keyOf));
    const active = new Set(this.creds.filter((c) => c.oauth && !c.disabled).map(keyOf));
    const accounts: LimitAccount[] = base.accounts
      .filter((a) => live.has(a.key) && (withDisabled || !a.disabled || active.has(a.key)))
      // A login linked again since the fixture's "expired" report: omp has no windows for it yet.
      .map((a) => (a.disabled && active.has(a.key) ? { ...a, disabled: false, error: "omp reported no limit windows for this account" } : a));
    for (const c of this.creds) {
      if (!c.oauth || accounts.some((a) => a.key === keyOf(c)) || base.accounts.some((a) => a.key === keyOf(c))) continue;
      accounts.push({ key: keyOf(c), provider: c.provider, label: c.label, org: c.org, plan: c.plan, windows: [], notes: [], error: "omp reported no limit windows for this account", disabled: !!c.disabled });
    }
    // A preference routes this host's sessions of its provider to the preferred account.
    const sessions = base.sessions.map((s) => {
      const pref = [...this.preferred].find((k) => k.startsWith(`${s.provider}|`));
      return pref && live.has(pref) ? { ...s, accountKey: pref } : s.accountKey && live.has(s.accountKey) ? s : { ...s, accountKey: undefined };
    });
    return { ...base, accounts, sessions };
  }

  /** Does omp have anything to sign in with (an active account or key)? */
  usable(): boolean {
    return this.creds.some((c) => !c.disabled);
  }

  call(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "accounts.list":
        return this.snapshot();
      case "accounts.link":
        return this.link(String(p.provider ?? ""));
      case "accounts.unlink": {
        const c = this.creds.find((x) => x.id === p.credentialId && x.provider === p.provider);
        if (!c) throw apiError("not_found", "that account is not linked on this host anymore");
        if (c.disabled) throw apiError("invalid_params", "omp already stopped using this account", { hint: "Link it again to use it." });
        this.creds = this.creds.filter((x) => x !== c);
        this.preferred.delete(keyOf(c));
        return this.snapshot();
      }
      case "accounts.prefer": {
        const key = String(p.key ?? "");
        const c = this.creds.find((x) => keyOf(x) === key);
        if (!c) throw apiError("not_found", "that account is not linked on this host anymore", { retryable: true });
        if (p.preferred === true) {
          const why = blocked(c);
          if (why) throw apiError("invalid_params", why);
          for (const k of [...this.preferred]) if (k.startsWith(`${c.provider}|`)) this.preferred.delete(k);
          this.preferred.add(key);
        } else this.preferred.delete(key);
        return this.snapshot();
      }
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private snapshot(): AccountsSnapshot {
    const now = this.host.now();
    const limits = this.limits(true);
    const order = (p: string) => {
      const i = DEMO_LOGIN_PROVIDERS.findIndex((x) => x.id === p);
      return i < 0 ? 1e9 : i;
    };
    const accounts: LinkedAccount[] = this.creds.map((c) => {
      const key = keyOf(c);
      const report = limits.accounts.find((a) => a.key === key);
      return {
        key,
        provider: c.provider,
        credentialId: c.id,
        kind: c.oauth ? "oauth" : "apiKey",
        label: c.label,
        org: c.org,
        plan: report?.plan ?? c.plan,
        linkedAt: c.linkedAt,
        updatedAt: c.linkedAt,
        disabled: !!c.disabled,
        disabledReason: c.disabled,
        preferred: this.preferred.has(key) && !c.disabled,
        preferBlocked: blocked(c),
        sessions: limits.sessions.filter((s) => s.accountKey === key).length,
        windows: report?.windows ?? [],
        windowsAt: report?.fetchedAt,
        windowsError: c.oauth && !c.disabled && !report?.windows.length ? (report?.error ?? "omp reported no limit windows for this account") : undefined,
      };
    });
    accounts.sort(
      (a, b) =>
        order(a.provider) - order(b.provider) ||
        Number(b.preferred) - Number(a.preferred) ||
        Number(a.disabled) - Number(b.disabled) ||
        a.label.localeCompare(b.label) ||
        (a.credentialId ?? 0) - (b.credentialId ?? 0),
    );
    const flows = this.host.auth.list().filter((f) => f.kind === "account");
    return { providers: DEMO_LOGIN_PROVIDERS, accounts, flows, fetchedAt: now };
  }

  private link(provider: string): AuthFlow {
    const p = DEMO_LOGIN_PROVIDERS.find((x) => x.id === provider);
    if (!p) throw apiError("invalid_params", `omp offers no sign-in for \`${provider}\``, { hint: "Pick a provider from the list." });
    const running = this.host.auth.list().find(
      (f) => f.kind === "account" && f.subject === provider && f.state !== "done" && f.state !== "failed" && f.state !== "cancelled" && f.state !== "expired",
    );
    if (running) return running;
    const storeAs = STORE_AS[provider] ?? provider;
    // Re-linking the provider of an expired login signs that account in again.
    const expired = this.creds.find((c) => c.provider === storeAs && c.disabled);
    const account = expired?.label ?? (this.linked === 0 ? "you@flock.dev" : `you+${this.linked + 1}@flock.dev`);
    const state = Math.abs(hashOf(`${provider}${this.host.now()}`)).toString(16).padStart(12, "0");
    const onDone = () => {
      this.linked += 1;
      if (expired) expired.disabled = undefined;
      else if (!this.creds.some((c) => c.provider === storeAs && c.label === account)) this.creds.push({ id: this.nextId++, provider: storeAs, oauth: true, label: account, linkedAt: this.host.now() });
    };
    const cb = CALLBACK_PORTS[provider];
    let script: DemoAuthScript;
    if (cb) {
      const redirect = encodeURIComponent(`http://localhost:${cb[0]}${cb[1]}`);
      script = {
        kind: "account",
        title: p.name,
        subject: provider,
        method: "browser",
        url: `https://login.example/${provider}/authorize?client_id=demo&response_type=code&redirect_uri=${redirect}&state=${state}`,
        instructions: "Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
        account,
        check: (t) => (/code=|^[\w-]{6,}(#[\w-]+)?$/.test(t) ? undefined : "that doesn't look like a sign-in code or address"),
        onDone,
      };
    } else if (DEVICE[provider]) {
      const code = `${state.slice(0, 4)}-${state.slice(4, 8)}`.toUpperCase();
      script = {
        kind: "account",
        title: p.name,
        subject: provider,
        method: "device",
        url: provider === "github-copilot" ? "https://github.com/login/device" : `https://login.example/${provider}/device`,
        userCode: provider === "cursor" ? undefined : code,
        instructions: provider === "cursor" ? "Approve the login in your browser." : `Enter code: ${code}`,
        account: provider === "github-copilot" ? undefined : account,
        onDone,
      };
    } else if (PASTE[provider]) {
      script = {
        kind: "account",
        title: p.name,
        subject: provider,
        method: "paste",
        url: `https://login.example/${provider}/authorize?client_id=demo&state=${state}`,
        instructions: "Approve the sign-in, then copy the code the page shows.",
        account,
        check: (t) => (t.length >= 6 ? undefined : "that code is too short"),
        onDone,
      };
    } else {
      const name = p.name.replace(/\s*\(.*\)\s*$/, "");
      script = {
        kind: "account",
        title: p.name,
        subject: provider,
        method: "prompt",
        url: `https://console.example/${provider}/api-keys`,
        instructions: `Create or copy your API key from the ${name} dashboard`,
        prompt: { message: `Paste your ${name} API key`, placeholder: "sk-...", secret: true },
        check: (t) => (t.length >= 8 ? undefined : `${name} rejected that key (401): it is too short to be an API key`),
        onDone: () => {
          this.creds.push({ id: this.nextId, provider: storeAs, oauth: false, label: `API key #${this.nextId}`, linkedAt: this.host.now() });
          this.nextId += 1;
        },
      };
    }
    return this.host.auth.start(script);
  }
}

function keyOf(c: Cred): string {
  return c.oauth ? `${c.provider}|email:${c.label}${c.org ? `|org:${c.org.toLowerCase()}` : ""}` : `${c.provider}|#${c.id}`;
}

function blocked(c: Cred): string | undefined {
  if (!c.oauth) return "omp prefers signed-in accounts; API keys are used in the order they were added.";
  if (c.disabled) return "Link it again first.";
  return undefined;
}

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
