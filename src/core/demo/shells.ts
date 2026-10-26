import type { PaneInfo, Workspace } from "@/core/gen";

/** The parts of a demo workspace model this module touches. */
interface ShellHost {
  ws: Workspace;
  path: string;
  shellPanes: string[];
}

/** A program running in a demo shell pane: what herdr reports as its foreground process, its title and screen. */
interface Program {
  title: string;
  screen(cwd: string): string[];
}

const G = "\x1b[32m";
const C = "\x1b[36m";
const D = "\x1b[2m";
const B = "\x1b[1m";
const Y = "\x1b[33m";
const X = "\x1b[0m";

const PROGRAMS: Record<string, Program> = {
  bun: {
    title: "bun run dev",
    screen: () => [
      `${D}$ vite --port 5173${X}`,
      "",
      `  ${G}${B}VITE${X} ${G}v7.1.4${X}  ready in ${B}412${X} ms`,
      "",
      `  ${G}➜${X}  ${B}Local${X}:   ${C}http://localhost:5173/${X}`,
      `  ${D}➜  Network: use --host to expose${X}`,
      "",
      `${D}12:41:07${X} ${C}[vite]${X} hmr update ${D}/src/features/board/AgentCard.tsx${X}`,
    ],
  },
  tail: {
    title: "tail -f logs/gateway.log",
    screen: () => [
      `${D}2026-10-25T12:40:58Z${X} INFO  pool: 12/64 connections busy`,
      `${D}2026-10-25T12:41:02Z${X} INFO  GET /v1/models 200 4ms`,
      `${D}2026-10-25T12:41:03Z${X} ${Y}WARN${X}  upstream eu-2 slow (812ms)`,
      `${D}2026-10-25T12:41:05Z${X} INFO  POST /v1/chat 200 1.2s`,
    ],
  },
  htop: {
    title: "htop",
    screen: () => [
      `  ${C}CPU${X}[${G}||||||||${X}                 23.4%]   ${C}Tasks${X}: 142, 3 running`,
      `  ${C}Mem${X}[${G}||||||||||||${X}          5.81G/15.5G]   ${C}Load average${X}: 0.82 0.71 0.64`,
      "",
      `${B}    PID USER      PRI  NI  VIRT   RES  CPU% MEM%   TIME+  Command${X}`,
      "   4894 demo       20   0 1.2G  210M   6.1  1.3  4:12.07 herdr server",
      "   5121 demo       20   0 3.4G  480M  12.4  3.0  9:44.51 omp",
      "   5302 demo       20   0  98M   41M   0.7  0.3  0:02.18 tf-hostd",
    ],
  },
  python3: {
    title: "python3",
    screen: () => ["Python 3.13.1 (main) [GCC 14.2.0] on linux", 'Type "help", "copyright", "credits" or "license" for more information.', ">>> "],
  },
  vim: {
    title: "vim notes.md",
    screen: () => ["# Notes", "", "- pool: cap retries at 3", "- ship the board polish", `${D}~${X}`, `${D}~${X}`, `${B}"notes.md" 4L, 58B${X}`],
  },
};

/** Extra shell panes per variant and workspace: herdr tab, program (absent: an idle zsh), subfolder. */
const SHELLS: Record<string, Record<string, { tab: string; program?: string; sub?: string }[]>> = {
  forge: {
    w1: [{ tab: "dev", program: "bun" }, { tab: "dev" }],
    w2: [{ tab: "logs", program: "tail" }],
    w10: [{ tab: "ops", program: "htop" }, { tab: "ops", sub: "terraform" }],
    w12: [{ tab: "main", program: "python3" }],
  },
  studio: {
    w1: [{ tab: "dev", program: "bun" }, { tab: "dev", program: "vim", sub: "docs" }],
  },
};

/** Seeds plain shell panes (some running programs) next to the agents, so pane lists have shells to show. */
export function seedDemoShells(variant: string, models: Iterable<ShellHost>): void {
  for (const m of models) {
    const defs = SHELLS[variant]?.[m.ws.id] ?? [];
    defs.forEach((d, i) => {
      let tab = m.ws.tabs.find((t) => t.label === d.tab);
      if (!tab) {
        tab = { id: `${m.ws.id}:t${m.ws.tabs.length + 1}`, label: d.tab, panes: [] };
        m.ws.tabs.push(tab);
      }
      const id = `${m.ws.id}:p${100 + i}`;
      const program = d.program ? PROGRAMS[d.program] : undefined;
      tab.panes.push({
        id,
        terminalId: `term-${id.replace(":", "-")}`,
        title: program?.title ?? "zsh",
        cwd: d.sub ? `${m.path}/${d.sub}` : m.path,
        focused: false,
        process: d.program ?? "zsh",
      });
      m.shellPanes.push(id);
    });
  }
}

/** Published panes report a foreground process like hostd's: omp in agent panes, zsh in the demo's plain shells. */
export function withPaneProcesses(ws: Workspace): Workspace {
  for (const tab of ws.tabs) for (const p of tab.panes) if (!p.process && (p.title === "omp" || p.title === "zsh")) p.process = p.title;
  return ws;
}

/** The program a demo shell pane runs (its screen, until Ctrl+C returns to zsh), if any. */
export function demoProgram(m: ShellHost, paneId: string, changed: () => void): { lines: string[]; exit(): void } | undefined {
  const pane: PaneInfo | undefined = m.ws.tabs.flatMap((t) => t.panes).find((p) => p.id === paneId);
  const program = pane?.process ? PROGRAMS[pane.process] : undefined;
  if (!pane || !program) return undefined;
  return {
    lines: program.screen(pane.cwd ?? m.path),
    exit: () => {
      pane.process = "zsh";
      pane.title = "zsh";
      changed();
    },
  };
}
