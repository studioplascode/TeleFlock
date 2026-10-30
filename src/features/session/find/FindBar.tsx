import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { isApiError } from "@/core";
import { cn, IconButton, Shimmer, spring, tween } from "@/design";
import { needleOf } from "./match";
import { keep, matchRows, newest, ordinal, resolveTarget, step, totalOf, type MatchRow } from "./model";
import type { FindSource } from "./source";
import { closeFind, type FindState, findState, matchKey, useFind, useFindStore } from "./store";

export interface FindBarProps {
  /** Find scope: the agent key of a session transcript, or a view's own key. */
  scope: string;
  source: FindSource;
  /** Phone layout: a full-width bar with larger targets. */
  mobile?: boolean;
  /** After Esc / the close button (e.g. give the composer its focus back). */
  onClose?: () => void;
  className?: string;
}

/**
 * Find in a transcript: a bar over the transcript while Find is open on `scope`. Counts every
 * occurrence in the loaded rows and, through `source.search`, in the rows the host has not sent
 * yet; stepping onto one of those pages the rows in first. Enter walks up to older matches,
 * Shift+Enter down; the count starts at the newest.
 */
export function FindBar(props: FindBarProps) {
  const open = useFind(props.scope, (s) => s.open);
  return <AnimatePresence>{open && <Bar key="find" {...props} />}</AnimatePresence>;
}

const REMOTE_DEBOUNCE_MS = 250;

