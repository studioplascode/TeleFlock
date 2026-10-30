import { ArrowRightLeft, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { parseAgentKey, useAgent, useHosts } from "@/core";
import { Button } from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { useMoveTargets } from "./hosts";
import { PreflightView, TargetPicker } from "./Preflight";
import { Result, Running } from "./Progress";
import { cancelMove, closeMoveDialog, openMovedAgent, retryMove, startMove, useMoveFor, useMoves } from "./store";
import { usePreflight } from "./usePreflight";

/**
 * Mounted once by the shell. `openMoveDialog(agentKey)` opens it: pick the target host, read the
 * preflight, move; then the progress, then the result. A running move keeps going when it closes.
 */
export function MoveDialog() {
  const dialogKey = useMoves((s) => s.dialogKey);
  const gen = useMoves((s) => s.gen);
  // keep the last agent while the dialog animates out
  const [shown, setShown] = useState<{ key: string; gen: number } | null>(null);
  if (dialogKey && (shown?.key !== dialogKey || shown.gen !== gen)) setShown({ key: dialogKey, gen });
  if (!shown) return null;
  return <MoveBody key={shown.gen} agentKey={shown.key} open={dialogKey !== null} />;
}

function MoveBody({ agentKey, open }: { agentKey: string; open: boolean }) {
  const { hostId: srcHostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const entry = useMoveFor(agentKey);
  const name = agent?.name ?? entry?.name ?? agentId;
  const profiles = useHosts((h) => h.profiles);
  const srcLabel = profiles.find((p) => p.id === srcHostId)?.name ?? srcHostId;

  const candidates = useMoveTargets(srcHostId);
  const [picked, setPicked] = useState<string | undefined>();
  const dstHostId = candidates.some((p) => p.id === picked) ? picked : candidates[0]?.id;
  const dstLabel = profiles.find((p) => p.id === dstHostId)?.name ?? "";

  const pre = usePreflight({ agentId, srcHostId, srcLabel, dstHostId, dstLabel, enabled: !entry });

  let body: ReactNode;
  let footer: ReactNode;
  if (entry && !entry.outcome) {
    const stage = entry.progress?.stage;
    const busy = stage === "finishing" || stage === "cancelling" || stage === "rollingBack";
    body = <Running entry={entry} />;
    footer = (
      <>
        <Button variant="ghost" onClick={closeMoveDialog}>
          Hide
        </Button>
        <Button variant="danger" onClick={() => cancelMove(agentKey)} disabled={busy}>
          Cancel move
        </Button>
      </>
    );
  } else if (entry?.outcome) {
    body = <Result entry={entry} />;
    const o = entry.outcome;
    footer = (
      <>
        <Button variant="ghost" onClick={closeMoveDialog}>
          Close
        </Button>
        {o.ok ? (
          o.agentId && (
            <Button
              variant="primary"
              onClick={() => {
                openMovedAgent(entry.dstHostId, o.agentId as string);
                closeMoveDialog();
              }}
            >
              Open on {entry.dstLabel}
            </Button>
          )
        ) : (
          <Button variant="primary" onClick={() => retryMove(agentKey, srcHostId, o.failure.agentId)} disabled={o.failure.unsettled && !o.failure.rolledBack}>
            Try again
          </Button>
        )}
      </>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {candidates.length === 0 ? (
          <div className="flex gap-3 rounded-lg well p-4 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            <p>
              <span className="font-bold">Moving needs a second connected host.</span>{" "}
              <span className="text-mute">Connect another host (Hosts), then move {name} there. {srcLabel} is the only one connected now.</span>
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-2xs font-bold text-mute">Move {name} from {srcLabel} to</span>
              <TargetPicker hosts={candidates.map((p) => ({ id: p.id, name: p.name, color: p.color }))} value={dstHostId} onChange={setPicked} />
            </div>
            {pre.error ? (
              <div role="alert" className="flex gap-3 rounded-lg bg-error/10 p-3.5 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)]">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-error" aria-hidden />
                <div className="min-w-0 flex-1 text-xs">
                  <p className="text-sm font-bold">{pre.error.message}</p>
                  {pre.error.hint && <p className="mt-1 text-mute">{pre.error.hint}</p>}
                  {pre.error.code !== "unsupported" && (
                    <Button size="sm" variant="secondary" className="mt-2" onClick={pre.reload}>
                      Check again
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              dstHostId && <PreflightView pre={pre} dstHostId={dstHostId} dstLabel={dstLabel} srcLabel={srcLabel} />
            )}
          </>
        )}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={closeMoveDialog}>
          Cancel
        </Button>
        {candidates.length > 0 && dstHostId && (
          <Button
            variant="primary"
            icon={<ArrowRightLeft />}
            disabled={!pre.ready || !!pre.error}
            onClick={() => startMove({ agentKey, name, dstHostId, choice: pre.choice })}
          >
            Move to {dstLabel}
          </Button>
        )}
      </>
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && closeMoveDialog()}
      title={`Move ${name}`}
      description={ACTIONS.moveHost.description}
      icon={<ArrowRightLeft />}
      width={640}
      maxHeight="94dvh"
      footer={footer}
    >
      {body}
    </ResponsiveDialog>
  );
}
