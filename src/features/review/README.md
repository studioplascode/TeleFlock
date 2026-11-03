# features/review (owner: FrontOps)

Review and ship a worktree: route `#/review/:hostId/:workspaceId` (`ReviewView`), the diff viewer
(`diff/`), the file tree and the ship panel (commit → push → PR → merge → done, `ShipPanel.tsx`). A chat's
workspace (an agent in it is a chat, or its folder is under `HostInfo.chats`) gets a short "nothing to review"
note instead, without any git or gh call.

## Public API (ship panel parts)

```ts
// src/features/review/ShipPanel.tsx
export function shipState(status: GitStatusResult, pr: PrInfo | undefined): ShipState; // stage, dirty, unpushed, merged, blocked?, next
export function usePrStatus(hostId, cwd): HostQuery<PrStatusResult>;                    // gh.prStatus, polled 4 s while checks run / mergeability is computed, else 15 s
export function ShipPanel(props: ShipPanelProps): JSX.Element; export function ShipStepper(…); export function ShipStrip(…);

// src/features/review/fix.ts — Make it green / rebase and resolve (pure parts tested in fix.test.ts)
export function fixOffer(pr): { green: boolean; rebase?: "conflicts" | "behind" }; // failing checks; mergeable false / mergeState DIRTY, or BEHIND
export function prNext(pr): string;                    // "PR #7 closed" | "#7 checks running" | "Make #7 green" | "Rebase #7" | "Merge #7" (stepper, board cards)
export function rebaseOnto(pr, defaultBranch): string; // origin/<pr.baseRef ?? default ?? main>
export function rebasePrompt(onto, why): string;       // fetch, rebase, resolve keeping both sides' intent, test, push --force-with-lease, ask on product decisions
export function worktreeAgent(agents, ws): Agent | undefined; // live omp agent of the workspace (idle first), else the latest parked one in its checkout
export function fixBlocker(agent, kind): string | undefined;  // why the button is disabled (busy, needs you, not connected, no bridge for /green)
export function startFix(hostId, cwd, kind, agent: AgentView, rebase?): Promise<void>;
export function fixPhase(run, agent, pr, now): FixPhase;      // resuming | sending | failed | starting | working | needsYou | checksRunning | recheck | done | stopped
export const useFixRuns; export function fixKey(hostId, cwd); export function dismissFix(key); export function noteWorking(key);

// src/features/review/FixPanel.tsx
export function FixActions(props: { hostId; cwd; workspace; pr; defaultBranch? }): JSX.Element | null; // inside the PR card
```

## Markdown files: Diff | Rendered

`.md`, `.markdown` and `.mdx` files carry a `Diff | Rendered` switch in their header (icons only on phones; one
choice for every Markdown file, remembered on this device: `tf.review.markdown`, `diff/mdMode.ts`). Rendered replaces
the hunks with the document in the transcript's own renderer (`features/session/markdown`, so Mermaid, math and code
highlighting are the same): the working-tree text of an added or modified file (`fs.read` of `<repo root>/<path>`,
`diff/useRenderedDocs.ts`, read only while Rendered is on, at most 40 files, files over 400 KB stay a diff with a
note), the old text of a deleted file (the patch carries it whole; "Showing the deleted version"). For a modified file
the document is cut into chunks at blank lines outside code fences (`diff/markdown.ts`): chunks that contain a line the
diff adds or changes get the diff's green edge and tint, a note counts them; removed text shows only in Diff. Chunks are
virtualized and measured rows like the rest of the viewer (only chunks in view render), so a long document stays fast.
Tests: `bun test src/features/review/diff/markdown.test.ts`.

## Binary files: images, video, audio, PDF

