import type { LinkedAccount, LoginProvider } from "@/core/gen";

/**
 * How the app names and marks omp's login providers. omp's own names (`omp auth-broker list`) are
 * long ("ChatGPT Plus/Pro (Codex Subscription)"): the app shows a short name, and under it only
 * what that name doesn't already say (a curated blurb, or the rest of omp's name). Providers this
 * table doesn't know (newer omp) get a name derived from omp's and a hashed mark color.
 */
export interface ProviderLook {
  /** Short name: `ChatGPT`, `Claude`. */
  name: string;
  /** Mark: 1–3 letters, or one of the drawn glyphs. */
  glyph: string | "burst" | "sparkle" | "x";
  /** Mark background (CSS). */
  bg: string;
  /** What you sign in with or what it gives you, where omp's name doesn't say it (picker). */
  blurb?: string;
}

const KNOWN: Record<string, ProviderLook> = {
  "openai-codex": { name: "ChatGPT", glyph: "GPT", bg: "linear-gradient(135deg,#1fc488,#0d8a63)", blurb: "Plus or Pro plan" },
  "openai-codex-device": { name: "ChatGPT", glyph: "GPT", bg: "linear-gradient(135deg,#1fc488,#0d8a63)" },
  anthropic: { name: "Claude", glyph: "burst", bg: "linear-gradient(135deg,#e59273,#c25d3a)", blurb: "Pro or Max plan" },
  "github-copilot": { name: "GitHub Copilot", glyph: "GH", bg: "linear-gradient(135deg,#4b5260,#22262d)", blurb: "Sign in with GitHub" },
  "google-gemini-cli": { name: "Gemini CLI", glyph: "sparkle", bg: "linear-gradient(135deg,#5b8cff,#9a63f2)", blurb: "Sign in with Google" },
  "google-antigravity": { name: "Antigravity", glyph: "sparkle", bg: "linear-gradient(135deg,#2fa866,#3f7ff0)", blurb: "Gemini, Claude and GPT-OSS" },
  cursor: { name: "Cursor", glyph: "Cu", bg: "linear-gradient(135deg,#3a3a44,#131317)", blurb: "Claude, GPT and more" },
  "xai-oauth": { name: "Grok", glyph: "x", bg: "linear-gradient(135deg,#34343c,#0c0c0e)", blurb: "SuperGrok or X Premium+" },
  xai: { name: "xAI API", glyph: "x", bg: "linear-gradient(135deg,#34343c,#0c0c0e)" },
  openrouter: { name: "OpenRouter", glyph: "OR", bg: "linear-gradient(135deg,#7a7cf6,#5146d9)", blurb: "Pay-as-you-go credits" },
  zai: { name: "Z.AI", glyph: "Z", bg: "linear-gradient(135deg,#4b6bff,#2b3fd1)" },
  "zai-coding-plan": { name: "Z.AI", glyph: "Z", bg: "linear-gradient(135deg,#4b6bff,#2b3fd1)" },
  "zhipu-coding-plan": { name: "Zhipu", glyph: "Z", bg: "linear-gradient(135deg,#4b6bff,#2b3fd1)" },
  "kimi-code": { name: "Kimi Code", glyph: "K", bg: "linear-gradient(135deg,#3b3b46,#111116)" },
  moonshot: { name: "Moonshot", glyph: "K", bg: "linear-gradient(135deg,#3b3b46,#111116)" },
  deepseek: { name: "DeepSeek", glyph: "DS", bg: "linear-gradient(135deg,#5b78ff,#3550e8)" },
  "gitlab-duo": { name: "GitLab Duo", glyph: "GL", bg: "linear-gradient(135deg,#fc8a3c,#e2491b)" },
  "gitlab-duo-agent": { name: "GitLab Duo Agent", glyph: "GL", bg: "linear-gradient(135deg,#fc8a3c,#e2491b)" },
  "qwen-portal": { name: "Qwen", glyph: "Q", bg: "linear-gradient(135deg,#7b6cf6,#5340e0)" },
  "alibaba-coding-plan": { name: "Alibaba Coding Plan", glyph: "AL", bg: "linear-gradient(135deg,#ff8a3d,#f25c1f)" },
  "alibaba-token-plan": { name: "QwenCloud", glyph: "Q", bg: "linear-gradient(135deg,#7b6cf6,#5340e0)" },
  "minimax-code": { name: "MiniMax", glyph: "MM", bg: "linear-gradient(135deg,#ff5f7e,#e0294f)" },
  "minimax-code-cn": { name: "MiniMax (China)", glyph: "MM", bg: "linear-gradient(135deg,#ff5f7e,#e0294f)" },
  perplexity: { name: "Perplexity", glyph: "P", bg: "linear-gradient(135deg,#2aa1ad,#17707a)" },
  "factory-droid": { name: "Factory Droid", glyph: "FD", bg: "linear-gradient(135deg,#ff8f4a,#d9591a)" },
  devin: { name: "Devin", glyph: "D", bg: "linear-gradient(135deg,#46b7a8,#257a70)" },
  "muse-code": { name: "Muse Code", glyph: "M", bg: "linear-gradient(135deg,#4f7dff,#1f4fe0)" },
  "cloudflare-ai-gateway": { name: "Cloudflare AI Gateway", glyph: "CF", bg: "linear-gradient(135deg,#f9a03f,#e86d10)" },
  "cloudflare-workers-ai": { name: "Cloudflare Workers AI", glyph: "CF", bg: "linear-gradient(135deg,#f9a03f,#e86d10)" },
  ollama: { name: "Ollama", glyph: "OL", bg: "linear-gradient(135deg,#4a4a56,#24242c)" },
  "ollama-cloud": { name: "Ollama Cloud", glyph: "OL", bg: "linear-gradient(135deg,#4a4a56,#24242c)" },
  "lm-studio": { name: "LM Studio", glyph: "LM", bg: "linear-gradient(135deg,#5b5bd6,#3434a8)" },
  vllm: { name: "vLLM", glyph: "vL", bg: "linear-gradient(135deg,#f2b33d,#d98a10)" },
};

