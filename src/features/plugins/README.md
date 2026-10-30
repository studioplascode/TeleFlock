# Skills & plugins (`#/plugins[/:hostId]`)

omp's skills and plugins on one host (architecture §3.26; wire types `tf_proto::plugins`, hostd
`crates/tf-hostd/src/ops/plugins/`, helper `host/teleflock-plugins/teleflock-plugins.ts`): every
skill a session there loads (omp's own folders, other tools' skill folders, plugins' skills,
Skillshare registry packages), package plugins (npm, git, linked folders) and marketplace plugins
(Claude Code's format), with versions, updates and switches; the Skillshare registry, marketplace
catalogs and any other source omp installs from. Entry points like the MCP page's: the omp area
strip (`OmpAreaNav`, after MCP servers), More, Settings, the palette ("skills", "plugins",
"marketplace", …), host cards. omp's `/skills`, `/plugins` and `/marketplace` still run in the
session (`src/core/ompCommands.ts` modes can't open a page).

| File | Role |
|---|---|
| `PluginsView.tsx` | Page: host picker (route host → last shown, `tf.plugins` → first online → first), project selector (All projects = omp's user level / a workspace folder), states (no hosts, offline, older tf-hostd, both lists failed, per-section error with omp's update controls for `unsupported`, skeleton, empty with a way to Get more), sections (desktop: sticky rail with counts and update badges; phone: tab strip), status line ("Updates checked 5m ago · omp 18.13.3"), header actions (Reload sessions, Check for updates, Update all (n); phone: icon buttons), the running-sessions footer with "Reload them now", revealing a just-installed row (section, expanded, scrolled to, lit up) |
| `SkillRow.tsx` | One skill (memoized): name, description, source chip, Project / Hidden tags; registry installs also version, update badge, Yanked / Deprecated, and when missing from omp's store ("sessions skip it until it is restored") a Restore button; switch (omp's `disabledExtensions`), ⋯ Update (to x.y.z) / Restore / Remove; expands to path, provider, level, plugin, range, the registry's latest outside the range, update error |
| `PluginRow.tsx` | One plugin (memoized): package (npm / git / linked folder) or marketplace install: name, version, description, provides chips, update badge, Project / Linked tags, the "this project's install wins" note when shadowed; switch, ⋯ Upgrade (not for linked folders) / Remove (Unlink); expands to optional features, folder, marketplace, updated age, how its code reaches sessions, homepage |
| `GetMore.tsx` | "Get more" tabs: Marketplaces (`Catalog`), Skill registry (`SkillSearch`), npm, git or a folder (`SourceInstall`) |
| `Catalog.tsx` | Marketplace catalogs (`plugins.discover`: the catalogs as last fetched, no network) with a filter and marketplace picker, cards with Install (for every project / this project) and "✓ Installed"; the marketplaces with Refresh and Remove; "Add a marketplace" (`owner/repo`, git URL, catalog URL, folder on the host; well-known ones in one tap), errors under the input |
| `SkillSearch.tsx` | `skills.search` as you type (debounced 450 ms, Enter at once), sort (relevance, downloads, recent), "Show more" pages, hit cards with Install (every project / this project) and "✓ Installed"; no hits: "Nothing on skills.omp.sh matches …" with Browse marketplaces and a link to the registry (it has little published yet) |
| `SourceInstall.tsx` | `plugins.install` of an npm package, a git source, a folder on the host or `name@marketplace`: names the kind as you type (`model.specKind`), "Every project" / "<project> only" for marketplace specs, errors under the input, Reinstall (`force`) when it is installed already |
| `ScriptsConsent.tsx` | The dialog body before a skill version that ships scripts (`scripts_need_consent`): the files omp listed, that they run with your user's rights on the host |
| `parts.tsx` | Group header, glyph tile, tags, update badge, version, provides chips, busy label, `Facts` / `Fact` rows |
| `usePlugins.ts` | `skills.list` and `plugins.list` per host + folder, ordered by `AnswerOrder` (`@/features/mcp/answers`: a slow answer never replaces a newer one); the registry's update check once after the first list (not again for 10 min); every change: busy rows, the scripts consent and retry with `allowScripts`, one quiet toast (MCP's `toastReload` wording: what changed and what reached running sessions, plus omp's lines and `note`), optimistic switches with rollback; Check for updates (`skills.list {updates}` + `plugins.marketplaceUpdate`), Update all, `plugins.reload` |
| `model.ts` | Pure helpers (`model.test.ts`): skill groups (Registry, omp's own, From plugins, Other tools) with registry installs joined to their skill, source chips, registry needs (restore / update) and the latest outside a range, plugin keys and refs, pending updates, merged reloads, change lines, the scripts listing parser, install-spec and marketplace-source kinds, catalog filter and installed marks, running sessions per folder, list sharing for memoized rows |
| `store.ts` | `tf.plugins`: last host, picked folder per host (a folder gone from the host is forgotten with a toast), last section |

## Behaviour

- **Lists.** Reading the skills starts a throwaway omp on the host (1.5–3 s); the page shows a
  skeleton per section and keeps the other usable. The first list of a host and folder is followed
  by one registry check (`updates: true`, up to ~10 s more); hostd keeps that answer and merges it
  into later lists, so the badges stay after a switch or an install.
- **Updates.** "Check for updates" asks the registry and refreshes the marketplace catalogs (network,
  a toast says what is new). Registry skills update within their range; a newer `latest` outside it
  is shown in the expanded row (reinstalling the bare id moves the range). "Update all" updates every
  registry skill with an update, one at a time (each asking about its scripts when it ships some),
  then every marketplace plugin with one (`plugins.upgrade` without an id).
- **Changes** run on the host one at a time; the row or button shows "Installing…" / "Updating…"
  meanwhile, the rest of the page stays usable. Installs, updates and marketplace fetches may take
  minutes: the app waits 300 s for them (tf-client `PLUGINS_CHANGE_TIMEOUT`, devserver `ws.ts`
  `PLUGIN_TIMEOUT`). Each answers the new list and what `/reload-plugins` did to the running
  sessions it concerns; package plugins' code loads only when a session starts, which the toast says.
  Skill switches reach running sessions through omp's own config watcher (no reload, `note`).
- **Scopes.** All projects = omp's user level (`~/.omp/agent/skills.json`, `~/.omp/plugins`); a
  project folder shows what sessions started there load and installs into its `.omp/` when asked
  ("This project"). Package plugins have no project switch in omp's CLI: their switch is host-wide.
- **Errors.** `invalid_params` from an input (spec, source) shows under it; `scripts_need_consent`
  opens the consent dialog; `unsupported` (omp too old) offers "Update omp"; `busy` and retryable
  errors offer "Try again"; `unknown_method` means the host's tf-hostd predates the page (the
  outdated-host state, `@/features/mcp/parts`).

## Demo (`src/core/demo/plugins.ts`, tests `src/core/demo/plugins.test.ts`)

forge: skills from omp (user, a `~/code/teleflock` project skill, auto-learned), Claude Code (`xlsx`
switched off), Codex, `.agents`, a marketplace plugin and the registry (`@acme/changelog` with an
update in range and a newer major, `@tools/screenshot` missing from omp's store and shipping scripts,
a private project package the registry can't be asked about); packages (one linked, one switched
off, one with optional features), marketplace plugins (one with an update, one more after refreshing
the catalogs, one switched off, one installed for `~/code/teleflock` too, shadowing the user install
there), two marketplaces, a registry search fixture, known marketplace sources to add. Reload counts
come from the live demo omp agents. studio-pc answers `unknown_method`. Knobs: `?demo&plugins=empty`
(nothing installed, no marketplaces, an empty registry: a fresh host today), `plugins=error` (both
lists fail).
