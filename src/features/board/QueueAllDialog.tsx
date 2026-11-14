import { Check, CornerDownRight, ListPlus } from "lucide-react";
import { useId, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { core, draftKey, drafts, parseAgentKey, toApiError, useAgent, useCore, useDraft, useHosts } from "@/core";
import { isChat } from "@/core/chats";
import type { Delivery } from "@/core/gen";
import { Button, cn, EmptyState, Kbd, Textarea, toast, Tooltip, useIsMobile } from "@/design";
import { isMac } from "@/design/lib/platform";
import { useMultiHost } from "@/features/hosts/HostBadge";
import { haptic } from "@/features/shell/haptics";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { HostTag } from "./AgentCard";
import { useBoard } from "./boardStore";
import { type QueueResult, type QueueScope, queueBlock, queueSummary, runningKeys, type SendState, settleSend } from "./queueAll";
import { RepoTag } from "./RepoTag";

const DRAFT_KEY = draftKey("board.queueAll");
const NONE: string[] = [];
const MOD = isMac ? "⌘" : "Ctrl";

/** Whether the dialog is open; `gen` gives every open a fresh body (rows and picks start over). */
const useQueueAllDialog = create<{ open: boolean; gen: number }>(() => ({ open: false, gen: 0 }));

/** "Queue a message for all running agents": Running lane header, phone Running section, palette. */
export function openQueueAll(): void {
  useQueueAllDialog.setState((s) => ({ open: true, gen: s.gen + 1 }));
}

/** The board's filters, which pick the recipients (the host filter is the title-bar pill). */
function useScope(): QueueScope {
  const hostId = useHosts((s) => s.filter);
  const repo = useBoard((s) => s.repo);
  return { hostId, repo };
}

/**
 * Lane-header button (desktop Running lane, phone Running section): shown while at least `min`
 * agents run in the board's filter and one of them can take a message.
 */
export function QueueAllButton({ min = 2, mobile = false }: { min?: number; mobile?: boolean }) {
  const scope = useScope();
  const ready = useCore((s) => {
    const keys = runningKeys(s, scope);
    return keys.length >= min && keys.some((k) => queueBlock(s, k) === null);
  });
  if (!ready) return null;
  return (
    <Tooltip content="Queue a message for all running agents">
      <button
        type="button"
        onClick={() => {
          if (mobile) haptic("select");
          openQueueAll();
        }}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-full font-bold text-mute focus-ring hover:bg-ink/6 hover:text-ink",
          mobile ? "px-2.5 py-1 text-xs pressable [&_svg]:size-3.5" : "-my-0.5 px-2 py-0.5 text-2xs [&_svg]:size-3",
        )}
      >
        <ListPlus aria-hidden />
        Queue for all
      </button>
    </Tooltip>
  );
}

/** Mounted once by the shell (`app/App.tsx`). */
export function QueueAllDialog() {
  const open = useQueueAllDialog((s) => s.open);
  const gen = useQueueAllDialog((s) => s.gen);
  // the body stays while the dialog animates out
  if (gen === 0) return null;
  return <QueueAllBody key={gen} gen={gen} open={open} onClose={() => useQueueAllDialog.setState({ open: false })} />;
}

/** One agent, through its own host. Never rejects: a failure is its outcome. */
async function promptOne(key: string, name: string, text: string, delivery: Delivery): Promise<QueueResult> {
  const { hostId, agentId } = parseAgentKey(key);
  try {
    await core.host(hostId).call("agent.prompt", { agentId, text, images: [], delivery });
    return { key, name };
  } catch (e) {
    const err = toApiError(e);
    return { key, name, error: [err.message, err.hint].filter(Boolean).join(" — ") };
  }
}

/** The last Send: per agent, null when it went through, else why not. */
interface Outcome {
  delivery: Delivery;
  byKey: Record<string, string | null>;
}

