import type { PriorityStatus } from "@/core/gen";

/** "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The hosts page line for `HostInfo.priority`: what `text` says, why something is not raised (`note`). */
export type PriorityLine = { text: string; note?: string; raised: boolean };

/**
 * What tf-hostd keeps above the agents' work so the host stays responsive while they load it
 * (hosts ≥ 0.9.5, `HostInfo.priority`): "Kept responsive: TeleFlock, SSH server and Tailscale run
 * above agents", with the host's own words for what it could not raise. `null` for older hosts.
 */
export function priorityLine(p: PriorityStatus | undefined): PriorityLine | null {
  if (!p) return null;
  if (p.raised.length === 0) return { text: "Not kept above agents", note: p.note ?? "nothing could be raised", raised: false };
  return { text: `Kept responsive: ${andList(p.raised)} ${p.raised.length === 1 ? "runs" : "run"} above agents`, note: p.note, raised: true };
}
