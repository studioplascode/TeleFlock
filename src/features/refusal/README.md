# features/refusal: refusal fallback (architecture §3.22)

When a provider refuses a turn (omp's `stopDetails` `refusal` / `sensitive`: a cyber refusal, say) and omp's own retry
fallback chains don't take it over, tf-hostd switches the session to another model and goes on with the same turn: by
rule, with or without an app connected. This is the app's half: the rules (Settings), the one-off "Retry with" and
"Always do this" on the refusal row, and the link from omp's fallback chains. Wire types: `RefusalRule`,
`RefusalFallback`, `RefusalFallbackSetParams`, `RefusalRetryParams`, `RefusalAfter`, `Capabilities.refusalRetry`
(`@/core/gen`); methods `host.refusalFallback`, `host.refusalFallbackSet`, `agent.refusalRetry`. A host before 0.9.0
answers `unknown_method` (Settings: "Needs TeleFlock 0.9.0 on this host"); an agent whose omp lacks bridge 2.3.0 has
`caps.refusalRetry` false (the refusal row says to Mark done and Resume it).

| File | What |
|---|---|
| `@/core/refusal.ts` | Shared with the demo host, as tf-hostd keeps and matches rules (tested in `core/refusal.test.ts`, with tf-hostd's own selector cases): `normalizeRule` (category trimmed and lower-cased, none or "any" = every refusal; a real `:level` dropped from `from` and moved to `thinking` from `to`; `*` or empty `from` = any model), `validateRules` (hostd's exact `invalid_params` words, at most 32), `categoryMatches` (a safety-filter flag names no category: only a rule without one covers it), `selectorMatches` (tf-hostd's `selector_matches`, case-insensitive: the part before `/` is the provider, the rest a pattern for the id alone; a bare id matches on any provider; `provider/*` and a trailing `*` match a family, so a bare `anthropic*` names no Anthropic model), `ruleMatches`/`firstMatch` (a rule that would go to the refused model is skipped, as tf-hostd's `same_model` tells it: the same id on its provider or on one not known), `lastRefusalRowId` (the refusal row that ended the turn: past notices, model rows, compactions and IRC, nothing else after it), `modelName` (`claude-opus-5-5` → "Opus 5.5"). |
| `model.ts` | Pure, tested in `model.test.ts`: names (`selectorName`, `ruleWords`), `retryTarget` (what "Retry with" starts on: the host's first matching rule with its level, else the newest Sonnet of the refused model's provider, else another model; never the refused one), `suggestedRule` (newest Opus with a Sonnet of its own version on its provider, for cyber refusals; not offered once a rule decides them), the rule form (`checkDraft`: tf-hostd's checks in the form's words, per field, plus "a rule above already decides this"; `draftOf`/`ruleOf`), the list (`withRule`, `moved`, `without`, `restored`: Undo of a removal puts the rule back at its place in the list as it is then; `sameRules`). |
| `store.ts` | Rules per host (`loadRules`, `changeRules`, `useEnsureRules`): one question at a time (a question asked before a save is not shared, and its older answer is not shown); `old` for a host without the method; the host's answer is what is shown. Every write is a `changeRules(hostId, change)`: one at a time per host, in order, `change` getting the host's rules as they are once the earlier ones are saved (asked again), so no change saves over another (tested in `actions.test.ts`). |
| `actions.ts` | `retryOnModel` (`agent.refusalRetry`; toasts "Continuing on Sonnet 5", or "Nothing to retry" when the turn isn't refused any more or the agent is busy), `alwaysDoThis` (the rule becomes the host's first rule, with an Undo in the toast, and this turn goes on with it now: the host only acts on refusals that come after the rule; two at once on one host both stay), `removeRule` (the undo: takes out that rule only). One call per agent at a time. |
| `RefusalSettings.tsx`, `RuleEditor.tsx` | Settings → Refusal fallback (after Auto-resume): per host the rules in the order they apply (the first that matches decides) with add, change, remove (Undo puts the rule back into the rules as they are then, at its place) and reorder; a change made from the list shown is saved only while that is still the host's list (else "The rules changed meanwhile" and the list as it is now); the form (When the provider refuses for · on the model · Go on with · Thinking level · Afterwards: stay or switch back) with the whole rule read back as a sentence; the suggestion "Opus 5.5 → Sonnet 5.5 for cyber refusals" while both models exist on the host. Reuses `ModelCombobox` / `ThinkingSelect` (`features/ompSettings/ModelRoles`). Offline hosts show what they have and "Connect the host…". |
| `RefusalLink.tsx`, `focus.ts` | The link under the Retry Fallback Chains setting on the omp settings page (rule count, "Refusal fallback" button); `openRefusalSettings(hostId)` opens Settings with the card in view and the host's block lit. |

The refusal row (`session/transcript/RefusalActions.tsx`, mounted by `ErrorCard`): only the row that ended the session's last
turn in the store's own session (not an older refusal, a preview or a subagent transcript), while the agent is idle on a live
link: **Retry with <model>** (a split button: the chevron picks another model from the host's list) and **Always do this for
<category> refusals on <model>**; where a rule already covers the refusal it says so and links to Settings. The header's Resume
gives way to it (omp has nothing to retry after a refusal: F5 says so).

Demo (`?demo`, `src/core/demo/refusal.ts`): forge starts with no rules (so the suggestion shows); `authbug` in Review ended on
Opus's cyber refusal of a plain bug fix: Retry with Sonnet switches it, adds the model row and the notice "Opus 5 refused
(cyber); switched to Sonnet 5 and continued" and runs the turn on; studio-pc plays a tf-hostd before 0.9.0.
Tests: `bun test src/core/refusal.test.ts src/features/refusal src/core/demo/refusal.test.ts`.
