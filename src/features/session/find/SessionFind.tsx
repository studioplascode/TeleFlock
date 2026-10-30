import { useEffect, useMemo } from "react";
import { core, flushCoreEvents, getTranscript, loadOlder, parseAgentKey, useCore } from "@/core";
import type { TranscriptItem } from "@/core/gen";
import { useSessionUi } from "../state";
import { FindBar } from "./FindBar";
import type { FindSource } from "./source";
import { openFind, useFind } from "./store";

const NO_IDS: string[] = [];
const NO_ITEMS: Record<string, TranscriptItem> = {};

/**
 * Pages older rows of a session into the store until row `id` is loaded: in one step sized from
 * where the host has the row (`index` of `rows`) when known, else a few pages.
 */
export async function loadUntil(key: string, id: string, index: number | undefined, rows: number | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    flushCoreEvents();
    const t = getTranscript(key);
    if (t.items.some((it) => it.id === id)) return true;
    if (!t.hasMore) return false;
    const want = index != null && rows != null ? rows - t.items.length - index + 20 : 300;
    await loadOlder(key, Math.min(2000, Math.max(100, want)));
    flushCoreEvents();
    // Another page was already on its way (the user scrolled up): wait for it (the lib target predates Promise.withResolvers).
    if (getTranscript(key).items.length === t.items.length) await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** The session store as a find source: loaded rows, `session.find` for the rest, paging to reach them. */
function useSessionFindSource(key: string, enabled: boolean): FindSource {
  const ids = useCore((s) => (enabled ? (s.sessions[key]?.itemIds ?? NO_IDS) : NO_IDS));
  const items = useCore((s) => (enabled ? (s.sessions[key]?.items ?? NO_ITEMS) : NO_ITEMS));
  const hasMore = useCore((s) => enabled && (s.sessions[key]?.hasMore ?? false));
  return useMemo(() => {
    const { hostId, agentId } = parseAgentKey(key);
    return {
      ids,
      items,
      hasMore,
      search: (query, caseSensitive, before) => core.host(hostId).call("session.find", { agentId, query, caseSensitive, before }),
      loadUntil: (id, index, rows) => loadUntil(key, id, index, rows),
    };
  }, [key, ids, items, hasMore]);
}

/** Find over a session's transcript (mounted by SessionPane over the transcript). */
export function SessionFindBar({ agentKey, mobile }: { agentKey: string; mobile: boolean }) {
  const open = useFind(agentKey, (s) => s.open);
  const source = useSessionFindSource(agentKey, open);
  return <FindBar scope={agentKey} source={source} mobile={mobile} onClose={mobile ? undefined : () => useSessionUi.getState().focusComposer(agentKey)} />;
}

/** Text selected inside this session's transcript, when it reads as a find query (one short line). */
function selectedQuery(): string | undefined {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!sel || !text || text.length > 120 || text.includes("\n")) return undefined;
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest('[role="log"]') ? text : undefined;
}

/** Ctrl+F / Cmd+F opens Find on this session (the selection, if any, becomes the query). */
export function useFindHotkey(agentKey: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
      // A dialog or the palette owns the keyboard.
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [cmdk-root]')) return;
      e.preventDefault();
      openFind(agentKey, { query: selectedQuery() });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentKey, enabled]);
}
