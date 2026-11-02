import { useState } from "react";
import { core, toApiError } from "@/core";
import type { IdleShell, IdleShellsSetParams } from "@/core/gen";
import { Select, toast } from "@/design";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { tildify } from "@/features/workspace/shared/paths";
import { andList, idleText, shellsText, spanText, thresholdChoices } from "./idleShells";

/*
 * Changing a host's idle-shell settings and closing its idle shells, from the Cleanup page, the board notice
 * and Settings. Always through tf-hostd (`cleanup.idleShellsSet`, `cleanup.idleShellsClose`), which publishes
 * the outcome as `HostInfo.idleShells`.
 */

function errorText(e: unknown): string {
  const err = toApiError(e);
  return err.hint ? `${err.message} — ${err.hint}` : err.message;
}

/** `cleanup.idleShellsSet` for one host; a failure is toasted. `saving` while it runs. */
export function useIdleShellsSave(hostId: string): { saving: boolean; save(patch: IdleShellsSetParams): void } {
  const [saving, setSaving] = useState(false);
  const save = (patch: IdleShellsSetParams) => {
    setSaving(true);
    core
      .host(hostId)
      .call("cleanup.idleShellsSet", patch)
      .then(
        () => {},
        (e: unknown) => toast({ title: "Couldn't change the idle shell setting", description: errorText(e), status: "error" }),
      )
      .finally(() => setSaving(false));
  };
  return { saving, save };
}

/** The threshold select: the presets plus the host's own value ("2 min" in a lab). */
export function ThresholdSelect({ minutes, disabled, onChange, id, className }: { minutes: number; disabled?: boolean; onChange(minutes: number): void; id?: string; className?: string }) {
  return (
    <Select
      id={id}
      aria-label="Idle after"
      className={className}
      value={String(minutes)}
      disabled={disabled}
      onValueChange={(v) => onChange(Number(v))}
      options={thresholdChoices(minutes).map((m) => ({ value: String(m), label: spanText(m) }))}
    />
  );
}

/**
 * Closes these shells (`cleanup.idleShellsClose`); tf-hostd checks each again right before and leaves open one
 * that was used since, runs something, got an agent or a viewer. `ask`: confirm first, naming the count and the
 * host; `onStart` runs once the call goes out. Toasts how many closed and, one line each, why any stayed open.
 * False when cancelled or failed.
 */
export async function closeIdleShells(hostId: string, hostName: string, shells: readonly IdleShell[], opts: { ask: boolean; home?: string; onStart?: () => void }): Promise<boolean> {
  const n = shells.length;
  if (n === 0) return false;
  if (opts.ask) {
    const now = Date.now();
    const emptied = [...new Set(shells.filter((s) => s.closesWorkspace).map((s) => s.workspace))];
    const ok = await confirmAction({
      title: `Close ${shellsText(n)} on ${hostName}?`,
      body: (
        <div className="flex flex-col gap-2">
          <ul className="max-h-60 overflow-auto rounded-md well p-2 font-mono text-2xs leading-relaxed">
            {shells.map((s) => (
              <li key={s.paneId} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate" title={s.cwd}>
                  {s.workspace} <span className="text-mute-2">{s.cwd ? tildify(s.cwd, opts.home) : s.shell}</span>
                </span>
                <span className="shrink-0 text-mute">idle {idleText(now - s.idleSince)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-mute">
            Their scrollback goes with them. {emptied.length > 0 ? `Workspaces left without a pane close too: ${andList(emptied)}.` : "A workspace left without a pane closes too."} A
            shell used since stays open.
          </p>
        </div>
      ),
      confirmLabel: `Close ${n} shell${n === 1 ? "" : "s"}`,
      danger: true,
    });
    if (!ok) return false;
  }
  opts.onStart?.();
  try {
    const out = await core.host(hostId).call("cleanup.idleShellsClose", { shells: shells.map((s) => ({ paneId: s.paneId, terminalId: s.terminalId })) });
    const closed = out.closed.length;
    toast({
      title: closed > 0 ? `Closed ${closed} shell${closed === 1 ? "" : "s"}` : "No shell closed",
      description:
        out.kept.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {out.kept.map((k) => (
              <li key={k.paneId}>
                <b className="text-ink">{shells.find((s) => s.paneId === k.paneId)?.workspace ?? k.paneId}</b> stayed open: {k.error.message}
              </li>
            ))}
          </ul>
        ) : undefined,
      duration: out.kept.length > 0 ? 10_000 : 4000,
    });
    return true;
  } catch (e) {
    toast({ title: n === 1 ? "Couldn't close the shell" : "Couldn't close the shells", description: errorText(e), status: "error" });
    return false;
  }
}