/** Subscriptions most people link first (in this order), shown as big tiles in the picker. */
export const POPULAR: readonly string[] = ["openai-codex", "anthropic", "github-copilot", "google-gemini-cli", "google-antigravity", "cursor", "xai-oauth", "openrouter"];

function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** omp's name without its parenthetical detail: `Fire Pass (Fireworks subscription)` → `Fire Pass`. */
export function shortOmpName(ompName: string): string {
  const s = ompName.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return s || ompName;
}

export function providerLook(id: string, ompName?: string): ProviderLook {
  const known = KNOWN[id];
  if (known) return known;
  const name = ompName ? shortOmpName(ompName) : id;
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  const glyph = (words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : name.slice(0, 2)).toUpperCase();
  const h = hue(id);
  return { name, glyph, bg: `linear-gradient(135deg,hsl(${h} 55% 52%),hsl(${(h + 30) % 360} 60% 38%))` };
}

/** Short name of a provider id (accounts are stored under ids like `openai-codex`). */
export function providerName(id: string, providers?: readonly LoginProvider[]): string {
  return providerLook(id, providers?.find((p) => p.id === id)?.name).name;
}

/**
 * What a provider's subtitle adds to its short name: the curated blurb, else omp's name minus the
 * short name (`Z.AI (GLM Coding Plan)` → `GLM Coding Plan`, `MiniMax Token Plan (International)` →
 * `Token Plan · International`); nothing when omp's name says no more than the short one.
 */
export function providerDetail(p: LoginProvider): string | undefined {
  const look = providerLook(p.id, p.name);
  if (look.blurb) return look.blurb;
  const short = look.name.toLowerCase();
  const m = p.name.trim().match(/^(.*?)\s*(?:\(([^)]*)\))?$/);
  let rest = (m?.[1] ?? "").trim();
  const stem = short.replace(/\s*\(.*\)$/, "");
  if (rest.toLowerCase().startsWith(stem)) rest = rest.slice(stem.length).trim();
  const paren = m?.[2]?.trim();
  const detail = [rest, paren && !short.includes(paren.toLowerCase()) ? paren : ""].filter(Boolean).join(" · ");
  return detail && detail.toLowerCase() !== short ? detail : undefined;
}

