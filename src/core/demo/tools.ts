/**
 * Demo tool updates (`HostInfo.tools`, `host.toolsUpdate`, `host.toolsConfig`): forge has an omp
 * update waiting (auto on; its first automatic run installs it 2 minutes after start), studio-pc
 * has auto updates off and a Homebrew-managed herdr with a newer release. Checks take ~1.2 s per
 * tool, installs ~3.5 s; concurrent requests join the running one, like tf-hostd.
 */
import type { ToolUpdate, ToolUpdates } from "../gen";
import { apiError } from "../errors";
import type { DemoClock } from "./clock";

const MIN = 60_000;
const EVERY = 6 * 60 * MIN;
const CHECK_MS = 1200;
const INSTALL_MS = 3500;

type Tool = "omp" | "herdr";

interface Release {
  /** Newest published version. */
  latest: string;
  /** Package-manager note: the demo can't install it. */
  managed?: string;
}

export class DemoTools {
  private s: ToolUpdates;
  private readonly releases: Record<Tool, Release>;
  private running: { install: boolean; tools: Tool[]; done: Promise<void> } | null = null;
  private cancelNext: (() => void) | null = null;

  constructor(
    variant: "forge" | "studio",
    private readonly clock: DemoClock,
    /** Called with the new status after every change (the host patches `HostInfo.tools`). */
    private readonly onChange: (tools: ToolUpdates, installed: Tool | null) => void,
  ) {
    const now = clock.now();
    const tool = (name: Tool, current: string, extra: Partial<ToolUpdate> = {}): ToolUpdate => ({ tool: name, current, checkedAt: now - 3 * MIN, updating: false, ...extra });
    if (variant === "forge") {
      this.releases = { omp: { latest: "18.12.6" }, herdr: { latest: "0.9.0" } };
      this.s = { auto: true, omp: tool("omp", "18.12.3", { latest: "18.12.6" }), herdr: tool("herdr", "0.9.0", { updatedAt: now - 26 * 60 * MIN }), nextCheckAt: now + 2 * MIN };
    } else {
      const managed = "Installed with Homebrew: run `brew update && brew upgrade herdr`.";
      this.releases = { omp: { latest: "18.12.3" }, herdr: { latest: "0.9.5", managed } };
      this.s = { auto: false, omp: tool("omp", "18.12.3"), herdr: tool("herdr", "0.9.0", { latest: "0.9.5", note: managed }) };
    }
    this.schedule();
  }

  status(): ToolUpdates {
    return this.s;
  }

  stop(): void {
    this.cancelNext?.();
  }

  async call(method: string, p: Record<string, unknown>): Promise<ToolUpdates> {
    if (method === "host.toolsConfig") {
      if (typeof p.auto !== "boolean") throw apiError("invalid_params", "missing auto");
      this.s = { ...this.s, auto: p.auto, nextCheckAt: p.auto ? this.clock.now() + 2 * MIN : undefined };
      this.schedule();
      this.onChange(this.s, null);
      return this.s;
    }
    const tool = p.tool;
    if (tool !== undefined && tool !== "omp" && tool !== "herdr") throw apiError("invalid_params", `unknown tool \`${String(tool)}\` (omp | herdr)`);
    const tools: Tool[] = tool === undefined ? ["omp", "herdr"] : [tool];
    await this.run(tools, p.checkOnly !== true);
    return this.s;
  }

  /** Runs (or joins the running run when it covers the request). */
  private run(tools: Tool[], install: boolean): Promise<void> {
    const r = this.running;
    if (r && (r.install || !install) && tools.every((t) => r.tools.includes(t))) return r.done;
    // Idle: start now (the spinner shows at once); otherwise queue behind the running one.
    const done = r ? r.done.then(() => this.execute(tools, install)) : this.execute(tools, install);
    this.running = { install, tools, done };
    void done.then(() => {
      if (this.running?.done === done) this.running = null;
    });
    return done;
  }

  private async execute(tools: Tool[], install: boolean): Promise<void> {
    // Executor form (demo clock): tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    for (const name of tools) {
      this.patch(name, { updating: true });
      await new Promise<void>((resolve) => this.clock.after(CHECK_MS, resolve));
      const t = this.s[name];
      const rel = this.releases[name];
      const now = this.clock.now();
      if (rel.latest === t.current) {
        this.patch(name, { updating: false, checkedAt: now, latest: undefined, error: undefined, note: t.note?.startsWith("The herdr server") ? t.note : undefined });
        continue;
      }
      if (!install || rel.managed) {
        this.patch(name, { updating: false, checkedAt: now, latest: rel.latest, error: undefined, note: rel.managed });
        continue;
      }
      await new Promise<void>((resolve) => this.clock.after(INSTALL_MS, resolve));
      const old = t.current ?? "?";
      const note = name === "omp" ? `Agents already running keep omp ${old} until they restart.` : `The herdr server keeps running ${old} until it restarts; agents keep running.`;
      this.patch(name, { updating: false, checkedAt: now, updatedAt: this.clock.now(), current: rel.latest, latest: undefined, error: undefined, note }, name);
    }
  }

  private schedule(): void {
    this.cancelNext?.();
    this.cancelNext = null;
    const at = this.s.auto ? this.s.nextCheckAt : undefined;
    if (at === undefined) return;
    this.cancelNext = this.clock.after(Math.max(0, at - this.clock.now()), () => {
      void this.run(["omp", "herdr"], true).then(() => {
        if (!this.s.auto) return;
        this.s = { ...this.s, nextCheckAt: this.clock.now() + EVERY };
        this.onChange(this.s, null);
        this.schedule();
      });
    });
  }

  private patch(name: Tool, change: Partial<ToolUpdate>, installed: Tool | null = null): void {
    this.s = { ...this.s, [name]: { ...this.s[name], ...change } };
    this.onChange(this.s, installed);
  }
}
