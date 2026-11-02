/**
 * The demo's TeleFlock Browser, the app core's side (`?demo`; tf-client's `browser` module,
 * docs/architecture.md §5.2): `browser.*` answered over the in-process fake Chromium (`wsUrl`
 * `demo:browser`, `src/features/browser/demo`). It runs from the start with quota and ci on forge
 * attached, each driving its own tab in bursts while it works, and expenses asking for it
 * (`./browserAgents`). Allow attaches the agent (it opens a tab of its own a moment later), Deny
 * tells it no; an `agent.answer` of a request is answered here, as on a computer with the browser.
 * The cap queues allowed requests; detach, take over, hand back and lending change the tab owners
 * it reports; an "Allow once" attachment ends with the agent's turn. Engines, the Chrome for
 * Testing download, clearing data and the config are simulated: nothing touches this computer.
 */
import type { AppEvent, BrowserConfig, BrowserEngine, BrowserInstall, BrowserRequest, BrowserScope, BrowserState, BrowserStatus, BrowserTabOwner } from "@/core/gen";
import { apiError } from "../errors";
import type { AgentSim } from "./agent";
import { DEMO_BROWSER_TABS, DEMO_BROWSER_WS, openDemoAgentTab } from "./browserTabs";
import type { DemoClock } from "./clock";
import type { DemoHost } from "./host";
import { hash } from "./rng";

export interface DemoBrowserEnv {
  clock: DemoClock;
  emit(e: AppEvent): void;
  hosts(): Iterable<DemoHost>;
  /** This device's name (Settings): hosts show it as whose browser an agent drives. */
  device(): string;
}

type Run = "off" | "starting" | "running";

interface Attached {
  hostId: string;
  agentId: string;
  name: string;
  since: number;
  hostPort: number;
  scope: BrowserScope;
  activeAt?: number;
}

/** A tab that isn't plainly the user's (the proxy's registry). */
interface Owned {
  hostId: string;
  agentId: string;
  lent: boolean;
  takenOver: boolean;
  activeAt?: number;
}

/** An allowed request at the cap. */
interface Waiting {
  requestId: string;
  hostId: string;
  agentId: string;
  scope: BrowserScope;
}

const DATA_DIR = "/home/demo/.local/share/dev.teleflock.app/browser";
const DOWNLOAD_DIR = "/home/demo/Downloads";
const CDP_PORT = 39_222;
const CAP_DEFAULT = 4;
const CAP_MAX = 16;
const CFT_VERSION = "156.0.7531.40";
const FOUND: readonly BrowserEngine[] = [
  { name: "Google Chrome", path: "/usr/bin/google-chrome-stable", version: "156.0.7531.42" },
  { name: "Chromium", path: "/usr/bin/chromium", version: "155.0.7489.118" },
];
const CFT: BrowserEngine = { name: "Chrome for Testing", path: `${DATA_DIR}/engine/chrome-linux64/chrome`, version: CFT_VERSION };
/** Launching, as a real Chromium takes about this long. */
const START_MS = 1200;
/** Agents' activity reaches the status at most this often (the core's ~2 s). */
const DRIVE_MS = 2000;
/** A working agent drives for two bursts of this length, then rests for one. */
const BURST_MS = 12_000;
/** A newly attached agent opens its first tab after this long. */
const OPEN_TAB_MS = 2500;
const INSTALL_TICK_MS = 400;
/** The page each agent opens first; others read the docs. */
const FIRST_PAGE: Record<string, string> = { expenses: "https://mail.example.com/inbox" };

const keyOf = (hostId: string, agentId: string) => `${hostId}::${agentId}`;

function str(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== "string" || !v) throw apiError("invalid_params", `missing ${k}`);
  return v;
}

/** What the demo takes for a program: a known engine, or an absolute path to a file. */
function runnable(path: string): boolean {
  return FOUND.some((e) => e.path === path) || path === CFT.path || (/^(\/|[A-Za-z]:[\\/])/.test(path) && !/[\\/]$/.test(path));
}

