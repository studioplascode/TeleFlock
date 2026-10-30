import { useEffect, useState } from "react";
import type { ApiError, MoveCheck, MoveProbe } from "@/core/gen";
import { canMove, defaultChoice, type MoveChoice, moveError } from "@/core/move";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";

export interface Preflight {
  source?: MoveCheck;
  /** The target's answer for the chosen target (and picked folder). */
  probe?: MoveProbe;
  loading: boolean;
  /** `move.check` or `move.probe` failed (an older host: "too old to move agents"). */
  error?: ApiError;
  /** The folder the user picked on the target, when they did. */
  pickedPath?: string;
  choice: MoveChoice;
  setChoice(c: MoveChoice): void;
  /** Re-probe with this folder as the repository (git agents). */
  pickRepo(path: string | undefined): void;
  ready: boolean;
  reload(): void;
}

/**
 * The move preflight: `move.check` on the agent's host once, `move.probe` on the target per target
 * and picked folder. Keeps `choice` pointing at something the latest probe offers. `enabled: false`
 * (a move is running or finished) makes no requests.
 */
export function usePreflight(args: { agentId: string; srcHostId: string; srcLabel: string; dstHostId?: string; dstLabel?: string; enabled: boolean }): Preflight {
  const { agentId, srcHostId, srcLabel, dstHostId, dstLabel, enabled } = args;
  const check = useHostQuery(srcHostId, "move.check", enabled ? { agentId } : null);
  const source = check.data;
  const [picked, setPicked] = useState<{ host?: string; path?: string }>({});
  // a folder picked on another target doesn't apply
  const pickedPath = picked.host === dstHostId ? picked.path : undefined;
  const probeQ = useHostQuery(dstHostId, "move.probe", source ? { source, ...(pickedPath ? { repoPath: pickedPath } : {}) } : null);
  const probe = probeQ.data;
  const [choice, setChoice] = useState<{ host?: string; choice: MoveChoice }>({ choice: {} });
  const current = choice.host === dstHostId ? choice.choice : {};

  // a new probe: keep the choice when it still applies, else the best default (the picked folder first)
  useEffect(() => {
    if (!source || !probe) return;
    setChoice((prev) => {
      const old = prev.host === dstHostId ? prev.choice : {};
      const valid = source.git
        ? (old.repoPath && probe.repos.some((r) => r.path === old.repoPath)) || (old.cloneTo && old.cloneTo === probe.clonePath)
        : !!old.cwd;
      if (valid) return prev.host === dstHostId ? prev : { host: dstHostId, choice: old };
      const next = pickedPath && probe.repos.some((r) => r.path === pickedPath) ? { repoPath: pickedPath } : defaultChoice(source, probe);
      return { host: dstHostId, choice: next };
    });
  }, [source, probe, dstHostId, pickedPath]);

  const err = check.error ?? probeQ.error;
  return {
    source,
    probe,
    loading: check.loading || (!!dstHostId && probeQ.loading),
    error: err ? moveError(err, check.error ? srcLabel : dstLabel) : undefined,
    pickedPath,
    choice: current,
    setChoice: (c) => setChoice({ host: dstHostId, choice: c }),
    pickRepo: (path) => setPicked({ host: dstHostId, path }),
    ready: !!source && !!probe && canMove(source, probe, current),
    reload: () => {
      check.reload();
      probeQ.reload();
    },
  };
}
