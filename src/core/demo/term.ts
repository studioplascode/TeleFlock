import type { TermEvent, TermMode } from "@/core/gen";
import { base64Utf8 } from "./rng";

const G = "\x1b[32m";
const C = "\x1b[36m";
const Y = "\x1b[33m";
const M = "\x1b[35m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[31m";
const X = "\x1b[0m";

export interface TermContext {
  hostname: string;
  cwd: string;
  branch?: string;
  /** `herdr agent list` rows. */
  agents(): { name: string; state: string; pane: string }[];
  /** `herdr server stop`: the host's herdr server goes away (the incident, in the demo). */
  stopHerdr?(): void;
  gitStatus(): string[];
  /** Agent terminal: submit a line as a prompt. */
  prompt?(text: string): void;
  /** Agent terminal: abort (Ctrl+C / Esc). */
  abort?(): void;
  /** Agent terminal: current TUI render. */
  render?(rows: number): string;
  /** Shell terminal: a program in the foreground (its screen, until Ctrl+C returns to the prompt). */
  program?: { lines: string[]; exit(): void };
  after(ms: number, cb: () => void): void;
}

/**
 * A simulated terminal: a small interactive shell, or an omp-like TUI mirror for agent panes.
 * Emits xterm-ready base64 ANSI frames through `emit`.
 */
export class DemoTerm {
  private seq = 0;
  private line = "";
  private closed = false;
  private busy = false;
  /** A seeded program owns the screen (`ctx.program`). */
  private foreground = false;
  title: string;

