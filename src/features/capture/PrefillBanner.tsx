import { Share2, X, Zap } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type AgentView, useCore, useDraft, useDraftImages } from "@/core";
import { AgentGlyph, Button, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, IconButton, cn } from "@/design";
import { dispatchDraftKey } from "@/features/dispatch/send";
import { ACTIONS, agentStateWord, LANE_ORDER } from "@/features/shell/vocab";
import { basename } from "@/features/workspace/shared/paths";
import { applyWaiting, dismissPrefill, moveToAgent } from "./prefill";
import { usePrefill } from "./store";
import { imagesLabel } from "./task";

/*
 * Above Dispatch's composer while it holds a task that came from outside (Android share sheet,
 * Quick capture → Open in Dispatch): where it came from, and "Send to agent…" to hand it to an
 * existing agent instead of starting a new one.
 */

export function PrefillBanner({ target, repo, mobile }: { target: string | undefined; repo: string | null; mobile: boolean }) {
  const waiting = usePrefill((s) => s.waiting);
  const applied = usePrefill((s) => s.applied);
  const key = target && repo ? dispatchDraftKey(target, repo) : null;
  // Draft hooks need a key; "" is a draft nobody writes.
  const [text] = useDraft(key ?? "");
  const [images] = useDraftImages(key ?? "");
  const [picking, setPicking] = useState(false);

  // A task that came in before any repo was picked lands in the first thread picked.
  useEffect(() => {
    if (waiting && target && repo) void applyWaiting(target, repo);
  }, [waiting, target, repo]);

  const mine = !!applied && applied.key === key;
  const holds = text.trim() !== "" || images.length > 0;
  // Sent (or cleared) from the composer: nothing left to say.
  useEffect(() => {
    if (mine && !holds) dismissPrefill();
  }, [mine, holds]);

  if (waiting && !key) {
    return (
      <Banner icon={waiting.task.source === "share" ? <Share2 /> : <Zap />} mobile={mobile}>
        <span className="min-w-0 flex-1">
          <b className="font-bold text-ink">{waiting.task.source === "share" ? "Shared task" : "Captured task"}</b> waiting: pick a repository above and it lands in the task box.
        </span>
        <IconButton label="Drop it" size="sm" onClick={dismissPrefill}>
          <X />
        </IconButton>
      </Banner>
    );
  }
  if (!mine || !holds || !applied) return null;
  const extra = [imagesLabel(applied.images.length), applied.skipped && "some images left out"].filter(Boolean).join(" · ");
  return (
    <>
      <Banner icon={applied.source === "share" ? <Share2 /> : <Zap />} mobile={mobile}>
        <span className="min-w-0 flex-1 truncate">
          <b className="font-bold text-ink">{applied.source === "share" ? "Shared to TeleFlock" : "From Quick capture"}</b>
          {extra && <span className="text-mute"> · {extra}</span>}
          <span className="text-mute"> · edit and send, or</span>
        </span>
        <Button size="sm" variant="secondary" onClick={() => setPicking(true)} title={ACTIONS.sendToAgent.description}>
          {ACTIONS.sendToAgent.label}
        </Button>
        <IconButton label="Hide this note" size="sm" onClick={dismissPrefill}>
          <X />
        </IconButton>
      </Banner>
      {picking && <AgentPicker onClose={() => setPicking(false)} repo={repo} onPick={moveToAgent} />}
    </>
  );
}

function Banner({ icon, mobile, children }: { icon: ReactNode; mobile: boolean; children: ReactNode }) {
  return (
    <div className={cn("mb-1.5 flex items-center gap-2 rounded-md bg-accent/10 px-2.5 py-1.5 text-xs font-semibold text-ink-2 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.28)] [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-accent-hi", mobile && "text-[13px]")}>
      {icon}
      {children}
    </div>
  );
}

/** Every agent, the thread's repository first, then by lane (Needs you first), newest first. */
function useAgentChoices(repo: string | null): AgentView[] {
  const agents = useCore((s) => s.agents);
  return useMemo(() => {
    const repoName = repo ? basename(repo).toLowerCase() : null;
    const here = (a: AgentView) => !!repoName && (a.repo?.toLowerCase() === repoName || (a.cwd ? basename(a.cwd).toLowerCase() === repoName : false));
    const lane = (a: AgentView) => LANE_ORDER.indexOf(a.column);
    return Object.values(agents)
      .filter((a): a is AgentView => !!a)
      .sort((a, b) => Number(here(b)) - Number(here(a)) || lane(a) - lane(b) || b.stateSince - a.stateSince);
  }, [agents, repo]);
}

/** Mounted only while open (it follows every agent's changes). */
function AgentPicker({ onClose, repo, onPick }: { onClose: () => void; repo: string | null; onPick: (key: string) => void }) {
  const choices = useAgentChoices(repo);
  return (
    <CommandDialog open onOpenChange={(o) => !o && onClose()} title={ACTIONS.sendToAgent.label}>
      <CommandInput placeholder="Send the task to which agent?" />
      <CommandList>
        <CommandEmpty>No agent matches.</CommandEmpty>
        <CommandGroup heading="Agents">
          {choices.map((a) => (
            <CommandItem
              key={a.key}
              value={`${a.name} ${a.title} ${a.repo ?? ""} ${a.branch ?? ""} ${a.key}`}
              icon={<AgentGlyph name={a.name} size={22} />}
              shortcut={agentStateWord(a)}
              onSelect={() => {
                onClose();
                onPick(a.key);
              }}
            >
              {a.name}
              <span className="ml-2 font-medium text-mute-2">{[a.title, a.repo ?? (a.cwd ? basename(a.cwd) : null)].filter(Boolean).join(" · ")}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
