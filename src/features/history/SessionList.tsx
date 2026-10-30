import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { FolderGit2, MessagesSquare } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PastSession, SearchSnippet } from "@/core/gen";
import { StatusOrb, cn, formatAge, spring } from "@/design";
import { tildify } from "../workspace/shared/paths";
import { type Entry, snippetLabel } from "./searchModel";

export type GroupBy = "date" | "repo";

/**
 * One line of the list. `stop` is the keyboard position of a session row; its snippets follow it
 * (`stop + 1 + k`), so ↑/↓ walk the sessions and the matches of each in reading order.
 */
export type ListRow = { t: "head"; key: string; label: string; count: number; live?: boolean } | { t: "item"; key: string; e: Entry; repo: string; i: number; stop: number };

export const HEADER_H = 34;
export const ROW_H = 58;
/** Estimated height of a snippet line (they wrap to two lines at most; the measured size replaces it). */
export const SNIPPET_H = 40;

export interface SessionListProps {
  rows: ListRow[];
  /** The keyboard stop (a session row, or one of its snippets). */
  active: number;
  selected: string | null;
  needle: string;
  groupBy: GroupBy;
  home?: string;
  now: number;
  onHover: (stop: number) => void;
  onSelect: (s: PastSession) => void;
  onOpen: (s: PastSession) => void;
  /** A snippet was picked: open the session at that match. */
  onSnippet: (s: PastSession, sn: SearchSnippet) => void;
}

/** Id of the element of a stop (`aria-activedescendant`). */
export function stopId(s: PastSession, k: number): string {
  return k < 0 ? `ps-${s.id}` : `ps-${s.id}-${k}`;
}

/** Virtualized, grouped session list; rows with content hits grow by their snippets. */
export function SessionList({ rows, active, selected, needle, groupBy, home, now, onHover, onSelect, onOpen, onSnippet }: SessionListProps) {
  // TanStack Virtual mutates one virtualizer instance per scroll; compiler memoization would freeze it.
  "use no memo";
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      return r?.t === "item" ? ROW_H + (r.e.hit?.snippets.length ?? 0) * SNIPPET_H : HEADER_H;
    },
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
  });
  const activeRow = rows.findIndex((r) => r.t === "item" && active >= r.stop && active <= r.stop + (r.e.hit?.snippets.length ?? 0));

  useEffect(() => {
    if (activeRow < 0) return;
    // keep the group header visible when moving onto a group's first session
    virtualizer.scrollToIndex(rows[activeRow - 1]?.t === "head" ? activeRow - 1 : activeRow, { align: "auto" });
  }, [activeRow, rows, virtualizer]);

  return (
    <div ref={scrollRef} id="past-sessions-list" role="listbox" aria-label="Sessions" className="h-full overflow-y-auto overscroll-contain p-1.5">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const r = rows[vi.index] as ListRow;
          const place = { transform: `translateY(${vi.start}px)` };
          if (r.t === "head") {
            return (
              <div key={vi.key} data-index={vi.index} ref={virtualizer.measureElement} role="presentation" className="absolute inset-x-0 top-0 flex items-center gap-2 px-2.5 pt-2" style={{ ...place, height: HEADER_H }}>
                {r.live ? <StatusOrb status="running" size={6} label={null} /> : groupBy === "repo" ? <FolderGit2 className="size-3 text-mute-2" /> : null}
                <span className={cn("kicker", r.live && "text-accent-hi")}>{r.label}</span>
                <span className="text-2xs font-semibold text-mute-2 tabular">{r.count}</span>
              </div>
            );
          }
          const { s } = r.e;
          const snippets = r.e.hit?.snippets ?? [];
          const matches = r.e.hit?.matches ?? 0;
          const isSel = s.file === selected;
          const isActive = active === r.stop;
          return (
            <div key={vi.key} data-index={vi.index} ref={virtualizer.measureElement} role="presentation" className="absolute inset-x-0 top-0" style={place}>
              <div
                id={stopId(s, -1)}
                role="option"
                aria-selected={isSel}
                onPointerMove={() => active !== r.stop && onHover(r.stop)}
                onClick={() => onSelect(s)}
                onDoubleClick={() => onOpen(s)}
                className="relative h-[58px] cursor-pointer select-none"
              >
                {(isActive || isSel) && (
                  <motion.span
                    layoutId={isSel ? undefined : "ps-active"}
                    transition={spring.snappy}
                    className={cn("absolute inset-0.5 rounded-md", isSel ? "bg-accent/14 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.5),0_0_22px_-10px_rgb(163_92_240/0.9)]" : "bg-white/5")}
                    aria-hidden
                  />
                )}
                <div className="relative flex h-full items-center gap-3 px-3">
                  <span className="grid size-5 shrink-0 place-items-center">
                    {s.live ? <StatusOrb status="running" size={9} label={null} /> : <MessagesSquare className={cn("size-4", isSel ? "text-accent" : "text-mute-2")} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-bold">{s.title ? <Highlight text={s.title} needle={needle} /> : <span className="font-semibold text-mute italic">Untitled session</span>}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-2xs text-mute-2">
                      {groupBy === "date" && <span className="shrink-0 rounded-xs bg-white/6 px-1.5 py-px font-semibold text-ink-2">{r.repo}</span>}
                      <span className="truncate font-mono">{s.cwd ? <Highlight text={tildify(s.cwd, home)} needle={needle} /> : s.file}</span>
                      {s.messages !== undefined && <span className="shrink-0 tabular">· {s.messages} msgs</span>}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <span className="text-2xs text-mute tabular">{formatAge(now - s.updatedAt)}</span>
                    {matches > 0 ? (
                      <span className="text-2xs font-bold text-accent-hi tabular">{matches >= 1000 ? "1000+" : matches} {matches === 1 ? "match" : "matches"}</span>
                    ) : (
                      s.live && <span className="text-2xs font-bold text-accent-hi">live</span>
                    )}
                  </span>
                </div>
              </div>
              {snippets.map((sn, k) => {
                const stop = r.stop + 1 + k;
                return (
                  <div
                    key={k}
                    id={stopId(s, k)}
                    role="option"
                    aria-selected={false}
                    aria-label={`${snippetLabel(sn)}: ${sn.before}${sn.hit}${sn.after}`}
                    onPointerMove={() => active !== stop && onHover(stop)}
                    onClick={() => onSnippet(s, sn)}
                    className="relative mr-1 mb-0.5 ml-11 cursor-pointer select-none"
                  >
                    {active === stop && <span className="absolute inset-0 rounded-md bg-white/6 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.45)]" aria-hidden />}
                    <div className="relative flex items-start gap-2 px-2 py-1.5">
                      <span className="mt-px w-[68px] shrink-0 truncate rounded-xs bg-white/6 px-1.5 py-px text-center text-2xs font-semibold text-ink-2">{snippetLabel(sn)}</span>
                      <span className="line-clamp-2 min-w-0 text-xs break-words text-mute">
                        {sn.before}
                        <mark className="rounded-[3px] bg-accent/30 text-ink">{sn.hit}</mark>
                        {sn.after}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** First case-insensitive occurrence of `needle` in `text`, marked. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-accent/30 text-ink">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}
