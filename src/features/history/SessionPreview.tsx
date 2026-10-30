import { ChevronLeft, MessageSquareDashed, Search, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, toApiError } from "@/core";
import type { PastSession } from "@/core/gen";
import { Button, EmptyState, Shimmer, Spinner, cn, formatAge } from "@/design";
import { FindBar } from "../session/find/FindBar";
import { useTranscriptFind } from "../session/find/hooks";
import { FindScopeCtx } from "../session/find/reveal";
import type { FindSource } from "../session/find/source";
import { dropFind, openFind } from "../session/find/store";
import { ircThreadKey, isRailTool, ItemRow } from "../session/transcript/rows";
import { TranscriptLog } from "../session/transcript/Transcript";
import { tildify } from "../workspace/shared/paths";
import { append, hasNewer, hasOlder, prepend, type PreviewWindow, windowOf } from "./previewWindow";
import { previewScope } from "./searchModel";

/** Where the preview opens: the row (or time) of a snippet, with the query to highlight. */
export interface PreviewTarget {
  session: PastSession;
  query: string;
  rowId?: string;
  at?: number;
}

interface Props {
  hostId: string;
  target: PreviewTarget;
  home?: string;
  mobile: boolean;
  now: number;
  onBack: () => void;
}

/**
 * Read-only transcript of a past session's file (`search.read`), opened at a search match: a window
 * of rows around it, older rows paged in by scrolling up, newer ones by "Show later messages". Find
 * runs over the loaded rows with the query pre-filled. Resume / Fork / Open live are the dialog's
 * footer. Mount with a `key` of the target: it loads once.
 */
export function SessionPreview({ hostId, target, home, mobile, now, onBack }: Props) {
  const { session, query, rowId, at } = target;
  const file = session.file;
  const scope = previewScope(hostId, file);
  const [win, setWin] = useState<PreviewWindow | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [newerBusy, setNewerBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef<PreviewWindow | null>(null);
  const older = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    latest.current = win;
  }, [win]);

  useEffect(() => {
    let live = true;
    setError(null);
    core
      .host(hostId)
      .call("search.read", { file, ...(rowId ? { around: rowId } : {}), ...(at !== undefined ? { aroundAt: at } : {}) })
      .then(
        (r) => live && setWin(windowOf(r)),
        (e: unknown) => {
          const err = toApiError(e);
          if (live) setError({ message: err.message.split("\n")[0] ?? err.message, hint: err.hint });
        },
      );
    return () => {
      live = false;
    };
  }, [hostId, file, rowId, at, attempt]);

  // Find opens on the match once the rows are there (a bar mounted over no rows would find none).
  const loaded = win != null;
  useEffect(() => {
    if (loaded && query) openFind(scope, { query, target: { rowId, at } });
  }, [loaded, scope, query, rowId, at]);
  useEffect(() => () => dropFind(scope), [scope]);

  const loadOlder = useCallback((): Promise<void> => {
    if (older.current) return older.current;
    const first = latest.current?.ids[0];
    if (!first) return Promise.resolve();
    const p = core
      .host(hostId)
      .call("search.read", { file, before: first })
      .then(
        (r) => {
          if (alive.current) setWin((w) => w && prepend(w, r));
        },
        (e: unknown) => {
          if (alive.current) setPageError(toApiError(e).message);
        },
      )
      .finally(() => {
        older.current = null;
      });
    older.current = p;
    return p;
  }, [hostId, file]);

  const loadNewer = () => {
    const last = latest.current?.ids.at(-1);
    if (!last || newerBusy) return;
    setNewerBusy(true);
    setPageError(null);
    core
      .host(hostId)
      .call("search.read", { file, after: last })
      .then(
        (r) => alive.current && setWin((w) => w && append(w, r)),
        (e: unknown) => alive.current && setPageError(toApiError(e).message),
      )
      .finally(() => alive.current && setNewerBusy(false));
  };

  const source = useMemo<FindSource | null>(() => (win ? { ids: win.ids, items: win.items, hasMore: hasOlder(win) || hasNewer(win) } : null), [win]);
  const items = useMemo(() => (win ? win.ids.map((id) => win.items[id]) : []), [win]);
  const find = useTranscriptFind(scope);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && win) {
      e.preventDefault();
      openFind(scope);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" icon={<ChevronLeft />} onClick={onBack}>
          Back
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{session.title || <span className="font-semibold text-mute italic">Untitled session</span>}</p>
          <p className="truncate font-mono text-2xs text-mute-2">
            {session.cwd ? tildify(session.cwd, home) : session.file}
            <span className="font-sans tabular"> · {formatAge(now - session.updatedAt)}</span>
            {win && <span className="font-sans tabular"> · {win.rows} rows</span>}
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={<Search />} disabled={!win} onClick={() => openFind(scope)} aria-label="Find in this session">
          {mobile ? null : "Find"}
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg well">
        {error ? (
          <EmptyState
            compact
            className="h-full"
            icon={<TriangleAlert />}
            title="Couldn't open this session"
            description={error.hint ?? error.message}
            action={<Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}
          />
        ) : !win || !source ? (
          <div className="grid h-full place-items-center">
            <Spinner size={20} label="Opening the session" />
          </div>
        ) : (
          <>
            <FindBar scope={scope} source={source} mobile={mobile} />
            <FindScopeCtx.Provider value={scope}>
              <TranscriptLog
                ids={win.ids}
                items={items}
                ariaLabel="Past session transcript"
                padX={mobile ? 10 : 24}
                gutter={mobile ? 0 : 38}
                overscan={mobile ? 3 : 8}
                dense={mobile}
                hasMore={hasOlder(win)}
                onLoadOlder={loadOlder}
                find={find}
                renderRow={(id, prevId, nextId, rail) => {
                  const item = win.items[id];
                  if (!item) return null;
                  const prev = prevId == null ? undefined : win.items[prevId];
                  const next = nextId == null ? undefined : win.items[nextId];
                  const irc = ircThreadKey(item);
                  return (
                    <ItemRow
                      item={item}
                      rail={rail}
                      up={rail && isRailTool(prev)}
                      down={rail && isRailTool(next)}
                      ircPrev={irc != null && ircThreadKey(prev) === irc}
                      ircNext={irc != null && ircThreadKey(next) === irc}
                    />
                  );
                }}
                empty={<EmptyState className="mt-16" icon={<MessageSquareDashed />} title="No messages" description="This session file has no transcript rows." />}
                footer={
                  hasNewer(win) || pageError ? (
                    <div className={cn("flex flex-col items-center gap-2 pt-4 pb-1", mobile && "pb-2")}>
                      {pageError && <p className="text-xs text-error">Couldn't load more: {pageError}</p>}
                      {hasNewer(win) && (
                        <Button size={mobile ? "md" : "sm"} variant="secondary" onClick={loadNewer} disabled={newerBusy}>
                          {newerBusy ? <Shimmer>Loading…</Shimmer> : "Show later messages"}
                        </Button>
                      )}
                    </div>
                  ) : null
                }
                jumpLabel={() => "Jump to end"}
              />
            </FindScopeCtx.Provider>
          </>
        )}
      </div>
    </div>
  );
}