export class DemoBrowser {
  private run: Run = "off";
  private headed = false;
  /** The engine it runs (`running`). */
  private engine: BrowserEngine | undefined;
  private config: { enginePath?: string; headed: boolean; cap: number } = { headed: false, cap: CAP_DEFAULT };
  private cftInstalled = false;
  private install: BrowserInstall | undefined;
  private attached: Attached[] = [];
  /** Being attached (counted against the cap until the host answered). */
  private readonly attaching = new Set<string>();
  private waiting: Waiting[] = [];
  private readonly owners = new Map<string, Owned>();
  /** Every agent's last known name: a detached agent's tabs keep showing it. */
  private readonly names = new Map<string, string>();
  private starting: Promise<boolean> | null = null;
  /** Bumped by every stop: a launch in flight from before it doesn't come up. */
  private gen = 0;
  private sent = "";
  private nextWindow = 10;
  private tabSeq = 0;
  private readonly stopDrive: () => void;

  constructor(private readonly env: DemoBrowserEnv) {
    this.stopDrive = env.clock.every(DRIVE_MS, () => this.drive());
  }

  dispose(): void {
    this.stopDrive();
  }

  /** `?demo` with its hosts: it runs, quota and ci drive their tabs, expenses asks (`DemoBrowserAgents.seed`). */
  seed(): void {
    this.run = "running";
    this.engine = this.preferred();
    for (const h of this.env.hosts()) {
      for (const s of h.browser.seed(this.env.device())) {
        const sim = h.agentSims().find((x) => x.agent.id === s.agentId);
        if (!sim) continue;
        this.attached.push({ hostId: h.id, agentId: s.agentId, name: sim.agent.name, since: s.since, hostPort: s.port, scope: "session" });
        this.names.set(keyOf(h.id, s.agentId), sim.agent.name);
      }
    }
    for (const t of DEMO_BROWSER_TABS) if (t.owner && this.isAttached(t.owner.hostId, t.owner.agentId)) this.owners.set(t.targetId, { ...t.owner, lent: false, takenOver: false });
  }

  // ---------------------------------------------------------------- status

  private engines(): BrowserEngine[] {
    return this.cftInstalled ? [...FOUND, CFT] : [...FOUND];
  }

  /** The engine `browser.start` would run: the configured one, else the first found. */
  private preferred(): BrowserEngine | undefined {
    const path = this.config.enginePath;
    if (!path) return this.engines()[0];
    return this.engines().find((e) => e.path === path) ?? { name: path.split(/[\\/]/).pop() || path, path };
  }

  status(): BrowserStatus {
    const running = this.run === "running";
    const state: BrowserState = this.run;
    return {
      state,
      engine: running ? this.engine : this.preferred(),
      headed: this.run === "off" ? this.config.headed : this.headed,
      cdpPort: running ? CDP_PORT : undefined,
      wsUrl: running ? DEMO_BROWSER_WS : undefined,
      profileDir: `${DATA_DIR}/profile`,
      downloadDir: DOWNLOAD_DIR,
      install: this.install,
      cap: this.config.cap,
      attachments: this.attached.map((a) => ({ hostId: a.hostId, agentId: a.agentId, agentName: a.name, since: a.since, hostPort: a.hostPort, scope: a.scope, connections: running ? 1 : 0, activeAt: a.activeAt })),
      requests: this.requests(),
      tabs: this.tabs(),
    };
  }