function QueueAllBody({ gen, open, onClose }: { gen: number; open: boolean; onClose(): void }) {
  const mobile = useIsMobile();
  const multiHost = useMultiHost();
  const scope = useScope();
  const filterName = useHosts((s) => (s.filter === "all" ? null : (s.profiles.find((p) => p.id === s.filter)?.name ?? s.filter)));
  const [text, setText, clearText] = useDraft(DRAFT_KEY);
  const running = useCore(useShallow((s) => (open ? runningKeys(s, scope) : NONE)));
  // Rows stay put while the dialog is open, so none moves under the pointer: an agent whose turn
  // ends keeps its row (it gets the message at once), agents that start running join at the end.
  const [keys, setKeys] = useState(running);
  const joined = running.filter((k) => !keys.includes(k));
  if (joined.length > 0) setKeys([...keys, ...joined]);
  const rows = useCore(useShallow((s) => keys.filter((k) => s.agents[k] !== undefined)));
  const blocks = useCore(useShallow((s) => rows.map((k) => queueBlock(s, k))));
  const names = useCore(useShallow((s) => rows.map((k) => s.agents[k]?.name ?? parseAgentKey(k).agentId)));
  /** Picks are everything that can take it, less what was unticked: an agent that becomes able to joins ticked. */
  const [unpicked, setUnpicked] = useState<ReadonlySet<string>>(() => new Set());
  const [sending, setSending] = useState<Delivery | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const able = rows.filter((_, i) => blocks[i] === null);
  const picked = able.filter((k) => !unpicked.has(k));
  const message = text.trim();
  const canSend = message !== "" && picked.length > 0 && sending === null;
  const scopeText = [filterName, scope.repo].filter(Boolean).join(" · ");

  const send = async (delivery: Delivery) => {
    if (!canSend) return;
    const sent: SendState = { gen, draft: text };
    setSending(delivery);
    setOutcome(null);
    // every agent at once, each through its own host
    const results = await Promise.all(picked.map((k) => promptOne(k, names[rows.indexOf(k)] ?? k, message, delivery)));
    const { title, failed } = queueSummary(results, delivery);
    toast({
      title,
      description:
        failed.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {failed.slice(0, 4).map((f) => (
              <li key={f.key}>
                <b className="font-bold text-ink">{f.name}</b>: {f.error}
              </li>
            ))}
            {failed.length > 4 && <li>and {failed.length - 4} more</li>}
          </ul>
        ) : delivery === "followUp" ? (
          "Each one gets it when its current turn ends."
        ) : (
          "It reaches each one now, during its turn."
        ),
      status: failed.length > 0 ? "error" : "done",
      duration: failed.length > 0 ? 10_000 : 3200,
    });
    haptic(failed.length > 0 ? "warning" : "success");
    // Judged against the dialog as it is now: a slow send must not clear or close a dialog opened
    // again meanwhile, nor a draft edited since.
    const settle = settleSend(sent, { gen: useQueueAllDialog.getState().gen, draft: drafts.get(DRAFT_KEY) }, failed.length);
    if (settle === "elsewhere") return;
    setSending(null);
    if (settle === "done") {
      clearText();
      onClose();
      return;
    }
    setOutcome({ delivery, byKey: Object.fromEntries(results.map((r) => [r.key, r.error ?? null])) });
    // a retry of the same text goes to the ones that failed (still ticked, with why)
    if (settle === "retry") setUnpicked(new Set([...unpicked, ...results.filter((r) => r.error === undefined).map((r) => r.key)]));
  };

  const toggle = (key: string, on: boolean) => {
    const next = new Set(unpicked);
    if (on) next.delete(key);
    else next.add(key);
    setUnpicked(next);
  };
  const allPicked = able.length > 0 && picked.length === able.length;

  const footer = (
    <div className="flex w-full items-center gap-2">
      {!mobile && (
        <span className="mr-auto flex items-center gap-1 text-2xs font-semibold text-mute-2">
          <Kbd>{MOD}</Kbd>
          <Kbd>↵</Kbd> queue
        </span>
      )}
      <Tooltip content="Steer now: it reaches each agent during its current turn">
        <Button icon={<CornerDownRight />} loading={sending === "auto"} disabled={!canSend} onClick={() => void send("auto")} className={mobile ? "flex-1" : undefined}>
          Steer now
        </Button>
      </Tooltip>
      <Button variant="primary" icon={<ListPlus />} loading={sending === "followUp"} disabled={!canSend} onClick={() => void send("followUp")} className={mobile ? "flex-1" : undefined}>
        {picked.length > 0 ? `Queue for ${picked.length}` : "Queue"}
      </Button>
    </div>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Queue a message for running agents"
      description="It waits in each agent's queue until its current turn ends, then goes in as its next prompt."
      icon={<ListPlus />}
      width={600}
      footer={footer}
    >
      <div
        className="flex min-w-0 flex-col gap-4 pb-1"
        onKeyDownCapture={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            void send("followUp");
          }
        }}
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. When you're done, run the full test suite and sum up what changed"
          aria-label="Message"
          autoFocus
          rows={3}
          maxHeight={mobile ? 160 : 220}
          readOnly={sending !== null}
        />
        <section aria-label="Recipients" className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2.5 px-1">
            <input
              type="checkbox"
              aria-label="Pick every agent that can take it"
              className="size-4 shrink-0 accent-accent"
              checked={allPicked}
              ref={(el) => {
                if (el) el.indeterminate = picked.length > 0 && !allPicked;
              }}
              disabled={able.length === 0 || sending !== null}
              onChange={() => setUnpicked(allPicked ? new Set(able) : new Set())}
            />
            <h3 className="text-sm font-bold text-ink">To</h3>
            <span className="text-2xs text-mute-2 tabular">
              {picked.length} of {rows.length} picked
            </span>
            {scopeText && (
              <span className="ml-auto min-w-0 truncate text-2xs font-semibold text-mute-2" title="The board's filters pick who gets it">
                Board filter: {scopeText}
              </span>
            )}
          </div>
          {rows.length === 0 ? (
            <EmptyState compact title="Nothing running" description={scopeText ? `No agent is working in the board's filter (${scopeText}).` : "No agent is working right now."} className="my-2" />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rows.map((k, i) => (
                <RecipientRow
                  key={k}
                  agentKey={k}
                  blocked={blocks[i] ?? null}
                  picked={!unpicked.has(k) && blocks[i] === null}
                  disabled={sending !== null}
                  multiHost={multiHost}
                  outcome={outcome && k in outcome.byKey ? { delivery: outcome.delivery, error: outcome.byKey[k] ?? null } : undefined}
                  onToggle={(on) => toggle(k, on)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </ResponsiveDialog>
  );
}

function RecipientRow({
  agentKey,
  blocked,
  picked,
  disabled,
  multiHost,
  outcome,
  onToggle,
}: {
  agentKey: string;
  /** Why it can't take the message (listed, unticked); null when it can. */
  blocked: string | null;
  picked: boolean;
  disabled: boolean;
  multiHost: boolean;
  /** How the last Send went for it, when it was sent to. */
  outcome?: { delivery: Delivery; error: string | null };
  onToggle(on: boolean): void;
}) {
  const id = useId();
  const agent = useAgent(agentKey);
  if (!agent) return null;
  const queued = agent.omp?.queue.followUp.length ?? 0;
  // its turn ended while the dialog was open: a queued message starts it at once
  const idle = blocked === null && agent.column !== "running";
  const line = blocked ?? (idle ? "Its turn ended: it starts on this right away" : agent.title);
  return (
    <li className={cn("rounded-lg px-3 py-2 transition-colors", picked ? "bg-accent/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_40%,transparent)]" : "bg-ink/[0.03] shadow-hairline")}>
      <div className="flex items-start gap-3">
        <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-accent" checked={picked} disabled={blocked !== null || disabled} onChange={(e) => onToggle(e.target.checked)} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <label htmlFor={id} className={cn("min-w-[4ch] shrink truncate text-sm font-bold", blocked === null ? "cursor-pointer text-ink" : "text-ink-2")}>
              {agent.name}
            </label>
            {multiHost && <HostTag hostId={agent.hostId} />}
            <RepoTag hostId={agent.hostId} repo={agent.repo} branch={agent.branch} cwd={agent.cwd} chat={isChat(agent)} />
            {outcome?.error === null ? (
              <span data-status="done" className="ml-auto flex shrink-0 items-center gap-0.5 text-2xs font-bold st-text">
                <Check className="size-3" aria-hidden />
                {outcome.delivery === "followUp" ? "Queued" : "Sent"}
              </span>
            ) : (
              queued > 0 && <span className="ml-auto shrink-0 text-2xs font-semibold text-mute-2 tabular">{queued} queued</span>
            )}
          </div>
          {line && <p className={cn("mt-0.5 truncate text-xs", blocked !== null ? "text-mute-2" : "text-mute")} title={line}>{line}</p>}
          {outcome?.error && (
            <p className="mt-1 text-xs text-error-ink">
              <span className="font-bold">Not {outcome.delivery === "followUp" ? "queued" : "sent"}: </span>
              {outcome.error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
