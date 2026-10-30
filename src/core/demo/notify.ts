/**
 * tf-hostd's notification routing for the demo (`notify.*`, architecture §3.21): the per-host
 * policy, the push channels (saved with their secrets kept out of every answer: only which fields
 * are stored and a masked target) and the connected devices. In memory; studio-pc plays a host
 * older than 0.7.0 (every method answers `unknown_method`).
 */
import { apiError } from "../errors";
import type { DevicePresence, NotifyConfig, NotifyKind, NotifyPolicy, NotifyTestParams, NotifyTestResult, PushChannel, PushChannelRef, PushChannelSave, PushResult } from "../gen";

export interface NotifyHostEnv {
  /** false: the host's tf-hostd predates notification routing (every method answers `unknown_method`). */
  supported: boolean;
  now(): number;
}

const SECRET_FIELDS = ["url", "token", "user", "secret"] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

/** What a stored channel keeps beyond the listed fields. */
interface Stored extends Omit<PushChannel, "target" | "saved"> {
  secrets: Partial<Record<SecretField, string>>;
}

const KINDS: readonly NotifyKind[] = ["needs", "error", "quiet", "finished", "info"];
const ESCALATE_TO = ["phones", "all"];
const WHEN = ["offline", "unseen", "always"];

function tail(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

/** The masked line a channel shows instead of its secrets, e.g. "ntfy.sh · topic tf-…k2". */
export function maskTarget(kind: PushChannel["kind"], secrets: Stored["secrets"]): string {
  if (kind === "pushover") return secrets.user ? `Pushover · user ${tail(secrets.user, 4)}` : "Pushover";
  let u: URL | undefined;
  try {
    u = secrets.url ? new URL(secrets.url) : undefined;
  } catch {
    u = undefined;
  }
  if (!u) return kind === "ntfy" ? "ntfy" : "Webhook";
  if (kind === "webhook") return u.host;
  const topic = u.pathname.replace(/^\/+/, "");
  return `${u.host} · topic ${topic.length > 5 ? `${topic.slice(0, 3)}…${topic.slice(-2)}` : topic}`;
}

export class DemoNotify {
  private policy: NotifyPolicy = { route: true, escalateAfterS: 300, escalateTo: "phones" };
  private readonly channels: Stored[] = [];
  private nextId = 1;
  private readonly devices: DevicePresence[];

  constructor(private readonly env: NotifyHostEnv) {
    if (!env.supported) {
      this.devices = [];
      return;
    }
    const now = env.now();
    this.devices = [
      { name: "This device", platform: "linux", me: true, presence: { state: "active", device: "desktop", inputAt: now - 4_000, osNotifications: true } },
      { name: "Pixel 9", platform: "android", me: false, presence: { state: "idle", device: "phone", inputAt: now - 9 * 60_000, osNotifications: true } },
      { name: "old-laptop", platform: "windows", me: false },
    ];
    this.channels.push({
      id: "ch-ntfy",
      kind: "ntfy",
      name: "ntfy on my phone",
      enabled: true,
      when: "unseen",
      kinds: ["needs", "error", "quiet", "finished"],
      private: false,
      secrets: { url: "https://ntfy.sh/tf-7f3a91ck2" },
      last: { at: now - 22 * 60_000, ok: true, status: 200, test: false },
    });
  }

  call(method: string, p: Record<string, unknown>): unknown {
    if (!this.env.supported) throw apiError("unknown_method", `Unknown method ${method}`);
    switch (method) {
      case "notify.config":
        return this.config();
      case "notify.setPolicy":
        return this.setPolicy(p as unknown as NotifyPolicy);
      case "notify.saveChannel":
        return this.save(p as unknown as PushChannelSave);
      case "notify.removeChannel": {
        const { id } = p as unknown as PushChannelRef;
        const i = this.channels.findIndex((c) => c.id === id);
        if (i < 0) throw apiError("not_found", `No push channel ${String(id)}`);
        this.channels.splice(i, 1);
        return this.config();
      }
      case "notify.test":
        return this.test(p as unknown as NotifyTestParams);
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private config(): NotifyConfig {
    return {
      policy: { ...this.policy },
      channels: this.channels.map(({ secrets, ...c }) => ({
        ...c,
        kinds: [...c.kinds],
        target: maskTarget(c.kind, secrets),
        saved: SECRET_FIELDS.filter((f) => secrets[f]),
      })),
      devices: this.devices.map((d) => ({ ...d })),
    };
  }

  private setPolicy(p: NotifyPolicy): NotifyConfig {
    if (typeof p.route !== "boolean") throw apiError("invalid_params", "route must be true or false");
    if (!Number.isInteger(p.escalateAfterS) || p.escalateAfterS < 0 || p.escalateAfterS > 86_400) throw apiError("invalid_params", "escalateAfterS must be 0 (never) to 86400 seconds");
    if (!ESCALATE_TO.includes(p.escalateTo)) throw apiError("invalid_params", "escalateTo must be phones or all");
    this.policy = { route: p.route, escalateAfterS: p.escalateAfterS, escalateTo: p.escalateTo };
    return this.config();
  }

  private save(p: PushChannelSave): NotifyConfig {
    const prev = p.id === undefined ? undefined : this.channels.find((c) => c.id === p.id);
    if (p.id !== undefined && !prev) throw apiError("not_found", `No push channel ${p.id}`);
    if (!p.name?.trim()) throw apiError("invalid_params", "Name the channel");
    if (!WHEN.includes(p.when)) throw apiError("invalid_params", "when must be offline, unseen or always");
    if (p.kinds.some((k) => !KINDS.includes(k))) throw apiError("invalid_params", "unknown notification kind");
    // absent keeps the stored secret, empty deletes it
    const secrets: Stored["secrets"] = { ...prev?.secrets };
    for (const f of SECRET_FIELDS) {
      const v = p[f];
      if (v === undefined) continue;
      if (v === "") delete secrets[f];
      else secrets[f] = v.trim();
    }
    if (p.kind === "ntfy") {
      for (const f of ["user", "secret"] as const) delete secrets[f];
      if (!secrets.url) throw apiError("invalid_params", "ntfy needs the topic URL", { hint: "Like https://ntfy.sh/your-topic" });
    } else if (p.kind === "pushover") {
      for (const f of ["url", "secret"] as const) delete secrets[f];
      if (!secrets.token || !secrets.user) throw apiError("invalid_params", "Pushover needs a user key and an application token", { hint: "Both are on pushover.net: your user key, and an application's API token" });
    } else {
      for (const f of ["user", "token"] as const) delete secrets[f];
      if (!secrets.url) throw apiError("invalid_params", "A webhook needs its URL");
    }
    if ((p.kind === "ntfy" || p.kind === "webhook") && secrets.url && !/^https?:\/\/[^\s/]+/.test(secrets.url)) {
      throw apiError("invalid_params", "The URL must start with https://", { hint: p.kind === "ntfy" ? "Like https://ntfy.sh/your-topic" : "Where TeleFlock POSTs the JSON event" });
    }
    const next: Stored = { id: prev?.id ?? `ch-${this.nextId++}-${this.env.now().toString(36)}`, kind: p.kind, name: p.name.trim(), enabled: p.enabled, when: p.when, kinds: [...p.kinds], private: p.private, secrets, last: prev?.last };
    if (prev) this.channels[this.channels.indexOf(prev)] = next;
    else this.channels.push(next);
    return this.config();
  }

  private test(p: NotifyTestParams): NotifyTestResult {
    if (p.channelId !== undefined) {
      const c = this.channels.find((x) => x.id === p.channelId);
      if (!c) throw apiError("not_found", `No push channel ${p.channelId}`);
      // A demo ntfy/webhook endpoint that can't be reached shows the failure path.
      const bad = /example\.(invalid|test)|localhost|\.invalid/.test(c.secrets.url ?? "");
      const push: PushResult = bad ? { at: this.env.now(), ok: false, error: "could not resolve the host", test: true } : { at: this.env.now(), ok: true, status: 200, test: true };
      c.last = push;
      return { push, alerted: [] };
    }
    // Routing on: only the devices in use alert at once; off: every connected device does.
    return { alerted: this.devices.filter((d) => !this.policy.route || d.presence?.state === "active").map((d) => d.name) };
  }
}
