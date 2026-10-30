# features/automations (owner: Automations)

Scheduled omp agents per host: at every cron tick tf-hostd starts an omp agent with the
automation's prompt, in a fresh worktree of a repository or in a folder as is, whether or not an
app is connected. Route `#/automations[/:hostId]` (`{ name: "automations", hostId? }`); sidebar
item, phone More, palette view "Automations", `Ctrl 7`.

## Files

```ts
// AutomationsView.tsx — route screen (desktop + phone)
export function AutomationsView(props: { hostId?: string }): JSX.Element;
// AutomationCard.tsx — one automation: description, next / last run, enable switch, Run now, Edit, Delete
// AutomationEditor.tsx — create / edit (ResponsiveDialog: dialog on desktop, full-height sheet on phones)
// ScheduleField.tsx — preset picker + inputs, live host preview
// RunsList.tsx — recent runs (all, or one automation)
// parts.tsx — SchedulerBanner, RunChip (status chip → agent session), OutdatedHost
// useAutomations.ts — useAutomations(hostId) (list + polling + `outdated`), useSchedulePreview, toDraft
// schedule.ts — presets ⇄ cron (schedule.test.ts)
// format.ts — formatWhen / hostWhen / formatIn, run status + trigger labels
// store.ts — useAutomationsPrefs: last host (zustand persist, localStorage "tf.automations")

// src/core/cron.ts — 5-field cron (cron.test.ts)
export function parseCron(expr: string): CronSpec;            // throws CronError; macros @hourly @daily @midnight @weekly @monthly @yearly @annually
export function cronError(expr: string): string | null;
export function nextRuns(expr: string | CronSpec, from: number, count: number): number[]; // local zone, strictly after `from`
export function describeSpec(spec: CronSpec): string;          // hostd's phrasing: "At 09:00, Monday through Friday"
export function describeCron(expr: string): string | null;
```

## Host methods

`automation.list` (Empty → AutomationList), `automation.save` (AutomationDraft → Automation),
`automation.delete` (AutomationRef), `automation.run` (AutomationRef → AutomationRun),
`automation.preview` (SchedulePreviewParams → SchedulePreview). Types in `@/core/gen`
(`crates/tf-proto/src/methods.rs`).

## Behaviour

- Host: the route's host, else the last one shown, else the first online host. Picking another
  host (chip, more than one host) replaces the route. An `unknown_method` answer means the host's
  tf-hostd predates automations: "Update TeleFlock on <host>" (it updates when an updated app
  reconnects). Offline hosts show a waiting state; the list loads once the host is online.
- The list refreshes after every mutation, every 30 s while the page is visible, when it becomes
  visible, and ~2.5 s after the soonest next run (so the new last run shows up). A host whose
  tf-hostd predates automations isn't polled; it is asked again when it reconnects.
- Scheduler banner from `AutomationList.scheduler`: systemd timer active (runs without an app,
  survives reboots), systemd without persistence (its `note`, with a copyable
  `loginctl enable-linger <user>` when the note names it), or daemon-only (its `note`). Shows the
  host's time zone.
- Card: name, worktree / in-place chip, description (`describeCron`, `Automation` has none) and the
  raw cron, folder, model; next run (relative, absolute on hover; "Paused" while disabled); last
  run chip (started / failed / skipped, error on hover) that opens the agent while it is still on
  the host. The switch saves the draft with `enabled` flipped (`toDraft`: everything it saved, roles and decide for me included; shows the requested state until the
  saved automation arrives). Run now → `automation.run`, toast with "Open agent". Delete asks first
  (agents and worktrees already started stay).
- Editor: name; worktree vs in place (worktree = a fresh `automation/<slug>-<date>` branch forked
  from the remote's default branch per run); repository / folder (typed, or the FolderBrowser in
  repo mode for worktrees, folder mode otherwise, shown in place of the form; Esc goes back); prompt (required unless plan mode, as in hostd);
  schedule; model / thinking (host catalog) / plan; Agent options (each run's agent's own model roles and fallback
  chains, `features/agentRoles`; hostd's role/chain errors show under them; its decide for me, `features/autoAnswer`,
  loaded from `Automation.autoAnswer` and saved as `AutomationDraft.autoAnswer` only when set and the host has
  decide for me: `automationDraft`); catch-up; enabled. Presets: every N minutes
  (N divides 60), every N hours at minute M (N divides 24), daily, weekdays, weekly on chosen days
  (all at HH:MM), custom cron; so runs stay N apart across the hour / midnight.
  An existing cron reads back into the preset that generates exactly it, else custom. The preview
  is the host's `automation.preview` (debounced 300 ms; the host's time zone): description and the
  next 5 runs in this device's time (plus host time when the zones differ), or the error.
  Save → `automation.save`; `invalid_params` messages (hostd's `store::validate`) show inline, under the field they are about.
- Runs: newest first (≤ 100 from the host), filter by automation (a card's "Last run" / phone
  history button selects it); status, trigger (Scheduled / Run now / Catch-up), age, branch or
  folder, error, "Open agent" while the agent is live.

## Demo (`src/core/demo/automations.ts`)

forge seeds three automations ("Nightly dependency audit" `0 3 * * *` worktree mode, catch-up on;
"Weekday standup summary" `30 8 * * 1-5` in place; "Weekly flaky test triage" disabled) with runs:
started ones linking to the demo agents `deps` / `docs` (older ones to closed agents), a failed
`git fetch` and a skipped missed run. Save / delete / preview validate like hostd (`cron.ts`);
Run now and due schedules (checked on every `automation.*` call) really start an agent through
the host's `worktree.create` / `agent.start`. Scheduler: systemd, persistent, the browser's time
zone. studio-pc plays a host whose tf-hostd predates automations (`unknown_method`).
