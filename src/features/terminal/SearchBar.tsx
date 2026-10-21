import type { SearchAddon } from "@xterm/addon-search";
import { motion } from "motion/react";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDraft } from "@/core";
import { IconButton, cn, spring, tween } from "@/design";

/** Search highlight colours (the addon wants #RRGGBB). */
const DECORATIONS = {
  matchBackground: "#3b2a55",
  matchBorder: "#7d3fd0",
  matchOverviewRuler: "#a35cf0",
  activeMatchBackground: "#a35cf0",
  activeMatchBorder: "#f053d0",
  activeMatchColorOverviewRuler: "#f053d0",
};

export interface SearchBarProps {
  search: SearchAddon;
  /** Bumps on every frame so matches follow the live screen. */
  frameTick: number;
  onClose(): void;
  /** Draft key the query persists under (per host + terminal target). */
  draftKey: string;
}

/**
 * Ctrl+F search over the terminal screen. herdr re-renders the viewport (scrollback 0), so this
 * searches what is on screen; scroll (wheel / PageUp) to bring older output into view.
 */
export function SearchBar({ search, frameTick, onClose, draftKey }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useDraft(draftKey);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number }>({ index: -1, count: 0 });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const sub = search.onDidChangeResults((r) => setResult({ index: r.resultIndex, count: r.resultCount }));
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const opts = { caseSensitive, decorations: DECORATIONS };
  const find = (dir: "next" | "prev", incremental = false) => {
    if (!query) {
      search.clearDecorations();
      setResult({ index: -1, count: 0 });
      return;
    }
    if (dir === "next") search.findNext(query, { ...opts, incremental });
    else search.findPrevious(query, opts);
  };

  // A new query or case mode needs fresh matches (the addon caches them by search term only).
  useEffect(() => {
    search.clearDecorations();
    find("next", true);
  }, [query, caseSensitive]);
  // New frames repaint the screen: re-run so the highlights follow the text.
  useEffect(() => find("next", true), [frameTick]);

  const label = !query ? "" : result.count === 0 ? "No results" : result.index >= 0 ? `${result.index + 1}/${result.count}` : `${result.count}+`;

  return (
    <motion.div
      role="search"
      aria-label="Search terminal"
      initial={{ opacity: 0, y: -10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: tween.fast }}
      transition={spring.snappy}
      className="absolute top-2 right-3 z-raised flex items-center gap-1 rounded-md bg-[linear-gradient(180deg,rgb(34_34_46/0.97),rgb(25_25_33/0.97))] p-1 pl-2.5 shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)] backdrop-blur-xl"
      // Keep clicks here from bubbling to the pane, which focuses the terminal on click.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "Enter") {
          e.preventDefault();
          find(e.shiftKey ? "prev" : "next");
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          inputRef.current?.select();
        }
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find on screen"
        aria-label="Find on screen"
        spellCheck={false}
        className="h-7 w-44 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-mute-2"
      />
      <span
        aria-live="polite"
        className={cn("min-w-14 text-right font-mono text-2xs font-bold tabular-nums", query && result.count === 0 ? "text-[#ff8aa5]" : "text-mute")}
      >
        {label}
      </span>
      <IconButton
        size="sm"
        label="Match case"
        aria-pressed={caseSensitive}
        className={cn(caseSensitive && "bg-accent/22 text-accent-ink")}
        onClick={() => setCaseSensitive((c) => !c)}
      >
        <CaseSensitive />
      </IconButton>
      <IconButton size="sm" label="Previous match (Shift+Enter)" disabled={!result.count} onClick={() => find("prev")}>
        <ChevronUp />
      </IconButton>
      <IconButton size="sm" label="Next match (Enter)" disabled={!result.count} onClick={() => find("next")}>
        <ChevronDown />
      </IconButton>
      <IconButton size="sm" label="Close search (Esc)" onClick={onClose}>
        <X />
      </IconButton>
    </motion.div>
  );
}
