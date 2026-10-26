import type { AppEvent, DiagReport, HostProfile, HostStatusEntry, Settings, TunnelInfo } from "@/core/gen";
import { apiError } from "../errors";
import { type DemoClock, realClock } from "./clock";
import { DEMO_GROUP } from "./dispatchAuto";
import { DemoHost, type HostVariant } from "./host";
import { NotifySync } from "./notifySync";

export interface DemoEngineOptions {
  /** `backend`: the whole app runs on the demo (app methods too). `embedded`: only demo-kind hosts. */
  mode: "backend" | "embedded";
  /** Backend mode: start with no profiles (onboarding). */
  empty?: boolean;
  /** Extra seeded transcript rows for `forge::pool` (`?demo&long=N`). Default 0. */
  longTranscript?: number;
  clock?: DemoClock;
  seed?: number;
  /** Start hosts immediately (default true). Tests may defer. */
  autoStart?: boolean;
}

const SETTINGS_KEY = "tf.demo.settings";

const DEFAULT_SETTINGS: Settings = {
  motion: "system",
  notifyNeeds: true,
  notifyFinished: true,
  notifyErrors: true,
  notifySound: false,
  keepAlive: true,
  terminalFontSize: 13,
  defaultModel: "anthropic/claude-opus-5",
  defaultThinking: "high",
  defaultPlan: false,
  deviceName: "Demo browser",
  mutedAgents: [],
  autoUpdate: true,
  closeDone: true,
  templates: [
    {
      id: "tpl-careful-reviewer",
      name: "Careful reviewer",
      description: "Opus, high thinking, plans first and waits for approval",
      model: "anthropic/claude-opus-5",
      thinking: "high",
      plan: true,
      prompt: "Review the current branch against main. List risks, missing tests and edge cases before changing anything.",
    },
    {
      id: "tpl-fast-fixer",
      name: "Fast fixer",
      description: "Luna on low thinking for small, cheap fixes",
      model: "openai-codex/gpt-6-luna",
      thinking: "low",
      plan: false,
      prompt: "",
    },
    {
      id: "tpl-explorer",
      name: "Explorer",
      description: "GPT-5.5 on xhigh to map an unfamiliar codebase",
      model: "openai/gpt-5.5",
      thinking: "xhigh",
      plan: false,
      prompt: "Map this repository: entry points, data flow, build and test commands. Write the findings to docs/notes.md without changing code.",
    },
  ],
};

export const DEMO_PROFILES: HostProfile[] = [
  { id: "forge", name: "forge", kind: "demo", herdrSession: "default", color: "#a99cc2", autoConnect: true, group: DEMO_GROUP },
  { id: "studio-pc", name: "studio-pc", kind: "demo", herdrSession: "default", color: "#86b3aa", autoConnect: true, group: DEMO_GROUP },
];

/**
 * The in-process demo backend: answers every AppMethod (backend mode) and every HostMethod for
 * its simulated hosts, and emits AppEvents exactly like the real core.
 */
export class DemoEngine {
  readonly clock: DemoClock;
  private readonly listeners = new Set<(e: AppEvent) => void>();
  private readonly hosts = new Map<string, DemoHost>();
  private profiles: HostProfile[] = [];
  private settings: Settings;
  private tunnels: TunnelInfo[] = [];
  private nextTunnel = 1;
  private readonly seed: number;
  private disposed = false;
  /** The core's notification sync (needs-you resolution, read sync), applied to everything emitted. */
  private readonly notes = new NotifySync((e) => this.emit(e));

  constructor(private readonly opts: DemoEngineOptions) {
    this.clock = opts.clock ?? realClock;
    this.seed = opts.seed ?? 0x7e1ef10c;
    this.settings = loadSettings();
    if (opts.mode === "backend" && !opts.empty) {
      for (const p of DEMO_PROFILES) this.addHost(p, p.id === "studio-pc" ? "studio" : "forge", opts.autoStart !== false);
    }
  }

