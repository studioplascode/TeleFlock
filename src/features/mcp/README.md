# MCP servers (`#/mcp[/:hostId]`, owner: McpServers)

omp's MCP servers on one host (architecture §3.15): the ones in omp's own config files (user
`~/.omp/agent/mcp.json`, project `<folder>/.omp/mcp.json`), editable here, and the ones omp imports
from other tools (Claude Code, Cursor, …), read-only but switchable for omp. Status and tools come
from omp itself: tf-hostd connects every server the way a session would. Entry points: the omp area
strip (`OmpAreaNav`), host card, palette, More, Settings (UxPolish).

| File | Role |
|---|---|
| `McpView.tsx` | Page: host picker (route host → last shown, `tf.mcp` → first online → first), project selector (All projects / a workspace folder), states (no hosts, offline, older tf-hostd, load error, skeleton, empty, list), check line, banners (`check.error`, `fileErrors`), groups "omp" / "From other tools", live-session footer with "Reload them now", row tests, revealing a row (scroll, expand, highlight) |
| `ServerRow.tsx` | One server (memoized): transport glyph, name, scope / source tag, summary, status chip, inline Sign in (only when it asks for one), switch, ⋯ menu (Edit/View, Test, Sign in/out, Remove); expands to error, tools, definition, server info, file, checked age, Test outcome |
| `ServerEditor.tsx` | Add / edit sheet (`ResponsiveDialog`): chooser (Popular / Registry / Custom), form, Test, Save (closes on the saved server's row), read-only view of imported servers |
| `EditorForm.tsx` | Name, scope, Command / URL, arguments line, working folder, env / header rows (secret toggle, "Unchanged" stored secrets, "Add bearer token"), Advanced (timeout, legacy SSE, OAuth app); template and registry inputs; the "same server" note under the URL / arguments |
| `Chooser.tsx` | Popular grid (`templates.ts`) and Smithery search (`mcp.search`, debounced 450 ms, Enter); cards of servers the host already has carry "✓ Added · Open" |
| `SignIn.tsx` | OAuth sign-in through the shared `useRemoteAuth` / `RemoteAuthPanel` (`@/features/auth`), in a sheet |
| `parts.tsx` | Status chip, transport glyph, banners, "same server" note, outdated-host state, tool list (folds after 8, filter past 12), definition summary, test outcome (full, or its verdict line under a row), letter marks |
| `useMcp.ts` | `mcp.list` per host + folder with the `waitMs` long-poll while a check runs (stops on unmount / host or folder change; newest request wins), changes (`mutate(run, title, change)`) with one quiet toast, optimistic switch, `mcp.reload` |
| `answers.ts` | `AnswerOrder`: the newest request's answer is shown; a long-poll step asks again after a dropped answer or while a check runs; a change's answer that lost to a later read is followed by a fresh read (never just dropped) |
| `store.ts` | Device-local prefs: last host, project folder per host (a folder gone from the host — `not_found` — is forgotten: back to All projects, with a toast; the error state keeps the project picker and "Show all projects") |
| `model.ts` | Pure helpers (`model.test.ts`): `SECRET_MASK`, secret-looking names, name rules, shell-like argument line (lossless round trip), `--config` / registry inputs, template inputs, form ⇄ draft (masks kept), hostd error → field, reload notes per change (add / change / remove), the last good check, a row's state after its test (`rowState`), the same server twice (`endpointKey`, `findSame`), list sharing for memo |
| `templates.ts` | Curated servers, each URL / package checked when added (see its header) |
| `store.ts` | `tf.mcp`: last host, picked folder per host |

## Behaviour

- **Row actions** (`rowActions`): a hidden imported server has no working switch and no Test (omp switches other tools' servers through user-level lists keyed by name: that would switch the server hiding it too); Sign in / out only for omp's own `mcp.json` servers over HTTP that are on (omp's sign-in never reads `.mcp.json`). Test and sign-in always address the row's own definition (`scope`).
- **Secrets** never leave the host: listed as `••••••••`. A stored secret shows as a password field
  reading "Unchanged" and goes back as the mask unless something is typed; new env / header names
  that look like credentials start as secret. Masked URL query values and arguments stay in their
  text and are kept when sent back unchanged.
- **Checks**: the first read starts one (`check.running`, rows "Checking…"); the page long-polls
  `mcp.list { waitMs: 20000 }` until it ends. "Check again" = `refresh: true` (earlier results stay
  visible while it runs). After a failed check the check line reads "Check failed 1m ago · last good
  one 2h ago" (the newest `checkedAt`, when there is one) and the failure banner holds the only
  "Check again" (the header leaves its own out; an empty list has none).
- **Tests** of a saved server (its row's Test) stand in for its status until a check ends later:
  chip, error, tools and "Checked now" come from the test while the row's `checkedAt` hasn't moved
  since it started (no clock comparison: host and device clocks differ). The error shows once (in
  the row); under the buttons only the verdict ("Couldn't connect (0.2 s)") is added.
- **The same server twice**: a URL (scheme / host case, default port, trailing slash and credential
  query values aside; http and sse alike), a package however its runner starts it (`npx -y pkg@1` ≈
  `bunx pkg`, `uvx pkg==1` ≈ `pipx run pkg`; a Smithery server by its id) or else the whole command
  line and folder. Popular / registry cards of servers the host has (omp's, a project's or another
  tool's) carry "✓ Added · Open"; the form warns under the URL / arguments, naming the server, and
  saving stays possible as "Add a second copy". Open closes the sheet on that server's row.
- **Changes** answer `McpChanged`: the list is replaced (unless a newer answer arrived first) and
  one toast names the change and says what reached running sessions ("Added “x”" · "Applied to 2
  running sessions · …"; a removal: "Dropped by 2 running sessions · 1 session keeps it until
  restarted"), nothing when no session ran. The footer says how many running sessions get changes
  without a restart; "Reload them now" is for config files edited by hand. The switch flips at once
  and rolls back with a toast on failure.
- **Saving** closes the sheet on the saved server's row (scrolled to, expanded, lit up, focused):
  it shows "Checking…", then its status, with Sign in when it asks for one.
- **Sign-in** (hostd: omp's own HTTP servers that are on): inline only on "Sign in needed", always in
  the menu. Unmounting the panel cancels the flow.
- **Errors**: hostd prefixes `invalid_params` with the field (`name:`, `url:`, `headers:`,
  `oauth.clientSecret:` …); the editor shows them under that field.
- An `unknown_method` answer means the host's tf-hostd predates MCP servers.

## Demo (`src/core/demo/mcp.ts`)

forge: context7 (connected), github (OAuth app, sign-in needed), filesystem (14 tools), postgres
(`spawn uvx ENOENT`), sentry (signed in), sequential-thinking (still starting on the first check),
a project server for `~/code/teleflock`, and imports from Claude Code (linear, off) and Cursor
(playwright, skipped; context7, hidden by omp's). Validation, masking, rename, user-level lists,
checks on the demo clock, reload counts from the live omp agents, a Smithery fixture, scripted
sign-in through `DemoHost.auth`. studio-pc answers `unknown_method`. Knobs: `?demo&mcp=empty`
(no servers), `mcp=broken` (every check fails and keeps its error until one succeeds, the statuses
of a good check two hours earlier stay; an unreadable import file), `mcp=error` (`mcp.list` fails).
