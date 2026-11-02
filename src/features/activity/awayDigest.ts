import { formatUsd } from "@/design/lib/format";

/** What happened on a host while the app was away from it (`WhileAwayToast`). */
export interface AwayCounts {
  /** Turns that finished, and questions asked, in the gap (`host.activity`). */
  finished: number;
  asked: number;
  /** Agents in Needs you now. */
  needsNow: number;
  /** Questions decide for me answered in the gap that nobody reviewed yet (`HostInfo.decisions`). */
  decided: number;
  /** Spent in the gap; null when the cost before it is unknown. */
  spent: number | null;
}

export interface AwayDigest {
  /** "finished 2 · needs you 1 · decided 3 questions for you · spent $1.20". */
  parts: string[];
  status: "needs-you" | "review" | "running";
  /** Answer next while something needs you, else Review (the Inbox's decisions), else Activity. */
  action: "answer" | "review" | "activity";
}

/** The "While you were away" digest, or null when nothing happened worth a toast. */
export function awayDigest(c: AwayCounts): AwayDigest | null {
  if (c.finished === 0 && c.needsNow === 0 && c.asked === 0 && c.decided === 0 && (c.spent === null || c.spent < 0.005)) return null;
  const parts = [
    `finished ${c.finished}`,
    `needs you ${c.needsNow}`,
    ...(c.decided > 0 ? [`decided ${c.decided} question${c.decided === 1 ? "" : "s"} for you`] : []),
    ...(c.spent !== null ? [`spent ${formatUsd(c.spent)}`] : []),
  ];
  return {
    parts,
    status: c.needsNow > 0 ? "needs-you" : c.finished > 0 || c.decided > 0 ? "review" : "running",
    action: c.needsNow > 0 ? "answer" : c.decided > 0 ? "review" : "activity",
  };
}
