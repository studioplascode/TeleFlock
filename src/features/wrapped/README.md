# features/wrapped (Flock Wrapped)

The week of every host in view on one card, shared as an image: hours of unattended work, agents
run, lines changed, pull requests merged, the longest overnight streak, the fastest model and the
busiest subagent. A fun digest, not the Usage page. Route `#/wrapped` (`{ name: "wrapped" }`);
sidebar item after Usage, phone More, palette view "Flock Wrapped". Host side:
`host.wrapped` (architecture §3.19, `crates/tf-hostd/src/ops/wrapped/`).

## Files

```ts
// WrappedView.tsx — route screen (desktop: poster beside actions, notes and definitions; phone: stacked)
export function WrappedView(): JSX.Element;
// useWrapped.ts — host.wrapped from every online host in view for a week; asks again every 3 s while a host
// is still counting commits (`pending`) and every 20 s while omp's index syncs, only with the window active
export function useWrapped(hostIds: readonly string[], week: Week, nonce: number): { answers: HostAnswer[]; loading: boolean };
// model.ts — pure: weeks, merging hosts, awards, words, the card (model.test.ts)
export function weekOf(now: number, back?: number): Week;            // local Monday 00:00 → next Monday
export function mergeReports(reports: readonly WrappedReport[], hosts?: readonly string[]): WrappedFacts;
export function longestOvernight(busy: readonly Span[]): Span | null;
export function fastestModel(models: readonly WrappedModel[]): ModelSpeed | null;
export function topSubagent(crew: readonly WrappedSubagent[]): WrappedSubagent | null;
export function buildCard(f: WrappedFacts, week: Week, hosts: number): WrappedCard;
// paint.ts — the 1080×1350 poster on a canvas, and its PNG
export function paintPoster(ctx: CanvasRenderingContext2D, card: WrappedCard): void;
export function posterPng(card: WrappedCard): Promise<Blob>;
// share.ts — savePng (download), copyPng (ClipboardItem), sharePng (share sheet) and their feature checks

// src/core/demo/wrapped.ts — the demo hosts' week (wrapped.test.ts there)
```

## What each figure means

- **Unattended work** (the big number): the time agents worked on their own, added up over agents:
  each omp session's requests and the tool runs between them, its subagents and advisor folded in; a
  pause over 10 minutes or a prompt of yours ends a stretch (omp's stats index, through
  `host.usage`'s report: `work.agentMs`).
- **Agents run**: omp sessions with requests in the week; subagent runs and automation runs beside.
- **Lines changed**: added + removed lines of your non-merge commits in the week (commit time), on any
  branch of the repositories the agents worked in. Lock files and GitHub's merge and squash commits
  are left out; a commit two hosts both have counts once.
- **PRs merged**: your pull requests merged in the week in those repositories (`gh` on each host). A
  dash means no host could ask GitHub (the note says why), not zero.
- **Longest overnight streak**: the longest stretch with an agent working (pauses up to 10 minutes,
  across hosts) that overlaps a night, 00:00–06:00 local.
- **Fastest model**: the highest average output speed (omp's tokens per second per request) among
  models with at least 5 timed requests.
- **Busiest subagent**: the subagent (by task name) with the most model requests, its steps; ties go
  to the one that wrote more.

The week is the reader's: Monday 00:00 to the next Monday in the app's time zone, last week by
default, the arrows go back up to a year. Nights and the labels on the card are local too; hosts
send only additive facts.

## The poster

`paint.ts` draws everything (the omp-gradient hero, six tiles, the TeleFlock mark, Sora and Manrope)
on a canvas; the page shows that canvas and every export comes from the same painter, so the image is
exactly what is on screen. Text that does not fit shrinks, then ends in an ellipsis. Fonts are loaded
before painting (`document.fonts.load`), and the poster is painted again only when the card changes.

Exports: **Copy image** (`navigator.clipboard.write` with a `ClipboardItem`, started inside the click
so WebKit accepts it), **Save PNG** (a download named `flock-wrapped-<monday>.png`: browsers, WebView2
and WebKitGTK save it to Downloads; not offered in the Android app, whose WebView has no downloads),
**Share…**: in the Android app the system share sheet through the TeleFlock plugin
(`plugin:teleflock-android|share_image`, which can also save to the device), elsewhere where the
browser's share sheet takes files (`navigator.canShare({ files })`).

## Rendering budget

One canvas, painted on data changes only; no animation, no timers while idle. Follow-up asks run
only while a host is still gathering and the window is active (`isWindowActive`).

## Tests

`bun test src/features/wrapped src/core/demo/wrapped.test.ts`: weeks, ranges and file names; union of
stretches; overnight detection; the awards and their thresholds; merging two hosts (commit and pull
request de-duplication, models and subagents by key, notes); the full and the empty card; the demo
hosts' week.
