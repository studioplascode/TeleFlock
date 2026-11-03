/**
 * The TeleFlock Browser on a demo host (`?demo`), tf-hostd's side: which agents may drive a device's
 * browser (`Agent.browser.attached`), their `use_user_browser` requests (`Agent.browser.request` and a
 * needs-you with `browser`), and how a request ends for the agent. The demo's app core
 * (`./browser`) attaches, detaches and answers through it, as the real one does with
 * `agent.browserAttach`, `agent.browserDetach` and `agent.browserAnswer`. studio-pc plays a tf-hostd
 * before 0.9.0, without the browser.
 */
import type { ActivityKind, BrowserScope, NeedsYou } from "@/core/gen";
import { apiError } from "../errors";
import type { AgentSim } from "./agent";
import { type AgentDef, HOME } from "./data";
import { bash, say, type Step, think } from "./scripts";

/** What the browser's host side needs from its DemoHost (closures over the host's state). */
export interface BrowserAgentsHost {
  /** This host's tf-hostd has the browser (0.9.0 or later). */
  supported(): boolean;
  now(): number;
  sims: Map<string, AgentSim>;
  seedSim(def: AgentDef, workspaceId: string): AgentSim;
  changed(agentId: string): void;
  activity(agentId: string, kind: ActivityKind, title: string, detail?: string): void;
}

/** A pending request on this board, as the app core reads it from the host's state. */
export interface DemoBrowserAsk {
  id: string;
  agentId: string;
  agentName: string;
  reason: string;
  at: number;
}

/** The needs-you of a `use_user_browser` request (tf-hostd `browser_needs`). */
export function browserNeeds(requestId: string, reason: string, since: number): NeedsYou & { requestId: string } {
  return {
    kind: "confirm",
    requestId,
    since,
    title: "Use your browser?",
    question: reason,
    detail: "It asks to drive your TeleFlock Browser, where you are signed in as yourself. Allow it on the computer whose browser it should use.",
    options: [
      { id: "session", label: "Allow for this session", description: "Until you detach it", recommended: false, tone: "primary" },
      { id: "turn", label: "Allow once", description: "Until this turn ends", recommended: false, tone: "neutral" },
      { id: "deny", label: "Deny", description: "The agent is told you said no", recommended: false, tone: "danger" },
    ],
    multi: false,
    allowOther: false,
    allowChat: false,
    answerable: true,
    browser: true,
  };
}

/** The bridge's tool result (`browserToolText`), shortened to its first line. */
function toolText(allowed: boolean, scope: BrowserScope): string {
  if (!allowed) return "The user declined: you may not use their TeleFlock Browser. Go on without it (your own browser still works for public pages) or tell the user why you need it; do not ask again unless they ask you to.";
  return `The user allowed you to use their TeleFlock Browser ${scope === "turn" ? "until this turn ends" : "for this session, until they detach it"}.`;
}

/** The agent that asks on `?demo`: its task needs the user's mail login. */
const ASKER: AgentDef = {
  id: "expenses",
  kind: "omp",
  workspace: "w12",
  column: "needs",
  model: "sonnet-5",
  thinking: "medium",
  since: 95,
  age: 540,
  ctxPct: 8,
  cost: 0.21,
  title: "Collect October's invoices for the expense report",
  files: [],
};
const ASKER_REASON = "To download October's invoices from your Example Mail inbox, where you're signed in. I'll only read and download: no mail sent, no settings changed.";

const ASKER_HISTORY: Step[] = [
  { t: "user", text: "Collect October's invoices (Example Cloud, Example CI, Example Shop) into ~/scratch/expenses and total them in totals.csv" },
  think("The invoices arrive by mail as PDF attachments, and the inbox needs the user's login. Asking for their browser beats asking for a password.", 2200),
  bash("mkdir -p ~/scratch/expenses", [], 400),
  say("The invoices are in your Example Mail inbox, which needs your login. I'll ask to use your browser for it."),
];

function askerTurn(allowed: boolean): Step[] {
  if (!allowed) return [say("Understood, I won't use your browser. Save the October invoices to `~/scratch/expenses` and I'll total them in `totals.csv`.")];
  return [
    think("Allowed. Opening the inbox in a tab of my own and downloading the three October invoices.", 1800),
    {
      t: "tool",
      spec: {
        tool: "browser",
        title: "open https://mail.example.com/inbox",
        intent: "The inbox, in a tab of my own",
        args: { action: "open", url: "https://mail.example.com/inbox" },
        ms: 7000,
        output: ["Inbox (3) – Example Mail", "3 messages from October with PDF attachments"],
      },
    },
    {
      t: "tool",
      spec: {
        tool: "browser",
        title: "download 3 attachments",
        intent: "Save each invoice PDF",
        args: { action: "download", into: `${HOME}/scratch/expenses` },
        ms: 9000,
        output: ["example-cloud-2026-10.pdf  212 KB", "example-ci-2026-10.pdf  48 KB", "example-shop-2026-10.pdf  61 KB"],
      },
    },
    { t: "tool", spec: { tool: "write", title: "totals.csv", intent: "Totals per vendor", args: { path: `${HOME}/scratch/expenses/totals.csv` }, ms: 900 } },
    say("Done: three October invoices in `~/scratch/expenses` (Example Cloud $1,284.50, Example CI $96.00, Example Shop $42.17) and the totals in `totals.csv`: **$1,422.67**. I only read and downloaded; nothing was sent or changed."),
  ];
}

