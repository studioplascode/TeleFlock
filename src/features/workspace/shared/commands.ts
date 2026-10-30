import type { AgentSpec } from "@/core/gen";
import type { PreviewLine } from "./CommandPreview";
import { shellQuote } from "./paths";

/** `herdr --session S` prefix (omitted for the default session, like herdr itself). */
export function herdrArgv(session: string | undefined, ...rest: (string | false | undefined)[]): string[] {
  const argv = ["herdr"];
  if (session && session !== "default") argv.push("--session", shellQuote(session));
  for (const a of rest) if (a) argv.push(a);
  return argv;
}

/**
 * The launch recipe from `docs/architecture.md` §3.7, plus the follow-ups tf-hostd performs once
 * the agent is idle and linked (plan mode, initial prompt). The overlay and bridge live in
 * tf-hostd's home on the host (`~/.teleflock` unless `TF_HOSTD_HOME` moves it), which this app
 * does not know: the preview names it instead of guessing a path. An agent with roles or fallback
 * chains of its own gets its own overlay after TeleFlock's; its own `default` role replaces
 * `--model` / `--thinking`.
 */
export function agentLaunchLines(session: string | undefined, spec: AgentSpec, pane: string, opts: { name: string; resumeFile?: string }): PreviewLine[] {
  const own = Object.keys(spec.roleModels ?? {}).length > 0 || Object.keys(spec.fallbackChains ?? {}).length > 0;
  const ownDefault = spec.roleModels?.default !== undefined;
  const lines: PreviewLine[] = [
    {
      argv: herdrArgv(
        session,
        "agent",
        "start",
        shellQuote(opts.name),
        "--kind",
        spec.kind,
        "--pane",
        pane,
        "--",
        "--config",
        "<tf-hostd home>/omp-overlay.yml",
        ...(own ? ["--config", "<tf-hostd home>/agent-config/<this agent>.yml"] : []),
        "-e",
        "<tf-hostd home>/ext/teleflock-bridge.ts",
        ...(spec.model && !ownDefault ? ["--model", shellQuote(spec.model)] : []),
        ...(spec.thinking && !ownDefault ? ["--thinking", spec.thinking] : []),
        ...(opts.resumeFile ? [`--resume=${shellQuote(opts.resumeFile)}`] : []),
      ),
    },
  ];
  if (spec.plan) lines.push({ note: "once the agent is ready", argv: ["/plan"] });
  if (spec.prompt) {
    const short = spec.prompt.length > 120 ? `${spec.prompt.slice(0, 117)}…` : spec.prompt;
    lines.push({ note: spec.plan ? undefined : "once the agent is ready", argv: ["prompt", shellQuote(short.replace(/\s+/g, " "))] });
  }
  return lines;
}
