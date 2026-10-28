import type { HostKind, SetupStatus } from "@/core/gen";

/**
 * What an online host's setup still hides from the board, most important first:
 * - `sessions`: omp sessions TeleFlock didn't start (started by hand, restored by herdr) don't show up.
 *   The TeleFlock bridge (TeleFlock's omp extension) serves them natively and collab sharing is its
 *   fallback, so either one is enough.
 * - `states`: herdr's omp integration is missing, so working / waiting / done stay unknown.
 */
export type SetupGap = "sessions" | "states";

type SetupFlags = Pick<SetupStatus, "globalBridge" | "globalSharing" | "herdrIntegration">;

/** The gap in a host's setup (null: nothing hides agents or their state; also null while unknown). */
export function setupGap(setup: SetupFlags | undefined): SetupGap | null {
  if (!setup) return null;
  if (!setup.globalBridge && !setup.globalSharing) return "sessions";
  if (!setup.herdrIntegration) return "states";
  return null;
}

/** The gap the board points out for a host: never for the demo's simulated hosts (nothing real to fix). */
export function boardSetupGap(kind: HostKind | undefined, setup: SetupFlags | undefined): SetupGap | null {
  return kind === "demo" ? null : setupGap(setup);
}
