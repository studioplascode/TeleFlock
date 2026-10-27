import { FlaskConical, KeyRound, type LucideIcon, Monitor, Network, RectangleEllipsis, SquareTerminal } from "lucide-react";
import { isAndroid } from "@/design";
import type { AppCapabilities, HostKind, HostProfile, SshAuth } from "@/core/gen";

export interface KindMeta {
  label: string;
  short: string;
  icon: LucideIcon;
  blurb: string;
}

export const KIND_META: Record<HostKind, KindMeta> = {
  tailscaleSsh: {
    label: "Tailscale SSH",
    short: "Tailscale",
    icon: Network,
    blurb: "A herdr host on your tailnet. No keys or passwords: your tailnet identity is the login.",
  },
  local: {
    label: "This computer",
    short: "Local",
    icon: Monitor,
    blurb: "herdr running natively on this machine.",
  },
  wsl: {
    label: "WSL",
    short: "WSL",
    icon: SquareTerminal,
    blurb: "herdr inside a WSL distro on this machine.",
  },
  demo: {
    label: "Demo",
    short: "Demo",
    icon: FlaskConical,
    blurb: "A built-in simulated flock for trying TeleFlock. Nothing leaves the app.",
  },
};

export interface AuthMeta {
  label: string;
  icon: LucideIcon;
  blurb: string;
}

/** How an SSH host signs in. Tailscale SSH is the default and the recommended one; key and password are the advanced setup for hosts without it. */
export const AUTH_META: Record<SshAuth, AuthMeta> = {
  tailscale: {
    label: "Tailscale SSH",
    icon: Network,
    blurb: "Recommended. No keys or passwords: your tailnet identity is the login.",
  },
  key: {
    label: "Private key",
    icon: KeyRound,
    blurb: "Signs in with an OpenSSH or PEM private key, like ssh -i. The host must list its public key in ~/.ssh/authorized_keys.",
  },
  password: {
    label: "Password",
    icon: RectangleEllipsis,
    blurb: "Signs in with your password on the host. Its sshd must allow password sign-in.",
  },
};

export const AUTH_METHODS: readonly SshAuth[] = ["tailscale", "key", "password"];

/** How a profile signs in: `tailscale` unless an SSH host says otherwise. */
export function hostAuth(p: Pick<HostProfile, "kind" | "auth">): SshAuth {
  return p.kind === "tailscaleSsh" ? (p.auth ?? "tailscale") : "tailscale";
}

/** Badge text for a profile's connection kind: SSH hosts signing in with a key or password are not Tailscale SSH hosts. */
export function kindBadge(p: Pick<HostProfile, "kind" | "auth">): string {
  return hostAuth(p) === "tailscale" ? KIND_META[p.kind].short : "SSH";
}

/** Private key files offered with one click on desktop (OpenSSH's defaults, newest type first). */
export const KEY_PATH_SUGGESTIONS = ["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa"] as const;

/** Android has no key files to point at: the key is imported (or pasted) into the app instead. */
export const importsKeys = isAndroid;

/** Host kinds this device can use: Android only attaches over SSH (and the demo). */
export function availableKinds(caps: AppCapabilities | undefined): HostKind[] {
  const kinds: HostKind[] = ["tailscaleSsh"];
  if (!isAndroid && caps?.local) kinds.push("local");
  if (!isAndroid && caps?.wsl) kinds.push("wsl");
  kinds.push("demo");
  return kinds;
}

/** One-line address for a profile: `user@host:port`, `WSL · Ubuntu`, `This computer`, `Simulated`. */
export function profileAddress(p: HostProfile): string {
  switch (p.kind) {
    case "tailscaleSsh": {
      const user = p.user ? `${p.user}@` : "";
      const port = p.port && p.port !== 22 ? `:${p.port}` : "";
      return `${user}${p.address ?? "?"}${port}`;
    }
    case "wsl":
      return `WSL · ${p.distro ?? "default distro"}`;
    case "local":
      return "This computer";
    case "demo":
      return "Simulated flock";
  }
}

/** A fresh profile id (stable, URL-safe). */
export function newHostId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${slug || "host"}-${rand}`;
}

/** Longest host group label; mirrors `MAX_GROUP_LEN` in crates/tf-client/src/engine.rs. */
export const MAX_GROUP_LEN = 40;

/** A host group label as saved: whitespace collapsed, ≤ 40 chars; blank → undefined (no group). */
export function normalizeGroup(group: string | null | undefined): string | undefined {
  const g = (group ?? "").trim().split(/\s+/).join(" ").slice(0, MAX_GROUP_LEN).trimEnd();
  return g || undefined;
}

/** Distinct group labels of the profiles (first spelling wins, case-insensitive), sorted. */
export function hostGroups(profiles: readonly Pick<HostProfile, "group">[]): string[] {
  const seen = new Map<string, string>();
  for (const p of profiles) {
    const g = normalizeGroup(p.group);
    if (g && !seen.has(g.toLowerCase())) seen.set(g.toLowerCase(), g);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Where herdr and omp come from (linked from onboarding, the editor and diagnostics). */
export const HERDR_URL = "https://herdr.dev";
export const OMP_URL = "https://github.com/can1357/oh-my-pi";
/** Oldest omp TeleFlock works with; mirrors `MIN_OMP` in crates/tf-hostd/src/ops/host.rs. */
export const OMP_MIN_VERSION = "18.12";
/** Turns on Tailscale SSH on a host. */
export const TAILSCALE_SSH_COMMAND = "sudo tailscale set --ssh";

/** True when the first `x.y[.z]` version in `text` is older than `min` (`"18.12"`); false if none is found. */
export function versionBelow(text: string | null | undefined, min: string): boolean {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  if (!m) return false;
  const have = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const want = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * The name a host gets when the Name field is left empty: the MagicDNS host label (`forge` for
 * `forge.tail1234.ts.net`), the IP as typed, the WSL distro, or the kind's label. Empty when there
 * is nothing to derive it from yet.
 */
export function defaultHostName(p: Pick<HostProfile, "kind" | "address" | "distro">): string {
  switch (p.kind) {
    case "tailscaleSsh": {
      const a = p.address?.trim() ?? "";
      if (!a || /^[\d.]+$/.test(a) || a.includes(":")) return a;
      return a.split(".")[0] ?? a;
    }
    case "wsl":
      return p.distro?.trim() || "WSL";
    case "local":
      return "This computer";
    case "demo":
      return "Demo flock";
  }
}

/**
 * Host identity swatches: muted tones that share no hue with the status colours (purple running,
 * sunset needs-you, cyan review, lime done, amber warn), so a host never reads as a state.
 */
export const HOST_COLORS = ["#a99cc2", "#8ea9c4", "#86b3aa", "#a7b08c", "#c8b48e", "#c4a07e", "#c79f9f", "#bfa0c0"] as const;

/** Swatches offered before 0.4.0 (the status hues) → their muted replacement, in the same order. */
const LEGACY_HOST_COLORS: Record<string, string> = {
  "#a35cf0": "#a99cc2",
  "#4f8bff": "#8ea9c4",
  "#22d3ee": "#86b3aa",
  "#a3e635": "#a7b08c",
  "#fbbf24": "#c8b48e",
  "#ff7a18": "#c4a07e",
  "#ff3d77": "#c79f9f",
  "#f053d0": "#bfa0c0",
};

/** The colour to draw a host's identity with (saved legacy status-hue colours map to their muted twin). */
export function hostAccent(color: string | null | undefined): string {
  if (!color) return HOST_COLORS[0];
  return LEGACY_HOST_COLORS[color.toLowerCase()] ?? color;
}
