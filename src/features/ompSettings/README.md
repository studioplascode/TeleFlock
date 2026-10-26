# omp settings (`#/omp[/:hostId]`, owner: OmpSettings)

Every setting `omp config` knows, for one host, with omp's own tabs, groups, labels, descriptions
and choices (architecture §3.10). Entry points: Settings → New agents → omp settings, host card ⋯ →
omp settings, palette / Ctrl+8, mobile More.

| File | Role |
|---|---|
| `OmpSettingsView.tsx` | Page: host picker (route host → last shown → first online), search (label, description, key, group), tab rail (desktop) / tab chips (phone), sections, states (offline, older hostd → update hint, `source: "cli"` banner, errors) |
| `controls.tsx` | `SettingRow` + one control per editor kind; modified dot, reset to default, warning, condition hint, `$ENV` override hint, key |
| `ModelRoles.tsx` | `modelRoles` editor at the top of the Model tab: built-in chat roles, model-kind roles, custom roles (add/remove); searchable model picker from `host.models` (typed `provider/id` allowed) + thinking level |
| `model.ts` | Pure helpers: omp's tab/group order (`OMP_TABS`, from pi-tui `settings-defs`), `buildTabs`, search, `editorFor`, number/JSON parsing, conditions, role selectors, `applyLocal` (tested in `model.test.ts`) |
| `useOmpSettings.ts` | `omp.settings` per host + queued `omp.settingsSet` writes (optimistic; the host's answer is applied once the queue drains; a failure toasts and reloads) |

## Editors

| Kind | When | Saves |
|---|---|---|
| `roles` | `modelRoles` | whole record on each change |
| `secret` | credential (`credential`, `ui.secret`) | write-only field; Clear = reset. Values never come back from the host |
| `switch` | boolean | on toggle |
| `choice` | enum: segmented (≤ 3 short choices) or select with option descriptions | on pick |
| `number` | number; presets (omp's options) + Custom… | after a typing pause, blur or Enter, when valid |
| `text` | string; presets when omp has options; `runtime` options (themes …) as free text | after a typing pause, blur or Enter |
| `members` | array with omp options or an item vocabulary (`statusLine.*Segments`): ordered list + Add menu | on each change |
| `list` | array of strings (declared by its item schema, or a non-empty value / default of strings) | on each change |
| `json` | record, `editor: json`, arrays of objects, empty arrays without an item schema | Save button, once valid (array / object shape checked) |

Settings without `ui` (≈ 140 in omp 18.12) are on the **Other** tab, grouped by key prefix, so every
key is editable. Conditions (`macOS`, `vimModeEnabled`, …) never hide a row: they show as a hint and
dim the row when they don't hold for the current values / host OS.

Demo: `src/core/demo/ompSettings.ts` (+ `ompSettingsFixture.ts`, a trimmed real schema dump),
validated like `omp config set`; `host.models` roles follow `modelRoles`.
