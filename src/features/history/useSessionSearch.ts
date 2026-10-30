import { useEffect, useRef, useState } from "react";
import { core } from "@/core";
import { applyPage, DEBOUNCE_MS, failed, IDLE, SEARCHING, type SearchRun, type SearchState, searchQuery, startSearch } from "./searchModel";

/**
 * Full-text search over every session of a host (`search.start` / `search.poll`), for the Past
 * sessions dialog. Starts `DEBOUNCE_MS` after the query settles (at least two non-space characters),
 * long-polls until the host reports the end, and cancels on a new query, host, folder scope or
 * unmount. Answers of a superseded search are ignored; only one search runs at a time. No polling
 * happens while `enabled` is false or after the search ended.
 */
export function useSessionSearch(hostId: string | undefined, query: string, cwd: string | undefined, enabled = true): SearchState {
  const q = enabled && hostId ? searchQuery(query) : null;
  const key = q === null ? null : `${hostId}\u0000${cwd ?? ""}\u0000${q}`;
  const [answer, setAnswer] = useState<{ key: string | null; state: SearchState }>({ key: null, state: IDLE });
  // the run before this one: the next search waits for its pending request to end
  const last = useRef<SearchRun | null>(null);

  useEffect(() => {
    if (key === null || q === null || !hostId) return;
    let run: SearchRun | undefined;
    let state = SEARCHING;
    const timer = window.setTimeout(() => {
      run = startSearch(
        core.host(hostId),
        { query: q, cwd },
        {
          page: (page) => {
            state = applyPage(state, page);
            setAnswer({ key, state });
          },
          error: (e) => {
            state = failed(state, e);
            setAnswer({ key, state });
          },
        },
        last.current?.settled,
      );
      last.current = run;
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      run?.cancel();
    };
  }, [key, q, hostId, cwd]);

  if (key === null) return IDLE;
  return answer.key === key ? answer.state : SEARCHING;
}