  constructor(
    readonly termId: string,
    readonly paneId: string,
    readonly agentId: string | undefined,
    readonly mode: TermMode,
    public cols: number,
    public rows: number,
    private readonly ctx: TermContext,
    private readonly emit: (ev: TermEvent) => void,
  ) {
    this.title = agentId ? `omp · ${agentId}` : `${ctx.hostname}: ${ctx.cwd.replace("/home/demo", "~")}`;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private frame(text: string, full = false): void {
    if (this.closed) return;
    this.emit({ k: "frame", seq: ++this.seq, full, cols: this.cols, rows: this.rows, data: base64Utf8(full ? `\x1b[H\x1b[2J${text}` : text) });
  }

  private prompt(): string {
    const dir = this.ctx.cwd.replace("/home/demo", "~");
    const br = this.ctx.branch ? ` ${M}${this.ctx.branch}${X}` : "";
    return `${C}${dir}${X}${br}\r\n${G}❯${X} `;
  }

  start(): void {
    this.emit({ k: "title", title: this.title });
    if (this.agentId) {
      const body = this.ctx.render?.(this.rows) ?? "";
      this.frame(`${D}omp 18.12.3 · collab live · ${this.ctx.cwd.replace("/home/demo", "~")}${X}\r\n${body}\r\n`, true);
    } else if (this.ctx.program) {
      this.foreground = true;
      this.frame(this.ctx.program.lines.join("\r\n"), true);
    } else {
      this.frame(`${D}herdr 0.9.0 · ${this.ctx.hostname} · demo shell (type ${B}help${X}${D})${X}\r\n\r\n${this.prompt()}`, true);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.agentId) {
      this.frame(`${this.ctx.render?.(rows) ?? ""}\r\n`, true);
    } else if (this.foreground && this.ctx.program) {
      this.frame(this.ctx.program.lines.join("\r\n"), true);
    } else {
      this.frame(`${this.prompt()}${this.line}`, true);
    }
  }

  /** Output from the agent this terminal mirrors. */
  agentOutput(text: string): void {
    if (this.agentId) this.frame(text);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ k: "closed", reason });
  }

  input(data: string): void {
    if (this.closed || this.mode === "observe") return;
    // A bracketed paste (the terminal pastes uploaded files' paths this way): like herdr for a pane
    // that never turned bracketed paste on, the demo shell gets the bare text.
    const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
    if (pasted) data = pasted[1] ?? "";
    if (this.foreground) {
      // Only Ctrl+C reaches a seeded program: it ends, and the shell prompt comes back.
      if (!data.includes("\x03")) return;
      this.foreground = false;
      this.ctx.program?.exit();
      this.frame(`^C\r\n${this.prompt()}`);
      return;
    }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const cmd = this.line;
        this.line = "";
        this.frame("\r\n");
        if (this.agentId) {
          if (cmd.trim()) this.ctx.prompt?.(cmd.trim());
        } else this.run(cmd.trim());
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          this.frame("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        if (this.agentId) this.ctx.abort?.();
        this.frame(`^C\r\n${this.agentId ? "" : this.prompt()}`);
        this.busy = false;
      } else if (ch === "\x1b") {
        if (this.agentId && data === "\x1b") this.ctx.abort?.();
        return; // escape sequences (arrows) are ignored by the demo shell
      } else if (ch === "\x0c") {
        this.frame(this.prompt(), true);
      } else if (ch >= " ") {
        this.line += ch;
        this.frame(ch);
      }
    }
  }

  private out(lines: string[], done = true): void {
    this.frame(`${lines.join("\r\n")}${lines.length ? "\r\n" : ""}${done ? this.prompt() : ""}`);
  }

  private stream(lines: string[], everyMs: number): void {
    this.busy = true;
    let i = 0;
    const next = () => {
      if (this.closed || !this.busy) return;
      if (i >= lines.length) {
        this.busy = false;
        this.frame(this.prompt());
        return;
      }
      this.frame(`${lines[i++]}\r\n`);
      this.ctx.after(everyMs, next);
    };
    next();
  }

  private run(cmd: string): void {
    if (this.busy) return;
    const [name, ...args] = cmd.split(/\s+/);
    switch (name) {
      case "":
        this.out([]);
        break;
      case "help":
        this.out([`${B}demo shell${X} — try: ls, pwd, git status, git log, herdr agent list, bun test, top, echo, date, whoami, clear, exit`]);
        break;
      case "pwd":
        this.out([this.ctx.cwd]);
        break;
      case "whoami":
        this.out(["demo"]);
        break;
      case "date":
        this.out([new Date().toString()]);
        break;
      case "echo":
        this.out([args.join(" ")]);
        break;
      case "clear":
        this.frame(this.prompt(), true);
        break;
      case "ls":
        this.out([`${C}src${X}  ${C}docs${X}  ${C}tests${X}  package.json  README.md  bun.lock  tsconfig.json`]);
        break;
      case "git":
        if (args[0] === "status") this.out(this.ctx.gitStatus());
        else if (args[0] === "log")
          this.out([`${Y}4be91a7${X} (HEAD -> ${this.ctx.branch ?? "main"}) tighten edge cases`, `${Y}8c1d2e0${X} add lane persistence`, `${Y}31f0a9b${X} ${D}(origin/main)${X} merge #139 README`]);
        else this.out([`${R}git: '${args[0] ?? ""}' is not available in the demo shell${X}`]);
        break;
      case "herdr":
        if (args[0] === "agent" && args[1] === "list") {
          const rows = this.ctx.agents();
          this.out([`${D}NAME       STATE    PANE${X}`, ...rows.map((r) => `${r.name.padEnd(10)} ${colorState(r.state)}${" ".repeat(Math.max(1, 9 - r.state.length))}${r.pane}`)]);
        } else if (args[0] === "server" && args[1] === "stop" && this.ctx.stopHerdr) {
          this.ctx.stopHerdr();
          this.out([`${D}herdr server stopped${X}`]);
        } else this.out([`herdr 0.9.0 — try ${B}herdr agent list${X}`]);
        break;
      case "bun":
        if (args[0] === "test") {
          this.stream(
            [
              `bun test v1.4.3`,
              ``,
              `${G}✓${X} columns.test.ts ${D}(6)${X}`,
              `${G}✓${X} persist.test.ts ${D}(9)${X}`,
              `${G}✓${X} drag-drop.test.ts ${D}(12)${X}`,
              `${G}✓${X} keyboard-move.test.ts ${D}(6)${X}`,
              `${G}✓${X} lane-order.test.ts ${D}(4)${X}`,
              ``,
              `${G}${B}37 pass${X} ${D}· 0 fail · 1.71s${X}`,
            ],
            220,
          );
        } else if (args[0] === "run" && args[1] === "dev") {
          this.stream([`$ vite`, ``, `  ${G}VITE v8.0.2${X}  ready in 412 ms`, ``, `  ➜  Local:   ${C}http://localhost:5173/${X}`], 300);
        } else this.out([`bun 1.4.3 — try ${B}bun test${X} or ${B}bun run dev${X}`]);
        break;
      case "top":
        this.out([`load average: 2.14, 1.87, 1.66 · 15 cores · 62 GB`, `  PID USER   %CPU %MEM COMMAND`, `41212 demo   38.2  1.4 omp`, `41388 demo   21.7  0.9 bun test`, `40021 demo    3.1  0.2 herdr`]);
        break;
      case "exit":
        this.frame("logout\r\n");
        this.close("shell exited");
        break;
      default:
        this.out([`${R}${name}: command not found${X} ${D}(demo shell — type help)${X}`]);
    }
  }
}

function colorState(s: string): string {
  if (s === "working") return `\x1b[38;5;111m${s}${X}`;
  if (s === "blocked") return `${Y}${s}${X}`;
  if (s === "done") return `${C}${s}${X}`;
  return `${D}${s}${X}`;
}