function sameRows(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function Bar({ scope, source, mobile = false, onClose, className }: FindBarProps) {
  const query = useFind(scope, (s) => s.query);
  const caseSensitive = useFind(scope, (s) => s.caseSensitive);
  const active = useFind(scope, (s) => s.active);
  const remote = useFind(scope, (s) => s.remote);
  const remoteStatus = useFind(scope, (s) => s.remoteStatus);
  const loading = useFind(scope, (s) => s.loading);
  const focus = useFind(scope, (s) => s.focus);
  const patch = (p: Partial<FindState>) => useFindStore.getState().patch(scope, p);
  const input = useRef<HTMLInputElement>(null);
  // Effects read the latest source (its callbacks close over the newest rows).
  const src = useRef(source);
  useLayoutEffect(() => {
    src.current = source;
  });
  const failedLoad = useRef<string | null>(null);

  const needle = useMemo(() => needleOf(query, caseSensitive), [query, caseSensitive]);
  const key = matchKey(query, caseSensitive);
  const remoteHere = remote?.key === key ? remote : null;
  const rows: MatchRow[] = useMemo(() => (needle ? matchRows(source.ids, source.items, needle, remoteHere) : []), [needle, source.ids, source.items, remoteHere]);
  const total = totalOf(rows);
  const canSearchHost = source.search != null && source.hasMore;
  const remotePending = needle != null && canSearchHost && remoteHere == null && (remoteStatus === "idle" || remoteStatus === "searching");

  // Focus (and select) the field on open and on every Ctrl+F while open.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focus]);

  // The rows the transcript paints: the loaded matching rows.
  useEffect(() => {
    const loaded = new Set(rows.flatMap((r) => (r.loaded ? [r.id] : [])));
    if (!sameRows(loaded, findState(scope).rows)) patch({ rows: loaded });
  }, [rows]);

  // Ask the host about the rows it has not sent (once per query; loaded rows are counted here).
  // A host without `session.find` said so once: the next queries search the loaded rows only.
  useEffect(() => {
    if (!needle || !canSearchHost || remoteHere || findState(scope).remoteStatus === "unsupported") return;
    const t = window.setTimeout(() => {
      const search = src.current.search;
      if (!search) return;
      patch({ remoteStatus: "searching" });
      search(query, caseSensitive, src.current.ids[0]).then(
        (res) => {
          const now = findState(scope);
          if (matchKey(now.query, now.caseSensitive) !== key) return;
          patch({ remote: { key, hits: res.hits, rows: res.rows, truncated: res.truncated }, remoteStatus: "done" });
        },
        (e: unknown) => {
          const now = findState(scope);
          if (matchKey(now.query, now.caseSensitive) !== key) return;
          patch({ remoteStatus: isApiError(e) && e.code === "unknown_method" ? "unsupported" : "error" });
        },
      );
    }, REMOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [key, needle, canSearchHost, remoteHere]);

  // Keep a current match: the newest at first (or the open-at-match target), then the same one
  // while rows stream in; only a fresh choice jumps.
  useEffect(() => {
    const st = findState(scope);
    if (!needle || rows.length === 0) {
      if (st.active && !remotePending) patch({ active: null });
      return;
    }
    if (st.target) {
      // The target's row; its time only once the host has answered: before that, the first
      // loaded match after it would win over the target row the host has not listed yet.
      const hit = resolveTarget(rows, remotePending ? { rowId: st.target.rowId } : st.target);
      if (!hit && remotePending) return;
      patch({ active: hit ?? newest(rows), target: undefined, nonce: st.nonce + 1 });
      return;
    }
    const next = st.active ? keep(rows, st.active, source.ids) : newest(rows);
    if (next?.id !== st.active?.id || next?.n !== st.active?.n) patch({ active: next, nonce: st.active ? st.nonce : st.nonce + 1 });
  }, [rows, needle, remotePending]);

  // The current match is in a row not loaded yet: page older rows in until it is.
  const activeRow = active ? rows.find((r) => r.id === active.id) : undefined;
  const unloaded = activeRow != null && !activeRow.loaded;
  useEffect(() => {
    if (!unloaded || !activeRow || loading || failedLoad.current === activeRow.id) return;
    const loadUntil = src.current.loadUntil;
    if (!loadUntil) return;
    const id = activeRow.id;
    patch({ loading: true });
    void loadUntil(id, activeRow.index, remoteHere?.rows)
      .catch(() => false)
      .then((found) => {
        if (!found) failedLoad.current = id;
        patch({ loading: false, nonce: findState(scope).nonce + 1 });
      });
  }, [unloaded, activeRow?.id]);

  const go = (dir: "older" | "newer") => {
    const st = findState(scope);
    const next = step(rows, st.active, dir);
    if (next) patch({ active: next, nonce: st.nonce + 1 });
  };
  // A new query or case mode: no current match yet, and the host's answer for it still to come
  // (not the last query's: its count would flash "No results" until the new search starts).
  const requery = (p: Pick<FindState, "query"> | Pick<FindState, "caseSensitive">) =>
    patch({ ...p, active: null, target: undefined, remoteStatus: findState(scope).remoteStatus === "unsupported" ? "unsupported" : "idle" });
  const close = () => {
    closeFind(scope);
    onClose?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" || e.key === "F3") {
      e.preventDefault();
      go(e.shiftKey ? "newer" : "older");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      input.current?.select();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      go(e.shiftKey ? "newer" : "older");
    }
  };

  const at = ordinal(rows, active);
  const more = remoteHere?.truncated ? "+" : "";
  const count = !needle ? "" : total === 0 ? (remotePending ? "" : "No results") : `${at || "–"}/${total}${more}`;
  const hint = !needle
    ? null
    : loading
      ? "Loading earlier messages…"
      : remotePending && remoteStatus === "searching"
        ? "Searching earlier messages…"
        : remoteStatus === "unsupported"
          ? "Earlier messages aren't searched: update TeleFlock on this host"
          : remoteStatus === "error"
            ? "Couldn't search earlier messages"
            : failedLoad.current != null && failedLoad.current === active?.id
              ? "That message is no longer in the session"
              : source.hasMore && !source.search
                ? "Searching the loaded messages"
                : null;

  return (
    <motion.div
      role="search"
      aria-label="Find in transcript"
      initial={{ opacity: 0, y: -10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: tween.fast }}
      transition={spring.snappy}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute z-raised flex flex-col rounded-md bg-[linear-gradient(180deg,rgb(34_34_46/0.97),rgb(25_25_33/0.97))] shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)] backdrop-blur-xl",
        mobile ? "inset-x-2 top-1.5" : "top-2 right-3 w-[380px] max-w-[calc(100%-24px)]",
        className,
      )}
      data-no-swipe
    >
      <div className={cn("flex items-center gap-1 p-1 pl-2.5", mobile && "gap-0.5 pl-3")}>
        <Search className="size-3.5 shrink-0 text-mute-2" aria-hidden />
        <input
          ref={input}
          value={query}
          onChange={(e) => requery({ query: e.target.value })}
          placeholder="Find in transcript"
          aria-label="Find in transcript"
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="search"
          // Inside a dialog, Esc closes the find bar first (ResponsiveDialog keeps itself open).
          data-esc-clears
          className={cn("h-8 min-w-0 flex-1 bg-transparent pl-1 text-ink outline-none placeholder:text-mute-2", mobile ? "text-[15px]" : "text-[13px]")}
        />
        <span
          aria-live="polite"
          className={cn("min-w-12 shrink-0 text-right font-mono text-2xs font-bold tabular-nums", needle && total === 0 && !remotePending ? "text-[#ff8aa5]" : "text-mute")}
        >
          {count || (remotePending ? <Shimmer>…</Shimmer> : null)}
        </span>
        <IconButton
          size={mobile ? "md" : "sm"}
          label="Match case"
          aria-pressed={caseSensitive}
          className={cn(caseSensitive && "bg-accent/22 text-accent-ink")}
          onClick={() => requery({ caseSensitive: !caseSensitive })}
        >
          <CaseSensitive />
        </IconButton>
        <IconButton size={mobile ? "md" : "sm"} label="Older match (Enter)" disabled={total === 0} onClick={() => go("older")}>
          <ChevronUp />
        </IconButton>
        <IconButton size={mobile ? "md" : "sm"} label="Newer match (Shift+Enter)" disabled={total === 0} onClick={() => go("newer")}>
          <ChevronDown />
        </IconButton>
        <IconButton size={mobile ? "md" : "sm"} label="Close find (Esc)" onClick={close}>
          <X />
        </IconButton>
      </div>
      {hint && <div className="border-t border-line px-3 py-1 text-2xs font-semibold text-mute-2">{hint}</div>}
    </motion.div>
  );
}
