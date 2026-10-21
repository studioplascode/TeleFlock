import type { WindowPace } from "@/core";
import type { LimitWindow } from "@/core/gen";
import type { Status } from "@/design";

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