  private requests(): BrowserRequest[] {
    const out: BrowserRequest[] = [];
    for (const h of this.env.hosts()) {
      if (!h.online) continue;
      for (const q of h.browser.requests()) {
        const w = this.waiting.find((x) => x.requestId === q.id);
        out.push({ id: q.id, hostId: h.id, agentId: q.agentId, agentName: q.agentName, reason: q.reason, at: q.at, waiting: !!w, scope: w?.scope });
      }
    }
    return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  private tabs(): BrowserTabOwner[] {
    return [...this.owners]
      .map(([targetId, o]) => ({
        targetId,
        hostId: o.hostId,
        agentId: o.agentId,
        agentName: this.names.get(keyOf(o.hostId, o.agentId)) ?? o.agentId,
        lent: o.lent,
        takenOver: o.takenOver,
        detached: !this.isAttached(o.hostId, o.agentId),
        activeAt: o.activeAt,
      }))
      .sort((a, b) => keyOf(a.hostId, a.agentId).localeCompare(keyOf(b.hostId, b.agentId)) || a.targetId.localeCompare(b.targetId));
  }

  /** `AppEvent::Browser` when the status changed since the last one sent. */
  private emit(): void {
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.sent) return;
    this.sent = json;
    this.env.emit({ type: "browser", status });
  }

  // ---------------------------------------------------------------- methods

