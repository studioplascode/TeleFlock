# Past sessions (dialog, owner: Search)

The sessions omp has written on one host, listed to resume or fork (`host.sessions` + `host.resume`),
now with **full-text search across every session file** (`search.*`, tf-hostd ≥ 0.7.0) and a
read-only **preview** that opens at a match. Opened from the palette, the board and the sidebar's "Past sessions…"
(`openPastSessions({ hostId, cwd, workspaceId })`, scoped to a folder).

| File | Role |
|---|---|
| `PastSessionsDialog.tsx` | The dialog: host / group (Date, Repo) / folder-scope controls, one search box, the merged list, the footer (Resume / Fork / Open live agent, "Resume into"), resume progress, and the drill-in to the preview. Keyboard: ↑/↓ walk **stops**: a session, then its snippets; Enter on a session selects it (again: resume, or open when live), Enter on a snippet opens it at the match |
| `SessionList.tsx` | Virtualised, grouped list. Rows with content hits show their match count and up to three snippets (kind label, the hit in the `<mark>` style); row heights are measured (estimate: row + 40 px per snippet) |
| `useSessionSearch.ts` | The hook: query → debounced search → long poll → state. See below |
| `searchModel.ts` | Pure parts, tested in `searchModel.test.ts`: `searchQuery` (≥ 2 non-space characters), `startSearch` (start + poll loop with cancel), `applyPage` / `failed` (state reducer; `unknown_method` → `unsupported`), `mergeEntries` (list + hits by `file`), `snippetLabel`, `searchNote` (progress and stop texts) |
| `SessionPreview.tsx` | Read-only transcript of a session file around a match; the dialog's drill-in (Back button), full height on phones |
| `previewWindow.ts` | Pure window of rows the preview holds (`windowOf`, `prepend`, `append`, `hasOlder`, `hasNewer`); tests `previewWindow.test.ts` |

## Search

One box filters two ways at once. The **instant filter** (title, folder, session id over the newest
200 sessions) is unchanged. With two or more non-space characters, `useSessionSearch` also asks the
host for **content hits**: 300 ms after the query settles it calls `search.start` (`cwd` = the
dialog's folder scope, `waitMs` 1500), then `search.poll { after }` until `done`. One request is in
flight at a time; a new query, host, scope or closing the dialog cancels (`search.cancel`), a run
waits for the previous one's pending request, and answers of a superseded search are dropped by
key. Nothing polls once the search ended or the dialog closed.

The list is `mergeEntries(list, hits, needle)`: sessions whose title/folder/id match, plus sessions
with content hits, merged by `file`; a hit's own `PastSession` fills in sessions older than the
list's newest 200 (the list's copy wins otherwise, its `live`/`agentId` are fresher). Grouping is as
before (Live now / date buckets, or repository).

Texts under the box: `Searching messages… 34 of 77 sessions`; after a stop `Showing the first N
matching sessions` (limit), `Stopped after 20 s`, a size-limit text; on an older host
(`unknown_method`) `This host's TeleFlock is too old to search messages`, and the box falls back to
today's title/folder/id filter.

## Open at match

Clicking a snippet (or Enter on it):

- **Live agent, or a parked agent that ran the file** → `openFind(agentKey(hostId, agentId), { query, target: { rowId, at } })`, close the dialog, navigate to the agent. The session view's Find lands on the match; rows not loaded yet are paged in by Find (`session.find`, which parked agents answer too).
- **Anything else** → the preview of the file.

## Preview

`search.read { file, around: rowId, aroundAt: at }` returns a window of rows (120) around the match,
`{ items, start, rows }`. They render with `TranscriptLog` + `ItemRow` like a subagent transcript,
outside the session store. Older rows page in by scrolling up (`search.read { before: firstId }`,
`hasMore`); newer ones by the "Show later messages" button under the last row (`after: lastId`).
Find scope is `preview:<hostId>:<file>`: once the rows are in, `openFind(scope, { query, target })`
highlights the query and lands on the match; `FindBar` gets a local `FindSource` (loaded rows only:
no `search`/`loadUntil`, so it says it searches the loaded messages while older/newer rows exist).
The scope is dropped when the preview closes. The footer is the dialog's: Resume, Fork / Open live
agent, "Resume into".

## Demo

`src/core/demo/search.ts` (`?demo`, forge only; studio-pc plays a tf-hostd before 0.7.0 and answers
`unknown_method`) serves `search.start/poll/cancel/read` and `session.find`: live agents' real rows,
and deterministic synthetic rows for the seeded old sessions (ids derived from the file name, so a
snippet's `rowId` is what `search.read` returns). Progress grows three files per answer. Tests:
`src/core/demo/search.test.ts`.
