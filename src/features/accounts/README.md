# Accounts (`#/accounts[/:hostId[/link[/:provider]]]`, owner: Accounts)

The subscription accounts and API keys omp signs in with on one host (architecture §3.14): who is
linked per provider, plan, quota windows, live sessions, the preferred account, expired logins to
re-link; link a new one through the shared remote sign-in (`src/features/auth`), unlink, prefer.
Entry points: host card (and its ⋯), omp area strip (`OmpAreaNav`), palette, phone More, Settings,
Usage's Re-link, and the link-account nudge.

| File | Role |
|---|---|
| `AccountsView.tsx` | Page: host picker (route host → last shown → first online), header with counts, states (no host, offline, older hostd, error, loading), banners (a link still running on the host → Continue / Cancel, auth broker, partial data), first-account hero (why it matters + popular subscriptions), deep links (`link` opens the sheet once, then the URL drops it) |
| `AccountGroups.tsx` | Accounts grouped by provider in omp's order (two balanced columns on wide pages): label, org, plan, Preferred, API key / Expired badges, live sessions, linked age, up to three quota bars, expired reason + Re-link, prefer (star; hidden for a provider's only account), unlink with confirmation (dialog / bottom sheet, warns about live sessions) |
| `LinkAccountSheet.tsx` | Link account: provider picker (popular subscriptions as tiles, everything else searchable, `<id>-device` logins offered as "Use a code instead"), then `LinkFlow` = `useRemoteAuth` + `RemoteAuthPanel` (start `accounts.link`, or follow a running flow), success, "Link another account". Dialog on desktop, bottom sheet on phones; closing cancels a running sign-in |
| `LinkAccountNudge.tsx` | "omp has no subscription or API key yet" / "your <provider> login expired": a row in the board's notice box (dismissible per host, `tf.accounts.nudge`) and a callout on the host card |
| `store.ts` | `accounts.*` per host shared by page and nudges (stale answers dropped; a change's snapshot wins), `accountLinked` / unlink / prefer refresh limits and the models cache; `useAccountsNeeded` + pure `accountsNeed` (no model in `host.models` and no active credential) |
| `providers.ts` | Short names, marks and blurbs for omp's provider ids (unknown ids: derived name, hashed color), picker sections, search, the login that links another account of a stored provider |
| `ProviderMark.tsx` | The colored provider mark (letters or a drawn glyph; not the providers' logos) |

Shared sign-in (`src/features/auth`, also used by MCP servers): `useRemoteAuth` drives an `auth.*`
flow end to end (same-port tunnel on `callbackPort`, opening the page, device code, paste / answer
with the host's verdict, cancel on unmount), `RemoteAuthPanel` renders it. Tests:
`src/features/auth/remoteAuth.test.ts` (controller against the demo engine).

Demo: `src/core/demo/accounts.ts` + `auth.ts` (`?demo`): ChatGPT (1455) and Claude (54545) finish
through the same-port tunnel, Gemini CLI's 8085 is "busy" (paste fallback), Copilot shows a device
code, other providers ask for a key (≥ 8 characters); `host.models` is empty once nothing usable is
linked.
