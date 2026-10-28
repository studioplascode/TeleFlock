import { describePace, type WindowPace } from "@/core";
import type { LimitWindow } from "@/core/gen";
import type { Status } from "@/design";

/**
 * How subscription accounts and their quota windows read wherever the app lists them (Accounts,
 * Usage, the session inspector and header): provider names, plan names, window names, the bar's
 * tint and the reason behind it, and the expired-login message. One vocabulary, so the same
 * account says the same thing on every page.
 */

/** Display names of omp provider ids that report subscription limits. */
export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "ChatGPT · Codex",
  "github-copilot": "GitHub Copilot",
  "google-gemini-cli": "Gemini CLI",
  "google-antigravity": "Antigravity",
  cursor: "Cursor",
  "xai-oauth": "xAI",
  zai: "Z.ai",
  kimi: "Kimi",
  "minimax-code": "MiniMax",
};

/** Bar / text tint: exhausted → error, runs out or omp's warning → needs-you, otherwise done. */
export function paceStatus(w: LimitWindow, pace: WindowPace): Status {
  if (pace.outcome === "exhausted" || w.status === "exhausted") return "error";
  if (pace.outcome === "runsOut" || w.status === "warning") return "needs-you";
  if (pace.used == null) return "idle";
  return "done";
}

/** Why a window is in trouble: shown in its status colour beside the bar, never as a coloured number. */
export interface PaceAlert {
  status: Status;
  /** For compact rows: "runs out in ~4d at this pace", "limit reached". */
  short: string;
  /** The sentence Usage shows ({@link describePace}): tooltips and screen readers of compact rows. */
  full: string;
}

/** The alert of a window that is used up, or will be before it resets at the current pace. */
export function paceAlert(w: LimitWindow, pace: WindowPace): PaceAlert | undefined {
  // omp's own "exhausted" counts too, unless the window has reset since that reading.
  if (pace.outcome === "exhausted" || (w.status === "exhausted" && pace.outcome !== "reset"))
    return { status: "error", short: "limit reached", full: describePace({ ...pace, outcome: "exhausted" }) };
  if (pace.outcome === "runsOut") return { status: "needs-you", short: `runs out in ~${formatSpanShort(pace.etaMs ?? 0)} at this pace`, full: describePace(pace) };
  return undefined;
}

/** A span in its largest unit, rounded down ("4d 13h" → "4d", "2h 50m" → "2h", at least "1m"). */
export function formatSpanShort(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const UNITS: readonly [RegExp, string, string][] = [
  [/^(m|mins?|minutes?)$/i, "minute", "minutes"],
  [/^(h|hrs?|hours?)$/i, "hour", "hours"],
  [/^(d|days?)$/i, "day", "days"],
  [/^(w|wks?|weeks?)$/i, "week", "weeks"],
  [/^(mo|months?)$/i, "month", "months"],
];

function duration(n: number, unit: string): string | undefined {
  const u = UNITS.find(([re]) => re.test(unit));
  return u ? `${n} ${n === 1 ? u[1] : u[2]}` : undefined;
}

/**
 * A quota window's name as both pages show it, whatever casing the provider reports through
 * `omp usage --json`: "5 Hour" / "5 hours" / "5h" → "5 hours", "7 Day" → "7 days", "30 min" →
 * "30 minutes"; other window names capitalised ("weekly" → "Weekly"); without one, the duration
 * named in the label ("Claude 5 Hour") or the window's length; else the label as reported.
 */
export function windowLabel(w: Pick<LimitWindow, "window" | "label" | "durationMs">): string {
  const raw = w.window?.trim();
  if (raw) {
    const m = raw.match(/^(\d+)\s*([a-z]+)$/i);
    const named = m ? duration(Number(m[1]), m[2] ?? "") : undefined;
    return named ?? raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  for (const m of w.label.matchAll(/\b(\d+)\s*([a-z]+)\b/gi)) {
    const named = duration(Number(m[1]), m[2] ?? "");
    if (named) return named;
  }
  const d = w.durationMs;
  if (d && d % 86_400_000 === 0) return `${d / 86_400_000} day${d === 86_400_000 ? "" : "s"}`;
  if (d && d % 3_600_000 === 0) return `${d / 3_600_000} hour${d === 3_600_000 ? "" : "s"}`;
  return w.label;
}

/** The model tier a window is limited to: "opus" → "Opus only". */
export function tierLabel(w: Pick<LimitWindow, "tier">): string | undefined {
  const t = w.tier?.trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)} only` : undefined;
}

/**
 * A plan as providers report it, in one casing: "pro" → "Pro", "max_20x" / Claude's
 * "default_claude_max_20x" → "Max 20x", Codex's "prolite" → "Pro Lite"; names with capitals
 * ("OpenCode Go") keep them.
 */
export function formatPlan(plan: string): string {
  const words = plan
    .trim()
    .replace(/^default_(claude_)?/i, "")
    .replace(/^prolite$/i, "pro lite")
    .split(/[\s_-]+/)
    .filter(Boolean);
  return words.map((w) => (/^\d+x$/i.test(w) ? w.toLowerCase() : w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

/** An expired login, as Accounts and Usage both say it. */
export interface ExpiredLoginText {
  /** What happened, in plain words. */
  title: string;
  /** What to do about it. */
  action: string;
  /** omp's own reason (`oauth refresh failed: invalid_grant …`), for the curious. */
  detail?: string;
}

/**
 * omp stopped using a login (it disables a credential whose refresh fails or was revoked): one
 * friendly sentence; omp's raw cause (hostd prefixes the usage report's with "Disabled by omp:")
 * stays available as the detail.
 */
export function expiredLogin(provider: string, reason: string | undefined): ExpiredLoginText {
  const detail = reason?.replace(/^disabled by omp:\s*/i, "").trim() || undefined;
  const expired = !!detail && /invalid_grant|refresh|expired|revoked|unauthori[sz]ed|\b40[13]\b/i.test(detail);
  return { title: expired ? `This login expired: ${provider} no longer accepts it.` : "omp stopped using this login.", action: "Sign in again to bring it back.", detail };
}