export class DemoBrowserAgents {
  /** The port tf-hostd listens on for each agent (kept when it attaches again). */
  private readonly ports = new Map<string, number>();
  private nextPort = 9301;
  private nextAsk = 1;

  constructor(private readonly host: BrowserAgentsHost) {}

  /** This host's tf-hostd has the browser (wire feature `browser`). */
  get available(): boolean {
    return this.host.supported();
  }

  /** `?demo` (the demo backend): quota and ci drive `device`'s browser (unless not `attach`: it couldn't start), expenses asks for it. Returns the attachments made. */
  seed(device: string, attach = true): { agentId: string; port: number; since: number }[] {
    if (!this.host.supported()) return [];
    const now = this.host.now();
    const out: { agentId: string; port: number; since: number }[] = [];
    for (const [agentId, ago] of attach ? ([["quota", 1_260_000], ["ci", 610_000]] as const) : []) {
      const sim = this.host.sims.get(agentId);
      if (!sim) continue;
      const port = this.nextPort++;
      const since = now - ago;
      this.ports.set(agentId, port);
      sim.agent.browser = { attached: { device, since, scope: "session" } };
      out.push({ agentId, port, since });
    }
    const sim = this.host.seedSim(ASKER, ASKER.workspace);
    const asked = now - ASKER.since * 1000;
    sim.seed(ASKER_HISTORY, now - ASKER.age * 1000, asked);
    sim.askBrowser(browserNeeds(`browser-${ASKER.id}-${this.nextAsk++}`, ASKER_REASON, asked), askerTurn, false);
    return out;
  }

  /** The pending requests on this board. */
  requests(): DemoBrowserAsk[] {
    const out: DemoBrowserAsk[] = [];
    for (const sim of this.host.sims.values()) {
      const q = sim.agent.browser?.request;
      if (q) out.push({ id: q.id, agentId: sim.agent.id, agentName: sim.agent.name, reason: q.reason, at: q.at });
    }
    return out;
  }

  /** The agent whose pending request `requestId` is. */
  asker(requestId: string): AgentSim | undefined {
    for (const sim of this.host.sims.values()) if (sim.browserRequest === requestId) return sim;
    return undefined;
  }

  private sim(agentId: string): AgentSim {
    if (!this.host.supported()) throw apiError("unsupported", "This host runs a tf-hostd older than 0.9.0, without the TeleFlock Browser", { hint: "TeleFlock updates it when it connects to the host again" });
    const sim = this.host.sims.get(agentId);
    if (!sim) throw apiError("not_found", `unknown agent \`${agentId}\``);
    if (!sim.omp) throw apiError("unsupported", `${sim.agent.name} is a ${sim.agent.kind} agent: only omp can drive the browser`);
    return sim;
  }

  /** `agent.browserAttach`: the agent drives `device`'s browser until detached (or its turn ends); its pending request is answered as allowed. */
  attach(agentId: string, scope: BrowserScope, device: string): number {
    const sim = this.sim(agentId);
    let port = this.ports.get(agentId);
    if (port === undefined) {
      port = this.nextPort++;
      this.ports.set(agentId, port);
    }
    const since = sim.agent.browser?.attached?.since ?? this.host.now();
    sim.agent.browser = { ...sim.agent.browser, attached: { device, since, scope } };
    const asked = sim.browserRequest;
    if (asked) {
      sim.browserAnswered(asked, true, toolText(true, scope));
      this.host.activity(agentId, "answered", `You let ${sim.agent.name} use your browser`, scope === "turn" ? "Allow once" : "Allow for this session");
    } else {
      this.host.activity(agentId, "answered", `You let ${sim.agent.name} use your browser`);
    }
    this.host.changed(agentId);
    return port;
  }

  /** `agent.browserDetach` (or the end of an "Allow once" turn): the agent can't drive the browser any more. */
  detach(agentId: string): void {
    const sim = this.host.sims.get(agentId);
    if (!sim?.agent.browser?.attached) return;
    const { attached: _gone, ...rest } = sim.agent.browser;
    sim.agent.browser = rest.request ? rest : undefined;
    this.host.changed(agentId);
  }

  /** `agent.browserAnswer` with `allow: false`: the agent is told the user said no. */
  deny(requestId: string): void {
    const sim = this.asker(requestId);
    if (!sim) throw apiError("stale", "this request was already answered", { hint: "The agent may have stopped asking" });
    sim.browserAnswered(requestId, false, toolText(false, "session"));
    this.host.activity(sim.agent.id, "denied", `You denied ${sim.agent.name} your browser`);
    this.host.changed(sim.agent.id);
  }
}