  async call(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "browser.status":
        return this.status();
      case "browser.start":
        await this.start(typeof p.headed === "boolean" ? p.headed : this.config.headed);
        break;
      case "browser.stop":
        this.stop();
        break;
      case "browser.attach":
        await this.attach(str(p, "hostId"), str(p, "agentId"), "session", p.overCap === true);
        break;
      case "browser.detach":
        this.detach(str(p, "hostId"), str(p, "agentId"));
        break;
      case "browser.answer":
        await this.answer(p);
        break;
      case "browser.config":
        return this.configView();
      case "browser.configSet":
        return this.configSet(p);
      case "browser.installEngine":
        this.installEngine();
        break;
      case "browser.clearData":
        await this.clear(p.what);
        break;
      case "browser.stageFile":
        return { path: `${DATA_DIR}/staged/${String(p.name ?? "file").split(/[\\/]/).pop() || "file"}` };
      case "browser.revealDownload":
      case "browser.revealProfile":
        throw apiError("unsupported", "The demo can't open folders on this computer", { hint: "TeleFlock on your computer shows it in the file manager" });
      case "browser.takeOver":
        this.takeOver(str(p, "targetId"));
        break;
      case "browser.handBack":
        this.handBack(str(p, "targetId"));
        break;
      case "browser.lendTab":
        this.lend(str(p, "targetId"), str(p, "hostId"), str(p, "agentId"));
        break;
      default:
        throw apiError("unknown_method", `Unknown app method ${method}`);
    }
    this.emit();
    return this.status();
  }

  /**
   * An `agent.answer` of a browser request goes to `browser.answer` (tf-client `route_answer`);
   * `undefined`: not one, for the host to answer.
   */
  routeAnswer(hostId: string, p: Record<string, unknown>): Promise<unknown> | undefined {
    const host = this.hostOf(hostId);
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    const sim = host?.browser.asker(requestId);
    if (!sim || sim.agent.id !== p.agentId || !sim.agent.needs?.browser) return undefined;
    const a = (p.answer ?? {}) as { choices?: unknown; cancel?: unknown };
    const choice = a.cancel === true ? "deny" : Array.isArray(a.choices) ? a.choices[0] : undefined;
    if (choice !== "session" && choice !== "turn" && choice !== "deny") return undefined;
    return this.call("browser.answer", choice === "deny" ? { requestId, allow: false } : { requestId, allow: true, scope: choice }).then(() => ({}));
  }

  /** A host's state changed: agents' names, "Allow once" turns that ended, requests answered or withdrawn there. */
  hostChanged(hostId: string): void {
    const host = this.hostOf(hostId);
    if (host?.online) {
      const ended: Attached[] = [];
      for (const a of this.attached) {
        if (a.hostId !== hostId) continue;
        const sim = this.simOf(host, a.agentId);
        if (sim && sim.agent.name !== a.name) {
          a.name = sim.agent.name;
          this.names.set(keyOf(a.hostId, a.agentId), a.name);
        }
        // "Allow once": the bridge ends it with the agent's turn.
        if (a.scope === "turn" && (!sim || (sim.agent.state !== "working" && sim.agent.state !== "blocked"))) ended.push(a);
      }
      for (const a of ended) this.detach(a.hostId, a.agentId);
    }
    if (this.waiting.length) {
      const pending = new Set(this.requests().map((r) => r.id));
      this.waiting = this.waiting.filter((w) => pending.has(w.requestId));
    }
    this.emit();
  }

  // ---------------------------------------------------------------- lifecycle

  private async start(headed: boolean): Promise<void> {
    if (this.run === "running" && this.headed === headed) return;
    const gen = ++this.gen;
    const engine = this.preferred();
    this.run = "starting";
    this.headed = headed;
    this.emit();
    this.starting = new Promise<boolean>((resolve) =>
      this.env.clock.after(START_MS, () => {
        const current = gen === this.gen;
        if (current) {
          this.run = "running";
          this.engine = engine;
          this.starting = null;
          this.emit();
        }
        resolve(current);
      }),
    );
    if (!(await this.starting)) throw apiError("browser_failed", "The browser was stopped while it started");
  }

  private async ensureRunning(): Promise<void> {
    if (this.run === "running") return;
    if (this.starting && (await this.starting)) return;
    await this.start(this.config.headed);
  }

  private stop(): void {
    this.gen++;
    this.starting = null;
    this.waiting = [];
    for (const a of [...this.attached]) this.detach(a.hostId, a.agentId);
    this.run = "off";
    this.engine = undefined;
  }

  private async clear(what: unknown): Promise<void> {
    if (what !== "cookies" && what !== "cache" && what !== "everything") throw apiError("invalid_params", "what: cookies, cache or everything");
    if (what !== "everything" || this.run === "off") return;
    // The whole profile goes: the browser restarts with a new one (attachments stay).
    const headed = this.headed;
    this.gen++;
    this.run = "off";
    this.emit();
    await this.start(headed);
  }

  // ---------------------------------------------------------------- agents

  private hostOf(hostId: string): DemoHost | undefined {
    for (const h of this.env.hosts()) if (h.id === hostId) return h;
    return undefined;
  }

  private simOf(host: DemoHost, agentId: string): AgentSim | undefined {
    return host.agentSims().find((s) => s.agent.id === agentId);
  }

  /** The agent's host, when it can attach an agent now (tf-client `browser_link`). */
  private link(hostId: string): DemoHost {
    const h = this.hostOf(hostId);
    if (!h) throw apiError("not_found", `unknown host \`${hostId}\``);
    if (!h.online) throw apiError("not_connected", `${h.profile.name} is not connected`, { hint: "Connect the host and try again", retryable: true });
    if (!h.browser.available) {
      throw apiError("unsupported", `${h.profile.name} runs a tf-hostd older than 0.9.0, without the TeleFlock Browser`, { hint: "TeleFlock updates it when it connects to the host again" });
    }
    return h;
  }

  private isAttached(hostId: string, agentId: string): boolean {
    return this.attached.some((a) => a.hostId === hostId && a.agentId === agentId);
  }

  /** Agents attached or being attached. */
  private inUse(): number {
    return this.attached.length + [...this.attaching].filter((k) => !this.attached.some((a) => keyOf(a.hostId, a.agentId) === k)).length;
  }

  private admits(key: string, overCap: boolean): boolean {
    return overCap || this.attaching.has(key) || this.attached.some((a) => keyOf(a.hostId, a.agentId) === key) || this.inUse() < this.config.cap;
  }

  /** Attaches an agent: a slot under the cap (unless `overCap`), the browser started, then its host told. */
  private async attach(hostId: string, agentId: string, scope: BrowserScope, overCap: boolean): Promise<void> {
    const host = this.link(hostId);
    const sim = this.simOf(host, agentId);
    if (!sim) throw apiError("not_found", `unknown agent \`${agentId}\``);
    const key = keyOf(hostId, agentId);
    if (!this.admits(key, overCap)) {
      const n = this.attached.length;
      throw apiError("browser_busy", `${n} agent${n === 1 ? "" : "s"} use the browser`, { hint: "Detach one of them, or attach anyway" });
    }
    this.attaching.add(key);
    let port: number;
    try {
      await this.ensureRunning();
      port = host.browser.attach(agentId, scope, this.env.device());
    } finally {
      this.attaching.delete(key);
    }
    const before = this.attached.find((a) => keyOf(a.hostId, a.agentId) === key);
    const a: Attached = { hostId, agentId, name: sim.agent.name, since: before?.since ?? this.env.clock.now(), hostPort: port, scope, activeAt: before?.activeAt };
    this.attached = before ? this.attached.map((x) => (x === before ? a : x)) : [...this.attached, a];
    this.names.set(key, sim.agent.name);
    this.waiting = this.waiting.filter((w) => keyOf(w.hostId, w.agentId) !== key);
    if (!this.ownsTab(hostId, agentId)) this.openTabSoon(hostId, agentId);
    this.emit();
  }

  private ownsTab(hostId: string, agentId: string): boolean {
    for (const o of this.owners.values()) if (o.hostId === hostId && o.agentId === agentId && !o.lent) return true;
    return false;
  }

  /** The agent opens a tab of its own, in a window of its own (its browser tool's first `open`). */
  private openTabSoon(hostId: string, agentId: string): void {
    this.env.clock.after(OPEN_TAB_MS, () => {
      if (this.run !== "running" || !this.isAttached(hostId, agentId) || this.ownsTab(hostId, agentId)) return;
      const targetId = `demo-tab-${agentId}-${++this.tabSeq}`;
      this.owners.set(targetId, { hostId, agentId, lent: false, takenOver: false, activeAt: this.env.clock.now() });
      openDemoAgentTab({ targetId, url: FIRST_PAGE[agentId] ?? "https://docs.example.com/guide", window: this.nextWindow++, owner: { hostId, agentId } });
      this.emit();
    });
  }

  /** Ends an attachment here and on its host: its own tabs stay (detached), lent ones go back to the user. */
  private detach(hostId: string, agentId: string): void {
    const key = keyOf(hostId, agentId);
    this.attached = this.attached.filter((a) => keyOf(a.hostId, a.agentId) !== key);
    for (const [id, o] of this.owners) if (o.lent && o.hostId === hostId && o.agentId === agentId) this.owners.delete(id);
    this.waiting = this.waiting.filter((w) => keyOf(w.hostId, w.agentId) !== key);
    this.hostOf(hostId)?.browser.detach(agentId);
    this.admitWaiting();
  }

  /** Allowed requests that fit under the cap now attach, oldest first. */
  private admitWaiting(): void {
    while (this.waiting.length > 0 && this.run !== "off" && this.inUse() < this.config.cap) {
      const w = this.waiting.shift() as Waiting;
      void this.attach(w.hostId, w.agentId, w.scope, true).catch(() => this.emit());
    }
  }

  /** `browser.answer`: deny, attach, or wait for a free slot at the cap. */
  private async answer(p: Record<string, unknown>): Promise<void> {
    const requestId = str(p, "requestId");
    let found: { host: DemoHost; sim: AgentSim } | undefined;
    for (const host of this.env.hosts()) {
      const sim = host.online ? host.browser.asker(requestId) : undefined;
      if (sim) found = { host, sim };
    }
    if (!found) throw apiError("stale", "this request was already answered", { hint: "The agent may have stopped asking" });
    const { host, sim } = found;
    if (p.allow !== true) {
      this.waiting = this.waiting.filter((w) => w.requestId !== requestId);
      host.browser.deny(requestId);
      return;
    }
    const scope: BrowserScope = p.scope === "turn" ? "turn" : "session";
    const overCap = p.overCap === true;
    const key = keyOf(host.id, sim.agent.id);
    if (!this.admits(key, overCap)) {
      const w: Waiting = { requestId, hostId: host.id, agentId: sim.agent.id, scope };
      const i = this.waiting.findIndex((x) => keyOf(x.hostId, x.agentId) === key);
      this.waiting = i < 0 ? [...this.waiting, w] : this.waiting.map((x, j) => (j === i ? w : x));
      return;
    }
    await this.attach(host.id, sim.agent.id, scope, overCap);
  }

  /** Working agents drive their tabs in bursts (the proxy's `activeAt`, every ~2 s). */
  private drive(): void {
    if (this.run !== "running" || this.attached.length === 0) return;
    const now = this.env.clock.now();
    for (const a of this.attached) {
      const host = this.hostOf(a.hostId);
      const sim = host ? this.simOf(host, a.agentId) : undefined;
      if (sim?.agent.state !== "working" || Math.floor((now + hash(keyOf(a.hostId, a.agentId))) / BURST_MS) % 3 === 2) continue;
      a.activeAt = now;
      for (const o of this.owners.values()) if (o.hostId === a.hostId && o.agentId === a.agentId && !o.lent && !o.takenOver) o.activeAt = now;
    }
    this.emit();
  }

  // ---------------------------------------------------------------- tabs

  private mustRun(): void {
    if (this.run !== "running") throw apiError("not_running", "the browser is not running");
  }

  /** An agent's tab is the user's until handed back; a lent tab goes back to the user for good. */
  private takeOver(targetId: string): void {
    this.mustRun();
    const o = this.owners.get(targetId);
    if (!o) throw apiError("not_found", `No agent uses tab ${targetId}.`);
    if (o.lent) this.owners.delete(targetId);
    else o.takenOver = true;
  }

  private handBack(targetId: string): void {
    this.mustRun();
    const o = this.owners.get(targetId);
    if (!o) throw apiError("not_found", `No agent tab ${targetId}.`);
    o.takenOver = false;
  }

  private lend(targetId: string, hostId: string, agentId: string): void {
    this.mustRun();
    if (!this.isAttached(hostId, agentId)) throw apiError("not_found", "that agent is not attached to the browser");
    const o = this.owners.get(targetId);
    if (o) {
      if (o.hostId !== hostId || o.agentId !== agentId) throw apiError("invalid_params", "This tab belongs to another agent.");
      o.takenOver = false;
      return;
    }
    this.owners.set(targetId, { hostId, agentId, lent: true, takenOver: false });
  }

  // ---------------------------------------------------------------- engines and config

  private configView(): BrowserConfig {
    return { enginePath: this.config.enginePath, headed: this.config.headed, cap: this.config.cap, engines: this.engines(), download: { version: CFT_VERSION, available: true, installed: this.cftInstalled } };
  }

  /** `browser.configSet` replaces the saved config: absent fields are the defaults. */
  private configSet(p: Record<string, unknown>): BrowserConfig {
    const enginePath = typeof p.enginePath === "string" && p.enginePath.trim() ? p.enginePath.trim() : undefined;
    if (enginePath && !runnable(enginePath)) throw apiError("invalid_params", `${enginePath} is not a program on this computer`);
    const cap = typeof p.cap === "number" ? p.cap : CAP_DEFAULT;
    if (!Number.isInteger(cap) || cap < 1 || cap > CAP_MAX) throw apiError("invalid_params", `cap: 1 to ${CAP_MAX} agents`);
    this.config = { enginePath, headed: p.headed === true, cap };
    this.admitWaiting();
    this.emit();
    return this.configView();
  }

  /** Chrome for Testing "downloads" in about six seconds, then joins the engines. */
  private installEngine(): void {
    if (this.install && !this.install.error) return;
    this.install = { version: CFT_VERSION };
    let progress = 0;
    const stop = this.env.clock.every(INSTALL_TICK_MS, () => {
      progress = Math.min(100, progress + 7);
      if (progress < 100) {
        this.install = { version: CFT_VERSION, progress };
      } else {
        stop();
        this.install = undefined;
        this.cftInstalled = true;
      }
      this.emit();
    });
  }
}
