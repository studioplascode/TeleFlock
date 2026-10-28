# Accounts (`#/accounts[/:hostId[/link[/:provider]]]`, owner: Accounts)

The subscription accounts and API keys omp signs in with on one host (architecture §3.14): who is
linked per provider, plan, quota windows, live sessions, the preferred account, expired logins to
re-link; link a new one through the shared remote sign-in (`src/features/auth`), unlink, prefer.
Entry points: host card (and its ⋯), omp area strip (`OmpAreaNav`), palette, phone More, Settings,
Usage's Re-link, and the link-account nudge.

| File | Role |
|---|---|
| `AccountsView.tsx` | Page: host picker (route host → last shown → first online), header with counts, states (no host, offline, older hostd, error, loading), banners (a link still running on the host → Continue / Cancel — never one the sheet ran: closing the sheet cancels it, and the list is read again once the host has the cancel, `LinkAccountSheet` `onFlow` / `onSettled`; auth broker, partial data), first-account hero (why it matters + popular subscriptions; the only call to action while nothing is linked), deep links (`link` opens the sheet once, then the URL drops it). Phones: Refresh and the primary "+" (Link account) sit in the `MobileHeader`, like MCP servers |
| `AccountGroups.tsx` | Accounts grouped by provider in omp's order (two balanced columns on wide pages), each provider's rows in `byListOrder` (linked order, expired last, preference ignored: preferring never moves the row under the pointer; the star keeps focus while saving; rows glide when one comes or goes): label, org, plan chip (`formatPlan`), Preferred, API key / Expired badges, live sessions, linked age, up to three quota bars (neutral "% left", bar tinted by pace, and a status line from `paceAlert` such as "runs out in ~4d at this pace" with Usage's full sentence as tooltip / screen-reader text), `ExpiredLogin` + Re-link, prefer (star; hidden for a provider's only account), unlink with confirmation (Cancel / Unlink; dialog / bottom sheet, warns about live sessions) |
| `ExpiredLogin.tsx` | The expired-login callout Accounts and Usage share: `expiredLogin()`'s sentence ("This login expired: Claude no longer accepts it. Sign in again to bring it back."), omp's raw reason behind Details, Re-link |
| `LinkAccountSheet.tsx` | Link account: provider picker (popular subscriptions as tiles, everything else searchable; an account's paired logins are one entry and the other one is offered inside the sign-in: "Use a code instead" for `<id>-device`, "Have a Z.AI account? Sign in instead" for Z.AI's API key), then `LinkFlow` = `useRemoteAuth` + `RemoteAuthPanel` (start `accounts.link`, or follow a running flow), success, "Link another account". Dialog on desktop, bottom sheet on phones; closing cancels a running sign-in |
| `LinkAccountNudge.tsx` | "omp has no subscription or API key yet" / "your <provider> login expired": a notice in the board's notice box (dismissible per host, `tf.accounts.nudge`; on phones folded into the notice tray's one line when it's the most urgent, after hosts that aren't online) and a callout on the host card |
| `store.ts` | `accounts.*` per host shared by page and nudges (stale answers dropped; a change's snapshot wins), `accountLinked` / unlink / prefer refresh limits and the models cache; `useAccountsNeeded` + pure `accountsNeed` (no model in `host.models` and no active credential) |
| `providers.ts` | Short names, marks and blurbs for omp's provider ids (unknown ids: derived name, hashed color), `providerDetail` (only what the name doesn't say), paired logins (`alternateLogin` / `baseLogin`), picker sections, search, `byListOrder`, the login that links another account of a stored provider. Tests: `providers.test.ts` |

Shared wording with Usage (`src/features/usage/limitsUi.ts`, tests `limitsUi.test.ts`): `paceAlert` (why a
bar is red / orange: "limit reached", "runs out in ~4d at this pace", with `describePace`'s sentence),
`windowLabel` / `tierLabel` ("5 Hour" / "5 hours" / "5h" → "5 hours", "Opus only"), `formatPlan`
("max_20x" → "Max 20x"), `expiredLogin` (one sentence for omp's disable causes, raw reason as detail).

Shared sign-in (`src/features/auth`, also used by MCP servers): `useRemoteAuth` drives an `auth.*`
flow end to end (the same-port tunnel on `callbackPort`, taking over one an earlier sign-in left
open; opening the page, http(s) only; device code; paste / answer with the host's verdict; cancel on
unmount, reported to `onFinal` once the host has it), `RemoteAuthPanel` renders it. Tests:
`src/features/auth/remoteAuth.test.ts` (controller against the demo engine).

Demo: `src/core/demo/accounts.ts` + `auth.ts` (`?demo`), on the providers' real sign-in pages
(auth.openai.com, claude.ai, accounts.google.com, github.com/login/device, …; key pages for API-key
providers): ChatGPT (1455) and Claude (54545) finish through the same-port tunnel, Gemini CLI's 8085
is "busy" (paste fallback), Copilot shows a device code, other providers ask for a key (≥ 8
characters). Re-linking the expired login stores a fresh credential (linked now) that reports its
windows like any linked Claude / ChatGPT account. Live sessions stay on the account they started
with; the preferred account gets only sessions that start later (or whose account went away).
`host.models` is empty once nothing usable is linked.
