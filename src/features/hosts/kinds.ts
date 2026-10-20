import { FlaskConical, type LucideIcon, Monitor, Network, SquareTerminal } from "lucide-react";
import { isAndroid } from "@/design";
import type { AppCapabilities, HostKind, HostProfile } from "@/core/gen";

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
    blurb: "herdr running natively on this Windows machine.",
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

/** Host kinds this device can use: Android only attaches over Tailscale SSH (and the demo). */
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

/** Accent swatches offered for a host. */
export const HOST_COLORS = ["#a35cf0", "#4f8bff", "#22d3ee", "#a3e635", "#fbbf24", "#ff7a18", "#ff3d77", "#f053d0"] as const;