  subscribe(cb: (e: AppEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: AppEvent): void {
    if (this.disposed) return;
    for (const l of this.listeners) l(e);
    this.notes.observe(e);
  }

  private addHost(profile: HostProfile, variant: HostVariant, start: boolean): DemoHost {
    const host = new DemoHost({ clock: this.clock, emit: (e) => this.emit(e), seed: this.seed, longTranscript: this.opts.longTranscript ?? 0 }, profile, variant);
    this.hosts.set(profile.id, host);
    if (this.opts.mode === "backend") this.profiles = [...this.profiles.filter((p) => p.id !== profile.id), profile];
    if (start) this.clock.after(0, () => host.start());
    return host;
  }

  /** Starts hosts created with `autoStart: false`. */
  startAll(): void {
    for (const h of this.hosts.values()) h.start();
  }

  host(id: string): DemoHost | undefined {
    return this.hosts.get(id);
  }

  /** Embedded mode: simulate a demo-kind profile from the real backend. */
  attachHost(profile: HostProfile): void {
    if (this.hosts.has(profile.id)) return;
    this.addHost(profile, "forge", true);
  }

  detachHost(id: string): void {
    this.hosts.get(id)?.dispose();
    this.hosts.delete(id);
    this.notes.forget(id);
    const before = this.tunnels.length;
    this.tunnels = this.tunnels.filter((t) => t.hostId !== id);
    if (before !== this.tunnels.length) this.emit({ type: "tunnels", tunnels: this.tunnels });
  }

  dispose(): void {
    for (const h of this.hosts.values()) h.dispose();
    this.hosts.clear();
    this.disposed = true;
  }

  termInput(hostId: string, termId: string, data: string): void {
    this.hosts.get(hostId)?.termInput(termId, data);
  }

  async callHost(hostId: string, method: string, params: unknown): Promise<unknown> {
    const host = this.hosts.get(hostId);
    if (!host) throw apiError("not_found", `Unknown host ${hostId}`);
    return host.call(method, params);
  }

  async callApp(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "app.info":
        return {
          version: "0.1.0",
          platform: "web",
          hostdVersion: "0.1.0",
          dataDir: "(demo: in-memory)",
          capabilities: { local: false, wsl: false, tunnels: true, notifications: typeof Notification !== "undefined", keepAlive: false },
        };
      case "app.openExternal": {
        const url = String(p.url ?? "");
        for (const h of this.hosts.values()) if (h.completeAuth(url)) return {};
        if (typeof window !== "undefined" && /^https?:|^blob:/.test(url)) window.open(url, "_blank", "noopener");
        return {};
      }
      case "app.notifyTest": {
        const host = [...this.hosts.values()][0];
        this.emit({
          type: "notify",
          hostId: host?.id ?? "demo",
          notification: { id: `test-${this.clock.now()}`, at: this.clock.now(), kind: "info", agentId: "", title: "TeleFlock notifications work", body: "This is a test notification from the demo backend.", actions: [] },
        });
        return {};
      }
      case "app.notifyRead": {
        const hostId = String(p.hostId ?? "");
        if (!this.hosts.has(hostId)) throw apiError("not_found", `Unknown host ${hostId}`);
        this.notes.read(hostId, typeof p.agentId === "string" ? p.agentId : undefined);
        return {};
      }
      case "hosts.list":
        return { profiles: this.profiles, statuses: this.statuses() };
      case "hosts.save":
        return this.saveProfile(p as unknown as HostProfile);
      case "hosts.remove": {
        const id = String(p.hostId ?? "");
        this.detachHost(id);
        this.profiles = this.profiles.filter((x) => x.id !== id);
        this.emit({ type: "profiles", profiles: this.profiles });
        return {};
      }
      case "hosts.connect":
      case "hosts.disconnect": {
        const id = String(p.hostId ?? "");
        const host = this.hosts.get(id);
        if (!host) {
          if (this.profiles.some((x) => x.id === id)) {
            throw apiError("unsupported", "The demo backend can't reach real hosts", { hint: "Use the desktop app or tf-devserver to connect to real hosts" });
          }
          throw apiError("not_found", `Unknown host ${id}`);
        }
        if (method === "hosts.connect") host.connect();
        else host.disconnect();
        return {};
      }
      case "hosts.trustKey": {
        const host = this.hosts.get(String(p.hostId ?? ""));
        if (!host) throw apiError("not_found", `Unknown host ${String(p.hostId)}`);
        host.trustKey(String(p.fingerprint ?? ""));
        return {};
      }
      case "hosts.test":
        return this.test(p as unknown as HostProfile);
      case "wsl.distros":
        return {
          distros: [
            { name: "Ubuntu-24.04", isDefault: true, running: true, version: 2 },
            { name: "Debian", isDefault: false, running: false, version: 2 },
          ],
        };
      case "settings.get":
        return this.settings;
      case "settings.set": {
        this.settings = { ...this.settings, ...(p as Partial<Settings>) };
        saveSettings(this.settings);
        this.emit({ type: "settings", settings: this.settings });
        return this.settings;
      }
      case "tunnel.open":
        return this.openTunnel(String(p.hostId ?? ""), Number(p.port), typeof p.remoteHost === "string" ? p.remoteHost : "127.0.0.1");
      case "tunnel.close": {
        const t = this.tunnels.find((x) => x.tunnelId === p.tunnelId);
        if (!t) throw apiError("not_found", `Unknown tunnel ${String(p.tunnelId)}`);
        if (t.url.startsWith("blob:")) URL.revokeObjectURL(t.url);
        this.tunnels = this.tunnels.filter((x) => x !== t);
        this.emit({ type: "tunnels", tunnels: this.tunnels });
        return {};
      }
      case "tunnel.list":
        return { tunnels: this.tunnels };
      default:
        throw apiError("unknown_method", `Unknown app method ${method}`);
    }
  }

  private statuses(): HostStatusEntry[] {
    return this.profiles.map((p) => ({ hostId: p.id, status: this.hosts.get(p.id)?.status ?? { phase: "idle", since: this.clock.now(), attempt: 0 } }));
  }

