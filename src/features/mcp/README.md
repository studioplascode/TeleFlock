# MCP servers (`#/mcp[/:hostId]`, owner: McpServers)

omp's MCP servers on one host (architecture §3.15): the ones in omp's own config files (user
`~/.omp/agent/mcp.json`, project `<folder>/.omp/mcp.json`), editable here, and the ones omp imports
from other tools (Claude Code, Cursor, …), read-only but switchable for omp. Status and tools come
from omp itself: tf-hostd connects every server the way a session would. Entry points: the omp area
strip (`OmpAreaNav`), host card, palette, More, Settings (UxPolish).

| File | Role |
|---|---|
| `McpView.tsx` | Page: host picker (route host → last shown, `tf.mcp` → first online → first), project selector (All projects / a workspace folder), states (no hosts, offline, older tf-hostd, load error, skeleton, empty, list), check line, banners (`check.error`, `fileErrors`), groups "omp" / "From other tools", live-session footer with "Reload them now" |
| `ServerRow.tsx` | One server (memoized): transport glyph, name, scope / source tag, summary, status chip, inline Sign in, switch, ⋯ menu (Edit/View, Test, Sign in/out, Remove); expands to error, tools, definition, server info, file, checked age, Test outcome |
| `ServerEditor.tsx` | Add / edit sheet (`ResponsiveDialog`): chooser (Popular / Registry / Custom), form, Test, Save, "Saved" step with the live status and "Sign in now", sign-in step, read-only view of imported servers |
| `EditorForm.tsx` | Name, scope, Command / URL, arguments line, working folder, env / header rows (secret toggle, "Unchanged" stored secrets, "Add bearer token"), Advanced (timeout, legacy SSE, OAuth app); template and registry inputs |
| `Chooser.tsx` | Popular grid (`templates.ts`) and Smithery search (`mcp.search`, debounced 450 ms, Enter) |
| `SignIn.tsx` | OAuth sign-in through the shared `useRemoteAuth` / `RemoteAuthPanel` (`@/features/auth`), in a sheet or inside the editor |
| `parts.tsx` | Status chip, transport glyph, banners, outdated-host state, tool list (folds after 8, filter past 12), definition summary, test outcome, letter marks |
| `useMcp.ts` | `mcp.list` per host + folder with the `waitMs` long-poll while a check runs (stops on unmount / host or folder change; newest request wins), changes (`mutate`) with one quiet reload toast, optimistic switch, `mcp.reload` |
| `model.ts` | Pure helpers (`model.test.ts`): `SECRET_MASK`, secret-looking names, name rules, shell-like argument line (lossless round trip), `--config` / registry inputs, template inputs, form ⇄ draft (masks kept), hostd error → field, reload notes, list sharing for memo |
| `templates.ts` | Curated servers, each URL / package checked when added (see its header) |
| `store.ts` | `tf.mcp`: last host, picked folder per host |

## Behaviour

- **Secrets** never leave the host: listed as `••••••••`. A stored secret shows as a password field
  reading "Unchanged" and goes back as the mask unless something is typed; new env / header names
  that look like credentials start as secret. Masked URL query values and arguments stay in their
  text and are kept when sent back unchanged.
- **Checks**: the first read starts one (`check.running`, rows "Checking…"); the page long-polls
  `mcp.list { waitMs: 20000 }` until it ends. "Check again" = `refresh: true` (earlier results stay
  visible while it runs).
- **Changes** answer `McpChanged`: the list is replaced (unless a newer answer arrived first) and
  one toast says what reached running sessions ("Saved · applied to 2 running sessions · …"),
  nothing when none were touched. The switch flips at once and rolls back with a toast on failure.
- **Sign-in** (hostd: omp's own HTTP servers that are on): inline on "Sign in needed", in the menu,
  and in the editor after saving a server that wants one. Unmounting the panel cancels the flow.
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
(no servers), `mcp=broken` (check fails, an unreadable import file), `mcp=error` (`mcp.list` fails).
