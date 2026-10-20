import { MessagesSquare, RotateCcw, Send, Skull } from "lucide-react";
import { useEffect, useState } from "react";
import type { Subagent, SubagentStatus, TranscriptItem } from "@/core/gen";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  Elapsed,
  EmptyState,
  formatCompact,
  formatElapsed,
  formatUsd,
  Input,
  ScrollArea,
  Shimmer,
  Skeleton,
  type Status,
  StatusOrb,
} from "@/design";
import { core, parseAgentKey } from "@/core";
import { errorText, hostCall, usePending } from "../api";
import { SessionCtx } from "../context";
import { ItemView } from "../transcript/rows";

export const SUB_STATUS: Record<SubagentStatus, Status> = { running: "running", done: "done", failed: "error", aborted: "idle", parked: "review" };
const SUB_LABEL: Record<SubagentStatus, string> = { running: "Running", done: "Done", failed: "Failed", aborted: "Aborted", parked: "Parked" };

/** One subagent: orb, name, live line, progress, timer. Click opens its transcript + controls. */
export function SubagentCard({ sub, onOpen, dense = false }: { sub: Subagent; onOpen?: () => void; dense?: boolean }) {
  const running = sub.status === "running";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-status={SUB_STATUS[sub.status]}
      className={cn(
        "group/sub focus-ring pressable relative flex w-full min-w-0 items-start gap-2.5 overflow-hidden rounded-lg text-left",
        dense ? "px-2 py-1.5 hover:bg-white/[0.04]" : "bg-white/[0.025] px-3 py-2 shadow-hairline hover:bg-white/[0.05]",
      )}
    >
      {running && <span className="tf-loop live-gradient absolute inset-x-0 top-0 h-[1.5px] opacity-80" aria-hidden />}
      <StatusOrb status={SUB_STATUS[sub.status]} activity={running ? "busy" : "silent"} size={8} className="mt-[5px]" label={SUB_LABEL[sub.status]} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <b className="truncate text-[12.5px] font-extrabold text-ink">{sub.name}</b>
          {!dense && sub.description && <span className="min-w-0 truncate text-xs text-mute">{sub.description}</span>}
        </span>
        {sub.line && (
          <span className="mt-0.5 block truncate font-mono text-[11px] text-mute">{running ? <Shimmer>{sub.line}</Shimmer> : sub.line}</span>
        )}
        {running && sub.progress != null && (
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/8">
            <span className="block h-full rounded-full bg-run transition-[width] duration-700" style={{ width: `${Math.round(sub.progress * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-2xs font-bold tabular">
        <span className={cn(sub.status === "done" ? "text-done" : sub.status === "failed" ? "text-error" : "text-mute")}>
          {sub.status === "done" && "✓ "}
          {sub.status === "failed" && "✗ "}
          {sub.startedAt ? running ? <Elapsed since={sub.startedAt} /> : formatElapsed((sub.endedAt ?? sub.startedAt) - sub.startedAt) : SUB_LABEL[sub.status]}
        </span>
        {!dense && (sub.costUsd != null || sub.toolCount != null) && (
          <span className="text-mute-2">
            {sub.toolCount != null && `${sub.toolCount} tools`}
            {sub.toolCount != null && sub.costUsd != null && " · "}
            {sub.costUsd != null && formatUsd(sub.costUsd)}
          </span>
        )}
      </span>
    </button>
  );
}

/** Transcript + steer/kill/revive for one subagent. */
export function SubagentDialog({ agentKey, sub, open, onOpenChange }: { agentKey: string; sub: Subagent | undefined; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, run] = usePending();
  const subId = sub?.id;
  const running = sub?.status === "running";

  useEffect(() => {
    if (!open || !subId) return;
    let alive = true;
    const load = () =>
      core
        .host(hostId)
        .call("session.subagentTranscript", { agentId, subagentId: subId })
        .then((page) => {
          if (alive) {
            setItems(page.items);
            setError(null);
          }
        })
        .catch((e: unknown) => alive && setError(errorText(e).title));
    void load();
    // Live subagents keep streaming; refresh their transcript while the dialog is open.
    const id = running ? window.setInterval(load, 2500) : undefined;
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open, subId, running, hostId, agentId]);

  if (!sub) return null;
  const act = (action: "chat" | "kill" | "revive", message?: string) =>
    run(hostCall(hostId, "agent.subagent", { agentId, subagentId: sub.id, action, message }, { success: action === "kill" ? `Killed ${sub.name}` : action === "revive" ? `Revived ${sub.name}` : undefined }));
  const send = async () => {
    const text = msg.trim();
    if (!text) return;
    const res = await act("chat", text);
    if (res.ok) setMsg("");
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        width={760}
        title={
          <span className="flex items-center gap-2" data-status={SUB_STATUS[sub.status]}>
            <StatusOrb status={SUB_STATUS[sub.status]} activity={running ? "busy" : "silent"} label={null} />
            {sub.name}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {sub.description && <span>{sub.description}</span>}
            {sub.model && <span className="font-mono text-2xs">{sub.model}</span>}
            {sub.tokens != null && <span className="tabular">{formatCompact(sub.tokens)} tok</span>}
            {sub.costUsd != null && <span className="tabular">{formatUsd(sub.costUsd)}</span>}
          </span>
        }
        footer={
          <div className="flex w-full flex-wrap items-center gap-2">
            <Input
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={running ? `Steer ${sub.name}…` : `Message ${sub.name}…`}
              aria-label={`Message ${sub.name}`}
              leading={<MessagesSquare className="size-4" />}
              boxClassName="min-w-[220px] flex-1"
            />
            <Button variant="primary" icon={<Send />} onClick={() => void send()} disabled={!msg.trim()} loading={busy}>
              Send
            </Button>
            {running ? (
              <Button variant="danger" icon={<Skull />} onClick={() => void act("kill")} disabled={busy}>
                Kill
              </Button>
            ) : (
              <Button icon={<RotateCcw />} onClick={() => void act("revive")} disabled={busy}>
                Revive
              </Button>
            )}
          </div>
        }
      >
        <SessionCtx.Provider value={{ hostId, agentId, key: agentKey }}>
        <ScrollArea className="h-[min(56vh,560px)]" viewportClassName="pr-3" fade>
          {error ? (
            <EmptyState compact title="Transcript unavailable" description={error} />
          ) : items === null ? (
            <div className="flex flex-col gap-3 py-2">
              <Skeleton className="h-10 w-3/4 rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
              <Skeleton className="h-6 w-1/2 rounded-md" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState compact title="No transcript yet" description={running ? "The subagent is starting up." : undefined} />
          ) : (
            <div className="flex flex-col gap-2 py-1">
              {items.map((it) => (
                <ItemView key={it.id} item={it} />
              ))}
            </div>
          )}
        </ScrollArea>
        </SessionCtx.Provider>
      </DialogContent>
    </Dialog>
  );
}