  private saveProfile(input: HostProfile): HostProfile {
    if (!input.name?.trim()) throw apiError("invalid_params", "Host name is required");
    if (input.kind === "tailscaleSsh" && !input.address?.trim()) throw apiError("invalid_params", "Address is required", { hint: "MagicDNS name or tailnet IP" });
    if (input.kind === "wsl" && !input.distro?.trim()) throw apiError("invalid_params", "Pick a WSL distro");
    const id = input.id?.trim() || `${input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${this.nextTunnel++}`;
    const profile: HostProfile = { ...input, id, herdrSession: input.herdrSession || "default" };
    const existing = this.hosts.get(id);
    if (this.opts.mode === "embedded") return profile;
    this.profiles = this.profiles.some((x) => x.id === id) ? this.profiles.map((x) => (x.id === id ? profile : x)) : [...this.profiles, profile];
    this.emit({ type: "profiles", profiles: this.profiles });
    if (profile.kind === "demo" && !existing) {
      this.addHost(profile, "forge", true);
    } else if (profile.kind !== "demo") {
      const now = this.clock.now();
      this.emit({ type: "hostStatus", hostId: id, status: { phase: "connecting", since: now, attempt: 1, message: `Connecting to ${profile.address ?? profile.distro ?? profile.name}…` } });
      this.clock.after(900, () =>
        this.emit({
          type: "hostStatus",
          hostId: id,
          status: {
            phase: "error",
            since: this.clock.now(),
            attempt: 1,
            error: { code: "unsupported", message: "The demo backend can't reach real hosts", hint: "Use the desktop app or tf-devserver to connect to real hosts", retryable: false },
          },
        }),
      );
    }
    return profile;
  }

  private test(profile: HostProfile): DiagReport {
    if (profile.kind === "demo") {
      return {
        steps: [
          { id: "resolve", label: "Resolve host", status: "ok", detail: "built-in demo", ms: 1 },
          { id: "ssh", label: "SSH session", status: "ok", detail: "simulated", ms: 12 },
          { id: "herdr", label: "herdr 0.9.0", status: "ok", ms: 8 },
          { id: "omp", label: "omp 18.12.3", status: "ok", ms: 9 },
          { id: "hostd", label: "tf-hostd 0.1.0", status: "ok", ms: 21 },
          { id: "relay", label: "Collab relay :47466", status: "ok", ms: 3 },
          { id: "attach", label: "Attach session default", status: "ok", ms: 14 },
        ],
      };
    }
    return {
      steps: [
        { id: "resolve", label: `Resolve ${profile.address ?? profile.distro ?? profile.name}`, status: "skip", detail: "The demo backend runs in the browser and can't open network connections" },
        { id: "ssh", label: "SSH session", status: "fail", detail: "Unavailable in the demo backend. Use the desktop app or tf-devserver." },
      ],
    };
  }

  private openTunnel(hostId: string, port: number, remoteHost: string): TunnelInfo {
    const host = this.hosts.get(hostId);
    if (!host) throw apiError("not_found", `Unknown host ${hostId}`);
    if (!host.online) throw apiError("not_connected", `${host.profile.name} is not online`, { retryable: true });
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw apiError("invalid_params", `Invalid port ${port}`);
    const existing = this.tunnels.find((t) => t.hostId === hostId && t.remotePort === port && t.remoteHost === remoteHost);
    if (existing) return existing;
    const localPort = 49_000 + this.nextTunnel++;
    const html = `<!doctype html><meta charset="utf-8"><title>${remoteHost}:${port} · TeleFlock preview</title><body style="margin:0;font-family:system-ui;background:#0b0a12;color:#ece9ff;display:grid;place-items:center;min-height:100vh"><div style="text-align:center"><div style="font-size:13px;opacity:.6;letter-spacing:.08em;text-transform:uppercase">TeleFlock demo preview</div><h1 style="font-size:40px;margin:.3em 0;background:linear-gradient(90deg,#f053d0,#a15eef,#7fa2e7);-webkit-background-clip:text;color:transparent">${remoteHost}:${port}</h1><p style="opacity:.75">In the real app this tab shows the dev server on <b>${host.profile.name}</b>, tunnelled over SSH.</p></div></body>`;
    const url = typeof URL.createObjectURL === "function" && typeof Blob !== "undefined" ? URL.createObjectURL(new Blob([html], { type: "text/html" })) : `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const t: TunnelInfo = { tunnelId: `tun-${localPort}`, hostId, remoteHost, remotePort: port, localPort, url, openedAt: this.clock.now() };
    this.tunnels = [...this.tunnels, t];
    this.emit({ type: "tunnels", tunnels: this.tunnels });
    return t;
  }
}

function loadSettings(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (raw) {
      // `confirmArchive` was removed in 0.4.0; older saved demo settings still carry it.
      const { confirmArchive: _removed, ...stored } = JSON.parse(raw) as Partial<Settings> & { confirmArchive?: unknown };
      return { ...DEFAULT_SETTINGS, ...stored };
    }
  } catch {
    /* ignore corrupt / unavailable storage */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: Settings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
