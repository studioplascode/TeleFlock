import { ChevronDown, ChevronUp } from "lucide-react";
import { motion } from "motion/react";
import { createContext, type ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { cn, spring } from "@/design";

/** One line of the board's notice box (the strips share one box instead of stacking boxes). */
export const noticeRow = "flex items-center gap-3 px-4 py-2 text-xs max-md:px-3";

/** The notice box: one box however many rows, gone when empty. */
export const noticeBox = "divide-y divide-line overflow-hidden rounded-lg bg-white/[0.02] shadow-[inset_0_0_0_1px_var(--color-line-2)] empty:hidden";

/** How a notice row comes and goes. */
export const noticeRise = { initial: { opacity: 0, y: -8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: spring.smooth } as const;

/**
 * Notice kinds, most urgent first (the rows are drawn in this order too): a host that isn't online (its
 * cards are a read-only snapshot), a host whose omp has no account (nothing runs there), a setup gap
 * (agents or their states hidden), the demo.
 */
const KINDS = ["stale", "accounts", "setup", "demo"] as const;
export type NoticeKind = (typeof KINDS)[number];

/** Sort key of a notice: its kind's urgency, then its host's place in the host list. */
export function noticeRank(kind: NoticeKind, order = 0): number {
  return KINDS.indexOf(kind) * 10_000 + order;
}

/** The most urgent of the notices on show (lowest rank, then key) and how many others there are. */
export function trayTop(ranks: Readonly<Record<string, number>>): { top?: string; more: number } {
  let top: string | undefined;
  let best = Number.POSITIVE_INFINITY;
  const keys = Object.keys(ranks);
  for (const key of keys) {
    const rank = ranks[key]!;
    if (rank < best || (rank === best && top !== undefined && key < top)) {
      top = key;
      best = rank;
    }
  }
  return { top, more: Math.max(0, keys.length - 1) };
}

interface Tray {
  /** Only the most urgent notice shows, on one line, until the user expands the tray. */
  collapsed: boolean;
  top?: string;
  more: number;
  report(key: string, rank: number | null): void;
  expand(): void;
}

const TrayContext = createContext<Tray | null>(null);

/** How a notice shows: its full row, the folded tray's one line, or not at all. */
export type NoticeView = "row" | "line" | null;

/**
 * Where a notice shows. `rank` ({@link noticeRank}) while it has something to say, null while it hasn't.
 * Outside a tray (desktop board) every notice is a full row; a folded tray shows only its most urgent
 * notice, as a line. Every notice stays mounted either way, so its own checks keep running.
 */
export function useNoticeView(key: string, rank: number | null): NoticeView {
  const tray = useContext(TrayContext);
  const report = tray?.report;
  // Before paint: the tray picks its line in the same frame a notice appears.
  useLayoutEffect(() => {
    if (!report || rank === null) return;
    report(key, rank);
    return () => report(key, null);
  }, [report, key, rank]);
  if (rank === null) return null;
  if (!tray?.collapsed) return "row";
  return tray.top === key ? "line" : null;
}

/** The folded tray: the most urgent notice on one line, its primary action, and the expander ("+N"). */
export function NoticeLine({ icon, children, action, className }: { icon: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  const tray = useContext(TrayContext);
  const more = tray?.more ?? 0;
  return (
    <motion.div {...noticeRise} role="status" className={cn("flex min-h-11 items-center gap-2 py-1 pr-1.5 pl-3 text-xs", className)}>
      {icon}
      <p className="min-w-0 flex-1 truncate text-mute">{children}</p>
      {action}
      <button
        type="button"
        aria-expanded={false}
        aria-label={more > 0 ? `Show all ${more + 1} notices` : "Show the whole notice"}
        onClick={tray?.expand}
        className="flex h-8 min-w-8 shrink-0 items-center justify-center gap-0.5 rounded-full bg-white/[0.06] px-2 text-2xs font-bold text-mute tabular pressable focus-ring hover:text-ink"
      >
        {more > 0 && `+${more}`}
        <ChevronDown className="size-4" />
      </button>
    </motion.div>
  );
}

/**
 * Phone notices: the notice rows folded into one line (the most urgent notice, its primary action and
 * "+N") until the user expands them to the full rows. One box; gone when nothing has anything to say.
 */
export function NoticeTray({ children }: { children: ReactNode }) {
  const [ranks, setRanks] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);
  const report = useCallback((key: string, rank: number | null) => {
    setRanks((r) => {
      if (rank !== null) return r[key] === rank ? r : { ...r, [key]: rank };
      if (!(key in r)) return r;
      const { [key]: _gone, ...rest } = r;
      return rest;
    });
  }, []);
  const { top, more } = trayTop(ranks);
  // Nothing left to say: the next notice starts folded again.
  if (open && top === undefined) setOpen(false);
  const tray = useMemo<Tray>(() => ({ collapsed: !open, top, more, report, expand: () => setOpen(true) }), [open, top, more, report]);
  return (
    <TrayContext.Provider value={tray}>
      <div className={noticeBox}>
        {children}
        {open && top !== undefined && (
          <button
            type="button"
            aria-expanded
            onClick={() => setOpen(false)}
            className="flex min-h-9 w-full items-center justify-center gap-1 text-2xs font-bold text-mute pressable focus-ring hover:text-ink"
          >
            Show less <ChevronUp className="size-3.5" />
          </button>
        )}
      </div>
    </TrayContext.Provider>
  );
}
