import { motion } from "motion/react";
import { Split } from "lucide-react";
import { useMemo } from "react";
import { navigate, useHostState } from "@/core";
import type { Column } from "@/core/gen";
import { StatusOrb, type Status, cn, spring } from "@/design";
import { parseFanOutBranch } from "../worktree/FanOutDialog";
import { DiffBar } from "./diff/DiffViewer";

const COLUMN_STATUS: Record<Column, Status> = { running: "running", needs: "needs-you", review: "review", done: "done" };

/**
 * "Compare siblings": every worktree of the same fan-out (`fanout/<slug>/<variant>` branches in the
 * same repo) with its agent state and diffstat; click to review that variant. Renders nothing for
 * ordinary worktrees.
 */
export function FanOutSiblings({ hostId, workspaceId, className }: { hostId: string; workspaceId: string; className?: string }) {
  const host = useHostState(hostId);
  const siblings = useMemo(() => {
    const self = host?.workspaces.find((w) => w.id === workspaceId);
    const mine = parseFanOutBranch(self?.worktree?.branch);
    if (!host || !self || !mine) return null;
    const repo = self.repo?.root;
    return host.workspaces
      .filter((w) => w.repo?.root === repo && parseFanOutBranch(w.worktree?.branch)?.slug === mine.slug)
      .map((w) => {
        const agent = host.agents.find((a) => a.workspaceId === w.id);
        return { ws: w, variant: parseFanOutBranch(w.worktree?.branch)?.variant ?? w.label, agent, current: w.id === workspaceId };
      })
      .sort((a, b) => a.variant.localeCompare(b.variant));
  }, [host, workspaceId]);
  if (!siblings || siblings.length < 2) return null;
  const slug = parseFanOutBranch(siblings[0]?.ws.worktree?.branch)?.slug;

  return (
    <nav aria-label="Compare fan-out siblings" className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="flex shrink-0 items-center gap-1.5 text-2xs font-bold text-mute">
        <Split className="size-3.5 text-accent" />
        <span className="hidden sm:inline">Compare</span>
        <span className="font-mono text-mute-2">{slug}</span>
      </span>
      <div className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto rounded-md well p-1">
        {siblings.map((s) => (
          <button
            key={s.ws.id}
            type="button"
            aria-current={s.current ? "page" : undefined}
            onClick={() => !s.current && navigate({ name: "review", hostId, workspaceId: s.ws.id }, { replace: true })}
            title={s.agent ? `${s.agent.name} · ${s.agent.title}` : s.ws.label}
            className={cn("relative flex h-8 shrink-0 items-center gap-2 rounded-sm px-2.5 text-xs font-bold transition-colors focus-ring", s.current ? "text-ink" : "text-mute hover:text-ink")}
          >
            {s.current && <motion.span layoutId="fanout-sibling" transition={spring.snappy} className="absolute inset-0 rounded-sm bg-tile-4 shadow-d1" aria-hidden />}
            <span className="relative flex items-center gap-2">
              {s.agent && <StatusOrb status={COLUMN_STATUS[s.agent.column]} size={7} label={null} />}
              <span className="font-mono">{s.variant}</span>
              {s.agent?.diff ? <DiffBar added={s.agent.diff.added} removed={s.agent.diff.removed} compact /> : <span className="text-2xs font-normal text-mute-2">no diff</span>}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