A binary file's row shows the file instead of hunks (`diff/MediaPreview.tsx`): images (png, jpg, gif, webp, avif, bmp,
ico, an svg git calls binary) on a transparency checkerboard, fit to the width (small ones enlarged by a whole factor,
crisp), pixel size and file size under them, a click opens the lightbox (zoom, pan); video (mp4, m4v, webm, mov, ogv)
and audio (mp3, wav, ogg, oga, opus, m4a, flac, aac) with native controls, never autoplaying; PDFs drawn by pdf.js
(`diff/PdfView.tsx`, legacy build, loaded with the first PDF, its worker bundled; CMaps, standard fonts, ICC profiles and
image decoders under `pdfjs/`, `vite.config.ts` `pdfjsAssets`) in a scrolling frame whose pages are drawn near the view
and dropped far from it, a page opening full size in the lightbox. A format a webview can't play says so with the size.
Anything else binary is one "Binary file · 1.2 MB" line; a file named nothing media is told apart by its first bytes
(`sniffMedia`). Which files (`isBinaryLike`): those git calls binary, and media files whatever git calls them (a PDF of
uncompressed streams diffs as text, a Git LFS file as its pointer), except an SVG with lines, which stays a text diff.

- **Versions** (`mediaSides`): a modified file shows Before (the diff's base) and After (the working tree) side by side,
  stacked on phones; a deleted one its base version; an added, untracked or renamed one the working tree's.
- **Bytes** (`diff/mediaLoad.ts`, one loader per Review): the working tree through `fs.read` of `<repo root>/<path>`,
  the base through `git.show {cwd, rev, path}` at the base's sha; read only while the row is expanded and within a screen
  above to two below the view, three files at a time, in ranges (`readMedia`: a first read of 1 MiB, then 2 MiB each).
  Kept as object URLs until Review closes (`close()` revokes them; past 192 MiB the least recently shown go first). A
  working-tree file is read again when its blob id in the patch changes, and when an untracked file's diff reloads; bytes
  that did not change keep their URL, so a playing video goes on.
- **Sizes** (`sizeVerdict`): up to 32 MiB at once; larger: "Too large to preview (48 MB)" with **Load anyway** up to
  256 MiB.
- **Older hosts** (tf-hostd before 0.9.1): `git.show` answers `unknown_method`, so only the working tree's version shows,
  with a note to update TeleFlock on the host; `fs.read` there reads from the start only, so files over 8 MB are not shown.
- Demo: the kanban agent's worktree has an untracked PNG with transparency, a modified PNG, a deleted one, a WebM video, a
  WAV sound, a two-page PDF and a SQLite file (`src/core/demo/media.ts`).

Tests: `bun test src/features/review/diff/media.test.ts src/features/review/diff/mediaLoad.test.ts`.

## Make it green, rebase and resolve

- Failing checks on the open pull request: **Make it green** next to "merge anyway". The worktree's
  agent runs omp's bundled `/green` through `agent.slash` (omp's composer runs the command: it
  watches the CI runs of HEAD, reads the failing logs, fixes, pushes and repeats until they pass).
  `agent.prompt` is not used: it would send the text `/green` to the model. Needs TeleFlock's bridge
  in that omp (it lists `green` among the session's commands).
- GitHub reports conflicts (`mergeable: false`, `mergeState: DIRTY`) or the branch behind its base
  (`BEHIND`, where the repo requires up-to-date branches; hosts ≥ 0.7.0 send `mergeState`/`baseRef`):
  **Rebase onto origin/<base> and resolve** sends `rebasePrompt` with `agent.prompt`.
- The agent: a live omp agent of the workspace, an idle one first; else the most recently parked omp
  agent whose worktree (or cwd) is this checkout. A parked agent is resumed first (`resumeAgent`),
  then asked once it is connected, idle and (for `/green`) has its bridge (`whenAgent`, 2 min).
- Progress (one strip in the PR card, per worktree, in memory on this device): Resuming… → Sending… →
  starting → working (with its live line, Watch) / asking you (Answer) → checks running after its push
  / GitHub re-checking after a rebase → All checks pass / up to date (✓, dismiss), or stopped with
  checks still failing / still not mergeable, or the error. A sent request whose turn never shows up
  counts as stopped after 30 s. Buttons come back once a run is done, stopped or failed.
- Demo host: the hero branch's first CI run fails after its PR is created (Make it green runs a
  scripted `/green` turn, then CI passes), and reconnect's draft PR #142 conflicts with main (the
  rebase prompt runs a scripted rebase turn, then it is mergeable).
