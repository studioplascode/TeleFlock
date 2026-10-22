import type { Column } from "@/core/gen";
import type { Status } from "@/design";
import { LANE_LEGEND, LANE_ORDER, LANE_TITLE } from "@/features/shell/vocab";

/** Board lanes, left to right. `live` lanes are derived from agent state and refuse drops. */
export interface LaneMeta {
  column: Column;
  title: string;
  status: Status;
  /** Right-aligned lane legend: sort order and what each card's time means. */
  legend: string;
  live: boolean;
  empty: { title: string; description: string };
}

const STATUS: Record<Column, Status> = { needs: "needs-you", running: "running", review: "review", done: "done" };

const EMPTY: Record<Column, LaneMeta["empty"]> = {
  needs: { title: "Nobody is waiting on you", description: "Questions and approvals land here the moment they are asked." },
  running: { title: "Nothing running", description: "Start one with New task (D) or New worktree (N)." },
  review: { title: "Nothing to review", description: "Finished agents arrive here. Drag a Done card back to reopen it." },
  done: { title: "Nothing done yet", description: "Mark a reviewed card done, or drag it here." },
};

export const LANES: readonly LaneMeta[] = LANE_ORDER.map((column) => ({
  column,
  title: LANE_TITLE[column],
  status: STATUS[column],
  legend: LANE_LEGEND[column],
  live: column === "needs" || column === "running",
  empty: EMPTY[column],
}));

export const LANE_BY_COLUMN: Record<Column, LaneMeta> = Object.fromEntries(LANES.map((l) => [l.column, l])) as Record<Column, LaneMeta>;

/** Agents with no events for this long while working get the quiet/flatline treatment (spec §4). */
export const QUIET_AFTER_MS = 90_000;
