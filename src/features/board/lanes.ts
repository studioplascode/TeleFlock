import type { Column, NeedsKind } from "@/core/gen";
import type { Status } from "@/design";

/** Board lanes, left to right. `live` lanes are derived from agent state and refuse drops. */
export interface LaneMeta {
  column: Column;
  title: string;
  status: Status;
  /** Right-aligned lane caption (what the lane means). */
  hint: string;
  live: boolean;
  empty: { title: string; description: string };
}

export const LANES: readonly LaneMeta[] = [
  {
    column: "running",
    title: "Running",
    status: "running",
    hint: "working",
    live: true,
    empty: { title: "Nothing running", description: "Start an agent with N, or prompt one from its session." },
  },
  {
    column: "needs",
    title: "Needs you",
    status: "needs-you",
    hint: "blocked",
    live: true,
    empty: { title: "Nobody is waiting on you", description: "Questions and approvals land here the moment they are asked." },
  },
  {
    column: "review",
    title: "In review",
    status: "review",
    hint: "finished",
    live: false,
    empty: { title: "Nothing to review", description: "Finished agents arrive here. Drag a Done card back to reopen it." },
  },
  {
    column: "done",
    title: "Done",
    status: "done",
    hint: "archived",
    live: false,
    empty: { title: "No archived agents", description: "Drag a reviewed card here to archive it." },
  },
];

export const LANE_BY_COLUMN: Record<Column, LaneMeta> = Object.fromEntries(LANES.map((l) => [l.column, l])) as Record<Column, LaneMeta>;

/** Short uppercase badge for a needs-you reason. */
export const NEEDS_LABEL: Record<NeedsKind, string> = {
  ask: "Question",
  approval: "Approval",
  planReview: "Plan review",
  confirm: "Confirm",
  input: "Input",
  blocked: "Blocked",
  error: "Error",
};

/** Agents with no events for this long while working get the quiet/flatline treatment (spec §4). */
export const QUIET_AFTER_MS = 90_000;
