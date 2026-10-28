import { useEffect, useMemo, useRef } from "react";
import { useColumnKeys, useCore, useHosts, useUi } from "@/core";
import { cn, useMediaQuery, useMinWidth } from "@/design";
import { WhileAwayToast } from "@/features/activity/WhileAwayToast";
import { BentoStrip, FirstStepsTile, HostsTile, LiveTerminalTile, StatsTile } from "./BentoRow";
import { BoardToolbar, useRepoNames } from "./BoardToolbar";
import { useBoard } from "./boardStore";
import { useFirstStepsView } from "./firstSteps";
import { Kanban, type LaneKeys, applyMoves, arrangementOf } from "./Kanban";
import { LANES } from "./lanes";
import { RepoBoard } from "./RepoBoard";
import { BoardNotices } from "./Notices";
import { useBoardKeys } from "./useBoardKeys";
import { useBoardCommands } from "./useBoardCommands";
import { SelectionBar } from "./SelectionBar";

const COLUMN_RANK = { needs: 0, running: 1, review: 2, done: 3 } as const;

/** Keyboard order for group-by-repo: repos alphabetically, then needs → running → review → done. */
function useRepoOrder(repos: string[], hostId: string, q: string): string[][] {
  const joined = useCore((s) => {
    const needle = q.trim().toLowerCase();
    return repos
      .map((r) =>
        Object.values(s.agents)
          .filter(
            (a) =>
              a.repo === r &&
              (hostId === "all" || a.hostId === hostId) &&
              (!needle || `${a.name} ${a.title} ${a.branch ?? ""}`.toLowerCase().includes(needle)),
          )
          .sort((a, b) => COLUMN_RANK[a.column] - COLUMN_RANK[b.column])
          .map((a) => a.key)
          .join(" "),
      )
      .join("\n");
  });
  return useMemo(() => (joined ? joined.split("\n").map((g) => (g ? g.split(" ") : [])) : []), [joined]);
}

/** Desktop home: bento summary row (one strip on short windows) above the four-lane kanban. */
export function BoardView() {
  const hostId = useHosts((s) => s.filter);
  const repo = useBoard((s) => s.repo);
  const q = useBoard((s) => s.q);
  const groupBy = useBoard((s) => s.groupBy);
  const moves = useBoard((s) => s.moves);
  const selectedKey = useUi((s) => s.selectedKey);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const roomy = useMinWidth(rootRef, 1130);
  // Beside an open split the board gets narrow: the bento row steps aside so the lanes keep their height.
  const bento = useMinWidth(rootRef, 760);
  // Short windows (the `short:` variant: ≤ 820 px tall, e.g. 1280×720) get the same facts in one ~72 px strip.
  const short = useMediaQuery("(min-width: 768px) and (max-height: 820px)");
  const firstSteps = useFirstStepsView();

  const filter = { hostId, repo: repo ?? undefined, q: q.trim() || undefined };
  const running = useColumnKeys("running", filter);
  const needs = useColumnKeys("needs", filter);
  const review = useColumnKeys("review", filter);
  const done = useColumnKeys("done", filter);
  const lanes = useMemo<LaneKeys>(() => ({ running, needs, review, done }), [running, needs, review, done]);
  const view = useMemo(() => applyMoves(lanes, moves), [lanes, moves]);

  const repos = useRepoNames(hostId);
  const shownRepos = repo ? repos.filter((r) => r === repo) : repos;
  const repoOrder = useRepoOrder(shownRepos, hostId, q);
  const statusOrder = useMemo(() => LANES.map((l) => view[l.column]), [view]);
  const groups = groupBy === "repo" ? repoOrder : statusOrder;
  useBoardKeys(groups, searchRef);
  useBoardCommands(review, searchRef);
  // Shift-click ranges follow what's on screen
  useEffect(() => useBoard.getState().setOrder(groups.flat()), [groups]);
  useEffect(() => () => useBoard.getState().clearPicked(), []);

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col gap-3 p-4 [--bento-h:212px] short:gap-2.5 short:p-3">
      <BoardToolbar searchRef={searchRef} />
      <BoardNotices />
      {bento && short && <BentoStrip firstSteps={firstSteps} live={roomy} />}
      {/* Under ~1130px of board the live terminal tile steps aside (unmounted). */}
      {bento && !short && (
        // minmax(0,…): a long line must never push a tile wider than its share.
        <div
          className={cn(
            "grid shrink-0 gap-3",
            firstSteps
              ? roomy
                ? "grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.25fr)]"
                : "grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.1fr)]"
              : roomy
                ? "grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1.7fr)] min-[2400px]:grid-cols-[minmax(0,440px)_minmax(0,520px)_minmax(0,1fr)]"
                : "grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]",
          )}
        >
          {firstSteps && <FirstStepsTile view={firstSteps} />}
          <StatsTile />
          <HostsTile />
          {roomy && <LiveTerminalTile />}
        </div>
      )}
      {groupBy === "repo" ? (
        <RepoBoard repos={shownRepos} filter={{ hostId, q }} selectedKey={selectedKey} arrangement={arrangementOf(view)} />
      ) : (
        <Kanban lanes={lanes} selectedKey={selectedKey} />
      )}
      <WhileAwayToast />
      <SelectionBar />
    </div>
  );
}