/** A second login omp lists for the same account, offered inside the first one's sign-in. */
export interface AlternateLogin {
  provider: LoginProvider;
  /** A device code instead of the browser (`<id>-device`). */
  device: boolean;
  /** The link that switches to it. */
  offer: string;
  /** The way back to the first login. */
  back: string;
}

/** omp's other paired logins: Z.AI's API key and its sign-in are one account (stored as `zai`). */
const TWINS: Record<string, { id: string; offer: string; back: string }> = {
  zai: { id: "zai-coding-plan", offer: "Have a Z.AI account? Sign in instead", back: "Back to the API key" },
};

/** The other login of `id`'s account, if omp lists one. */
export function alternateLogin(id: string, all: readonly LoginProvider[]): AlternateLogin | undefined {
  const device = all.find((p) => p.id === `${id}-device`);
  if (device) return { provider: device, device: true, offer: "Signing in on another device? Use a code instead", back: "Back to the browser sign-in" };
  const twin = TWINS[id];
  const other = twin && all.find((p) => p.id === twin.id);
  return twin && other ? { provider: other, device: false, offer: twin.offer, back: twin.back } : undefined;
}

/** The login whose alternate `id` is, with the way back to it. */
export function baseLogin(id: string, all: readonly LoginProvider[]): { provider: LoginProvider; back: string } | undefined {
  for (const p of all) {
    const alt = alternateLogin(p.id, all);
    if (alt?.provider.id === id) return { provider: p, back: alt.back };
  }
  return undefined;
}

export interface PickerEntry {
  provider: LoginProvider;
  /** The account's other login, offered from this one's sign-in (searched too). */
  alternate?: LoginProvider;
}

/**
 * The picker's sections: popular subscriptions first (when omp offers them), then everything else
 * in omp's order. A pair of logins to one account (`<id>-device`, Z.AI's two) is one entry.
 */
export function pickerSections(all: readonly LoginProvider[]): { popular: PickerEntry[]; rest: PickerEntry[] } {
  const hidden = new Set(all.filter((p) => baseLogin(p.id, all)).map((p) => p.id));
  const entry = (p: LoginProvider): PickerEntry => ({ provider: p, alternate: alternateLogin(p.id, all)?.provider });
  const popular = POPULAR.map((id) => all.find((p) => p.id === id)).filter((p): p is LoginProvider => !!p).map(entry);
  const taken = new Set(popular.map((e) => e.provider.id));
  const rest = all.filter((p) => !taken.has(p.id) && !hidden.has(p.id)).map(entry);
  return { popular, rest };
}

/**
 * The order a provider's accounts are listed in: working ones by when they were linked (oldest
 * first, like omp uses keys), those only the usage report knows after them, expired logins last.
 * Unlike omp's own order it ignores the preference, so preferring one moves no row.
 */
export function byListOrder(a: LinkedAccount, b: LinkedAccount): number {
  return (
    Number(a.disabled) - Number(b.disabled) ||
    (a.linkedAt ?? Number.POSITIVE_INFINITY) - (b.linkedAt ?? Number.POSITIVE_INFINITY) ||
    a.label.localeCompare(b.label) ||
    (a.credentialId ?? 0) - (b.credentialId ?? 0)
  );
}

/** Matches the picker search against the short name, omp's name and the id. */
export function matchesProvider(p: LoginProvider, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [p.id, p.name, providerLook(p.id, p.name).name].some((s) => s.toLowerCase().includes(needle));
}

/** The login that links another account of a stored provider (`openai-codex` for both of its logins). */
export function linkProviderFor(storedAs: string, all: readonly LoginProvider[]): string | undefined {
  if (all.some((p) => p.id === storedAs)) return storedAs;
  return all.find((p) => p.id.startsWith(`${storedAs}-`))?.id;
}
