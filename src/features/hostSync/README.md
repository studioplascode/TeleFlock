# Make this host like that one (`hostSync.*`, owner: HostSync)

Copies omp's setup from a **source** host to a **target** host (architecture §3.24, tf-hostd
`ops/hostsync`, wire types `tf_proto::hostsync`): omp's global settings, model roles (`modelRoles` +
`retry.fallbackChains`) and user-level MCP servers, after a preview of every difference and a choice
per item; sign-ins and other secrets (credential settings, MCP servers' secret values) only when
ticked, each with its own consent.

Entry points: the omp area strip's trailing **Copy from host…** (`OmpAreaNav`, with the area's host
as target), the host card's ⋯ **Make like another host…** (online hosts), and the palette's **Make a
host like another…** (contributed by the dialog through `usePaletteCommands`). All of them only
when there are two hosts or more. They open `useUi().openDialog({ kind: "hostSync", hostId?,
sourceHostId? })`; without `hostId` the dialog asks for the host to change.

## Flow

1. **Pick**: the source (a Select of the other hosts; offline ones disabled, marked "offline"),
   and the target when the dialog was opened without one. A picked host that isn't online (or, before
   a source is picked, the other hosts when none is online) shows its one connection action
   (Connect / Retry / Sign in / Verify).
2. **Compare** as soon as both are picked and online: `hostSync.export` on the source ("Reading
   studio-pc…"), then `hostSync.plan {source}` on the target ("Comparing with forge…"), skeletons
   meanwhile. Changing a pick while it runs starts over (the newest request wins).
3. **Review**: "N differences · k secret · M already the same", the plan's notes, then Settings /
   Model roles / MCP servers / Sign-ins (empty sections left out). Each section has a checkbox for all
   its choosable items; each row: checkbox, label, place (left out when it only repeats the label: a
   setting outside omp's settings panel goes by its key), change chip (New · Different · Only on
   <target> · Can't compare · Not possible here), "Here → <source>" values (monospace, long ones
   behind Show all), notes in warning colour. Secret rows show a lock and "Secret · never shown ·
   sealed on <source> for <target>" instead of values. Equal items fold into "N already the same"
   per section. tf-hostd's `suggested` items start ticked (never a removal or a secret). A ticked MCP
   server whose `needs` item (its secret values) isn't ticked says its masked values stay empty, with
   **Include its secrets**. No differences: "<target> already matches <source>".
4. **Confirm secrets** (only with secrets ticked): the list of secret items; <source> encrypts them
   with a one-time key <target> made for this copy; TeleFlock only relays the sealed box; OAuth
   sign-ins: providers that rotate refresh tokens may sign <source> out of that account once
   <target> refreshes it. Back / Copy secrets and apply.
5. **Apply** (`applyCopy`): with secrets, `hostSync.keyBegin` on the target → `hostSync.seal
   {transferId, publicKey, items: <exactly the ticked secret ids>}` on the source → `hostSync.apply
   {source, items, sealed}` on the target; without, `hostSync.apply {source, items}` alone. A step per
   line ("forge makes a one-time key…", "studio-pc seals the secrets…", "Applying on forge…"). The
   dialog can be closed meanwhile: a toast reports the outcome either way.
6. **Result**: ✓ / ✗ per item with its error or note, what reloading MCP servers did to the target's
   running sessions (reloaded · queued · restart needed, and errors), and the target's fresh plan
   (`SyncApplied.plan`): "Still different: …" with **Review again**, or "<target> now matches
   <source>". Failed items keep their error on their rows when reviewing again.

Errors name the step and host (`SyncStepError` → `describeFailure`): `unknown_method` (that host's
tf-hostd predates this: reconnect it to update), `unsupported` (message and hint, e.g. omp too old),
`expired` / `sealed_invalid` / `invalid_params` / `timeout` (Start again: export and plan again,
keeping the choice), `omp_error`, `not_connected`; others show the host's message and hint. Apply is
disabled while the target is offline, or the source is offline and secrets are ticked (the plan
already has the source's export, so everything else applies without it).

## Security model, as the dialog says it

- Nothing secret leaves a host unless ticked: the export withholds credential values, masks MCP
  secrets and lists sign-ins by identity only. Secret rows never show a value.
- Ticked secrets are sealed on the source for a one-time X25519 key the target made for this copy
  (`x25519-hkdf-sha256-aes256gcm/1`); only the target opens them, once, before the key expires.
  The app relays `SyncSealed` untouched (`applyCopy` passes the object through) and the sealed items
  are exactly the ticked secret ids, which tf-hostd checks (`sealed_invalid`).
- Copying an OAuth sign-in can sign the source out where the provider rotates refresh tokens.

## Files

| File | Role |
|---|---|
| `HostSyncDialog.tsx` | `HostSyncDialog` (mounted once in `src/app/App.tsx` next to `HostEditor`, contributes the palette action) and the flow: pickers, offline notes, loading, plan, confirm, applying, result, failure, footer; `ResponsiveDialog` (desktop 880 px, fixed height ≤ 86 dvh, body scrolls; phones a full-height sheet) |
| `PlanView.tsx` | `PlanSections`: sections with their checkboxes, rows (values, notes, secret line, needs hint, last failure), the "already the same" fold; `SECTION_ICON`, `CHANGE_TONE`, `placeText` |
| `entry.tsx` | `openHostSync(hostId?, sourceHostId?)`, `CopyFromHostButton` (omp area strip), `HostSyncMenuItem` (host card ⋯) |
| `model.ts` | Pure (`model.test.ts`): grouping and counts, default / carried-over choice, selectable, chosen and secret ids, missing `needs`, value formatting per section, change labels, result merging, toast and MCP reload wording, `compareHosts` / `applyCopy` over an injected `call(hostId, method, params)`, `SyncStepError`, `describeFailure` |

Rendering budget (§6.3): no looping animation; a Spinner only while a call runs, skeletons while
comparing, EmptyState's floating icon held still (Calm keeps loops inside dialogs running), no blur.

## Demo (`src/core/demo/hostSync.ts`)

forge and studio-pc differ in every way a plan can show, either way round: settings equal / new /
different / only on the target, a long array value, a credential both have (can't compare) and one
only studio-pc has, a key the target's omp build lacks (`speech.dictation` on forge,
`isolation.backend` on studio-pc: not possible here); roles equal / different / new / removed, one
whose model isn't in the target's catalog (a note); MCP servers equal with secrets, different, a
masked API key the target can't fill (`needs`), OAuth, a field TeleFlock doesn't copy, an absolute
path, one only on forge; sign-ins one both have, OAuth (with omp's refresh-token note) and API keys,
an MCP server's OAuth. `keyBegin` / `seal` answer obviously fake key material; `apply` checks the key
(`expired`) and the sealed items (`sealed_invalid`), fails `unsupported` items and ids no longer in
the plan with their reason, answers the plan again (copied values `same`, copied secrets `unknown`)
and an `mcpReload` from the host's live omp sessions. Answers take ~1 s.

studio-pc starts offline in `?demo`: bring it online first (Hosts → studio-pc → Connect → verify its
host key, or Sign in when it asks; the dialog's offline note offers the same action). It stays online
for 90 s before its demo cycle drops it again.

## Tests

`bun test src/features/hostSync src/core/demo/hostSync.test.ts`: the model (grouping, defaults,
selectable, secret ids, needs hints, formatting, the call order and params of a copy with a fake
`call`, error propagation, a full copy between the demo hosts) and the demo (every answer's shape,
every section and change kind, apply turning items `same`, `sealed_invalid` / `expired`).

Against real hosts: architecture §3.24 **Lab** (two isolated labs, the devserver with one of them
local and the other over SSH; plan, confirm and result checked at 1440×900 and 412×892).
