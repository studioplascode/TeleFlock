# features/dispatch (owner: Dispatch)

Fire tasks at a repository like chat messages: every message creates a fresh worktree with an omp
agent whose first prompt is the message, or which runs it when it is a slash command (`/plan add a settings
page`, a skill, a prompt template). Or pick "No folder · chat" and every message starts a chat
instead: an omp agent in a folder its host makes for it, no repository (architecture §3.31). Route
`#/dispatch` (`{ name: "dispatch" }`); desktop sidebar item next to Board, phone bottom-nav tab,
palette view "Dispatch", global key `D`; "New chat" (palette action, phone create sheet) opens it
on the chat choice (`openChat`).

## Public API

```ts
// src/features/dispatch/DispatchView.tsx — route screen (desktop + phone, full-bleed)
export function DispatchView(): JSX.Element;

// src/features/dispatch/store.ts — persisted threads (zustand persist, localStorage "tf.dispatch", v2)
export const useDispatch: UseBoundStore<…>;      // { threads, lastHost (target), lastRepo, bases, legacyBases, trusted, options, remotes, composerFocus, select, setBase, setOptions, trust, learnRemotes, add, patch, remove, clear, focusComposer, consumeComposerFocus }; composerFocus: a nonce asking the view to focus the task box (not persisted)
export function threadKey(target: string, repo: string): string;  // target = host id or "auto:<group>"; repo = root (host), repo id (Auto) or CHAT_REPO (a chat thread, `@/core/chats`)
export function entryHost(key, entry): string;                    // the host an entry went to (entry.hostId, else the thread's host)
export function entryRepo(key, entry): string;                    // that host's checkout root (entry.repo, else the thread's repo)
export function dispatchTask(args: { key?; hostId; repo; prompt; command?: FirstCommand; images?; base?; baseLabel?; placed?; options: DispatchOptions; taken: Iterable<string>; resolveBase?: BaseChoice; suggest?: BranchSuggester | null }): DispatchEntry; // suggest: default = tiny model when AI naming is on and there is text (a command: a task, `commandTask`); resolveBase { stored?, legacy }: fetch the host's branches, dedupe the name against them and resolve the base there (threadBase); repo = CHAT_REPO: a chat (no branch, base or resolveBase; agent.start with the chat target); command: the agent runs it (AgentSpec.command) instead of getting prompt, the text as typed
export function pendingByHost(threads, runningAgentIds, now): Record<string, number>; // dispatches on their way to each host (Auto's workload)
export function suggestDispatchName(hostId, repo, prompt): Promise<string | null>; // the send's suggestBranch call (the composer prefetches through it); a chat asks outside any folder (no cwd)
export function resumeInterruptedNaming(): void; // every `naming` entry cut short by a reload (any thread) goes ahead under the fallback name once its host answers; runs after hydration, call at startup
export function retryDispatch(args: { key; id; trust?: boolean; taken: Iterable<string>; host: { agents; workspaces } }): Promise<void>; // on the entry's own host; checks before re-creating (a chat: links its chat agent, else starts it again)
export function isInFlight(entryId: string): boolean;               // request queued / in flight in this tab
export function onDispatchSettled(cb: () => void): () => void;      // after each worktree.create (a chat: agent.start) settles
export function pruneAgents(hostId: string, agentIds: readonly string[], sessionIds?: readonly string[]): void; // drop entries (any thread, Auto included) of agents whose omp session was deleted and of deleted chats (HostInfo.pruned), and their images
export interface DispatchEntry { id; prompt; command?; createdAt; branch; name; aiNamed?; base?; baseLabel?; options; phase; startedAt?; workspaceId?; agentId?; paneId?; path?; error?; last?; sessionId?; images?; hostId?; repo?; placed?; chat? } // phase: naming | queued | creating | started | failed | unknown; sessionId: omp session captured while live; chat: a chat (branch "", no base / repo); command: the line its agent ran (a message that is a command; prompt = the text as typed)
export interface DispatchOptions { templateId: string | null; model: string; thinking: ThinkingLevel | "default"; plan: boolean; roleModels?; fallbackChains?; autoAnswer? } // the agent's own omp roles / chains and decide-for-me policy; absent (options saved before them) = none / the host default

// src/features/dispatch/images.ts — images of sent tasks (IndexedDB "tf.dispatch"/"images", keyed by entry id; memory fallback)
export const MAX_TASK_IMAGES = 8; // their total: MAX_PROMPT_IMAGE_CHARS (@/core/clipboardImages, 12 MiB base64; relay messages cap at 16 MiB)
export function saveEntryImages(id, images): Promise<void>; export function loadEntryImages(id): Promise<ImageInput[] | null>;
export function useEntryImages(id, count): DraftImage[] | null | undefined; // undefined while loading, null = not on this device
export function deleteEntryImages(ids): void; export function sweepEntryImages(liveIds): Promise<void>;

// src/features/dispatch/quota.ts — Auto's quota term
export function modelOf(spec): { provider; id } | undefined;      // "provider/id[:level]" → provider + id
export function useAutoQuotas(hostIds, choice): Record<string, QuotaReading | null | undefined>; // choice "default" → each host's modelRoles.default; host.limits polled every 5 min while the window is active

// src/features/dispatch/auto.ts — host groups as one target (auto.test.ts)
export function autoTarget(group): string; export function groupOf(target): string | null; export function groupHosts(profiles, group): HostProfile[];
export function canonicalRemote(url): string | null;              // git@github.com:O/r.git, https://github.com/o/r, ssh://git@github.com:22/o/r → "github.com/o/r"
export function repoIdOf(hostId, root, remotes): string;           // canonical remote, else "local:<host>:<root>"
export function groupRepos(hosts: { hostId; recents }[], remotes): GroupRepo[]; // { id, name, roots: { [hostId]: root }, at }
export function localRepoIds(repo): string[];                      // the "local:<host>:<root>" ids it had before its remote was known
export function findGroupRepo(repos, id): GroupRepo | undefined;   // by id, else by one of those local ids (threads keep the id they started under)

// src/features/dispatch/send.ts — one send outside any view (the composer and Quick capture both use it)
export function planSend(world: DispatchWorld, req: SendRequest): SendPlan;   // where it goes (single host / Auto pick), or the refusal's toast text; pure; a chat (repo CHAT_REPO) only to a host whose daemon starts chats; req.command (a FirstCommand) only to a daemon that runs it (takesCommands)
export function sendTask(world, req): { ok: true; hostId; entry } | { ok: false; title; description? }; // planSend + dispatchTask
export function dispatchTarget(profiles, hostIds, lastHost): { target; group }; // last host or group, else the first host
export function dispatchOptions(stored, settings): DispatchOptions;             // last used, else the Settings defaults
export function dispatchDraftKey(target, repo): string;                         // the composer draft of a thread
export function dispatchedRepos(threads); loadsOf(ids, states, status, threads, quotas?); takesImages(world, hostId); takesCommands(world, hostId); autoRepoOf(world, group, repo); repoNameOf(world, target, repo); // chats count as no repository; autoRepoOf(…, CHAT_REPO): the group's hosts that start chats; takesCommands: hostd ≥ COMMANDS_MIN_HOSTD ("0.9.1"), the demo host
export function chatHostsOf(states, ids): string[];                             // the hosts of ids whose daemon starts chats (HostInfo.chats)
export function chatRefusal(world, target): { title; description? } | null;     // why target can't take a chat (daemon from before chats or not known yet; Auto: no host of the group starts chats), CHATS_NEED_UPDATE words

// src/features/dispatch/openChat.ts — "New chat" (palette, phone create sheet)
export function openChat(): void; // Dispatch on its current target (last host or group, else the first host) with "No folder · chat" picked and the task box focused

// src/features/dispatch/commands.ts — a message that is a command (commands.test.ts)
export interface FirstCommand { line: string; replacesPlan: boolean }  // the line its new agent runs (AgentSpec.command; TeleFlock's `/model <id>` goes as `/switch <id>`); replacesPlan: it turns on plan, vibe or goal mode (OmpCommand.sessionMode), so the agent starts without the Plan option
export interface NewAgentCommands { commands: CommandInfo[]; skills: boolean; session: boolean } // what a new agent in the folder will have besides the builtins, as far as known
export function useNewAgentCommands(hostId, repo): NewAgentCommands; // skills.list for the folder (a chat: user level; switched-off skills left out) + agent.commands of a live bridged session in the repository (a chat: of a chat)
export function firstCommand(input, known): { ok: true; command: FirstCommand } | { ok: false; title; description? }; // recognised as the session composer recognises commands (findCommand); refused: one line only, unknown, a skill the folder's list lacks, needs arguments, no first message (whyNotFirst), TeleFlock controls of a running agent
export function whyNotFirst(cmd: OmpCommand, args): string | null;  // OmpCommand/OmpSubcommand.notFirst (history | session | turn | host), or a form omp shows in its TUI only (report, terminal)
export const NEW_AGENT_OFFER: SlashOffer;                            // the palette's filter: builtins with a form that fits (only the argument choices that fit), every skill, prompt template and extension command

// src/features/dispatch/thread.ts — pure helpers (thread.test.ts)
export const BRANCH_PREFIX = "dispatch/";
export const CHAT_CHOICE = "No folder · chat";                      // the repo chip's chat choice (CHAT_REPO)
export function baseSlug(prompt: string): string;                  // slugFromPrompt or "task": "Add offline caching to the client" → "offline-caching-client"; "Fix the following points and release 0.5.0 when you are done. - … - …" → "release-0-5-0-fixes"
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string; // -2, -3… vs names and dispatch/<name> branches; result ≤ 32 chars (herdr's agent-name limit)
export function cleanSuggestion(s): string | null;                 // an AI slug as a dispatch name (≤ 28 chars, whole words), or null (unusable)
export function nameDispatch(prompt, suggest?): Promise<{ slug; ai }>; // AI slug else prompt slug; the caller dedupes synchronously after the await
export function commandTask(command): { text; task: boolean };     // what a command message is named after: its arguments' task ("/plan add a settings page" → "add a settings page", a leading choice like `/goal set` left out; builtins with OmpCommand.task, every custom command), else the command itself ("/fast on")
export function commandSlug(command): string;                      // its name without AI: the task's slug, else the command's words ("fast-on", "review", "switch-openai-gpt-5")
export function prefetchKey(draft: string): string | null;         // trimmed draft once it has 3+ words
export function rambleAbout(repo): string | undefined;             // Rambler's context for a dictated task: "Repository: <name>"; none for a chat (CHAT_REPO) or no repo
export function threadBase(list, stored, legacy): { shown; param?; untouched }; // see Behaviour → Base
export function recentRepos(state, dispatched): RecentRepo[];       // workspace repo roots (+ remoteUrl) + dispatched repos, most recent first
export function resolveAgent(entry, agents, scope: { repo; workspaces }): Agent | undefined; // agentId → pane (same name) → name; always inside the entry's worktree; a chat entry: chat agents only (Agent.chat), and a worktree entry never takes one
export function slimThreads(threads, maxEntries, maxPrompt): Record<string, DispatchEntry[]>; // persisted copy
```

Shared helpers used here: `@/core/clipboardImages` (`imageFiles(clipboardData | dataTransfer)` reads
the files of `items`, else of `files`, never both — WebKitGTK puts pasted screenshots only in `items`, Chromium in both;
`dragHasFiles`; `attachImages` scales images > 3 MB to ≤ 2560 px and adds them within the caps,
as the session composer does), `@/core/workload` (`hostLoad`, `rankHosts`, `pickHost`, `describeLoad`, `providerQuota`, `explainPick`).

## Behaviour
- Top bar: target chip (more than one host, or any host group): single hosts and every host group
  as "Auto · <group>" with each member's current load; repo chip (recent repos of the host:
  workspace repo roots, linked worktrees folded into their repo, plus repos dispatched to before;
  "Browse…" opens the FolderBrowser in repo mode — single hosts only), base-branch chip. The last
  target and the last repo per target are remembered. Picking a repo (chip menu, empty-state chips,
  Browse…) puts focus in the task box. With no recent repos the empty state offers "Browse for a
  repository…". Under the composer: "New worktree" / "Fan out" open those dialogs prefilled with the
  host, repo (and the current draft for Fan out). The composer block is a `data-toast-anchor`: toasts
  (a persistent needs-you one too) sit above it, never over the task box or its send button.
- Chats (`CHAT_REPO` from `@/core/chats`, architecture §3.31): the repo chip's first item, "No folder ·
  chat" (also an empty-state button), is remembered as the target's last repo like any repo (thread
  and draft keys use `CHAT_REPO`). It is disabled, with the reason under it, when the target can't
  start chats (`chatRefusal`): a host whose daemon has no `HostInfo.chats` (`CHATS_NEED_UPDATE`
  words, the update hint as tooltip) or that was never heard from ("offline"), a group none of
  whose hosts start chats. Picked, the chip reads "No folder · chat", there is no base chip, no
  trust and no New worktree / Fan out offers, and the hint, placeholder and empty thread say each
  message starts an omp agent in a new folder of its own on the host (under `HostInfo.chats`), no
  repository. Images, videos, large pastes, templates, plan and More agent options work as for a
  repository. A send is `agent.start { target: { kind: "chat" }, spec }` with the same spec as a
  worktree's agent; a single host must start chats (else the toast says so), Auto picks the least
  busy online host of the group that starts chats (and takes images, with images), with the same
  workload and quota terms and `placed` line. Naming is a task's (AI slug or the prompt's), deduped
  against the host's live agents and dispatches; no branch list, no `dispatch/` branch, no base (the
  host still keeps the name unique: `-2` when an agent has it by then; the card shows the agent's).
  The entry (`chat: true`, `branch: ""`) shows a "Chat" chip (`features/chats/ChatTag`) where branch
  and base go, "Naming the chat" / "Starting chat" steps, Open session / Terminal, never Review. It
  links only a chat agent (`Agent.chat`) by id, pane or name, and a worktree entry never links one.
  A daemon from before chats refusing the target (`chatsUnsupported`) fails the entry with the
  update words. Retry links its chat agent if it is there, else starts the chat again, under the
  same name unless another agent or dispatch holds it now. Deleting a chat
  (`HostInfo.pruned`) drops its entries. "New chat" (palette action, phone create sheet) picks
  the chat choice on Dispatch's current target and focuses the task box (`openChat`); "New task"
  (`D`, sidebar) opens Dispatch as before.
- Base: the host's default base, `BranchList.defaultBase` (`origin/<default>` when that
  remote-tracking branch exists), shown on the chip, in the composer hint and on each entry
  (`← origin/main`). Untouched, the send carries no `base`, so a 0.5 hostd fetches and forks from
  `defaultBase`; an older hostd (no `defaultBase`) gets its default branch spelled out. A pick
  (another branch, HEAD) is remembered per thread and sent as is. A base remembered before 0.5 that
  equals the local default branch counts as untouched (`legacyBases`, store v2 migration; without
  a branch list it can't be told apart, so it counts as untouched too). Auto sends (and a send
  before the branch list is in) resolve the base on the host the task goes to (`resolveBase`): a
  remembered branch that host lacks falls back to its default.
- Videos: the same attach button (`image/*,video/*`), paste or drop; chips with name, size, upload
  progress, retry and remove (`@/core/draftVideos`, memory only). A single-host thread uploads each
  video as soon as it is attached; Auto uploads to the host each task goes to, when it is sent.
  `dispatchTask({ videos })` stores `videos: { name, size, path?, upload? }[]` on the entry, which
  waits in `uploading` ("Uploading the video · 45%") before `queued`; the first prompt then carries
  one `Attached video "<name>" (<size>): <host path> (read it to see it)` line per video (after the
  task, inside a template's framing). A failed upload fails the entry (Retry uploads it again); a
  reload mid-upload fails it ("send the task again"); dismissing it drops unsent uploads on the host.
  A video-only task is named `video-task`.
- Images: attach button, paste (clipboard `items`, else `files`) or drop into the composer; thumbnails
  with remove and a lightbox; persisted with the draft (`useDraftImages` on the target + repo draft
  key). At most 8 per task and ~9 MB in total (base64 ≤ 12 MiB, under the relay's 16 MiB message
  cap), checked against the images attached by the time each paste is read and again at send;
  images over 3 MB are scaled down first; a clear toast says what was left out. Image-only
  tasks are fine (named `image-task`, no AI naming). The images go to the host as
  `worktree.create { agent: { images } }` and hostd delivers them with the agent's first prompt.
  Each entry keeps its images in IndexedDB (`images.ts`) for the thread's thumbnails and for
  retries; they are deleted when the entry leaves the threads (dismiss, clear, cap, pruned) and
  swept at startup. A host daemon older than 0.5 (or whose version isn't known yet) would ignore
  `agent.images`: Auto leaves such hosts out of an image task's pick, and a send with images to a
  single such host is refused with an "update the host" toast. Images no longer on this device (another
  device's thread, cleared storage) show as "N images (not on this device)" and a retry fails
  with a clear error instead of sending without them.
- Large text pastes: as in the session composer (architecture §6.5, `@/features/session/composer/usePasteAttach`):
  past 10 lines or 1000 characters a paste becomes omp's `[Paste #N, +L lines]` marker and a chip (first line,
  size, how it goes); from the host's `paste.largeMenuThreshold` lines on omp's menu opens. The task goes out
  with every marker expanded (`<attachment>…</attachment>` for a wrapped block), so naming, the thread entry and
  the agent's first prompt see the full text; the chips persist with the draft like images. **Attach as local
  file** is shown off ("The new agent has no session yet…"): `local://` resolves inside the agent's omp session,
  which only exists once `worktree.create` started it, and Auto picks the host only at send. An absolute path in
  the host's upload dir (what videos use) was not taken: omp's own flow never leaks raw paths into prompts,
  uploads are pruned after 30 days while the prompt stays in the session, and the file would sit outside the
  session and repo the agent works in. A wrapped block carries the same text without those trade-offs.
- Prefilled tasks (`features/capture`): an Android share or Quick capture's "Open in Dispatch"
  lands in the composer draft of the thread `prefillPlace` picks (a shared GitHub issue's repo
  when a host has a clone, else the last repo; with none picked yet, the first one picked), added
  after what the draft held. A banner above the composer says where it came from and offers
  **Send to agent…** (moves exactly what it added into an agent's composer). The banner goes once
  the draft is sent or emptied.
- Auto (host groups, `HostProfile.group`, set in the host editor): the repo chip lists the union of
  the group hosts' repositories, matched by canonical `origin` URL (scp/https/ssh, `.git`, case
  and ports normalised; learned from workspaces into `remotes`) — each host keeps its own checkout
  root. Every send picks the least busy online host that has the repo (`@/core/workload`: running
  agents and dispatches on their way count 1 each, needs-you 0.3, CPU pressure — max of CPU% and
  load/cores — ×2, memory above 85 % steeply; ties → fewer agents on the way, lower CPU, profile
  order), so consecutive sends alternate between equal hosts. Each host has its own subscription
  logins, so the chosen model's quota counts too (`quota.ts` `useAutoQuotas`, `providerQuota`):
  the model is the send's `options.model`, "Default model" being each host's own `modelRoles.default`
  (`host.models`); from that host's `host.limits`, per account of the model's provider the window
  that binds first (shared windows plus the model's tier; `tightestWindow`), then the account with
  the most room. Its used share adds ×3 (70 % left vs 15 % left ≈ 1.6 running agents); a host
  without a reading (limits not in yet, API key, no subscription) counts as half used; an exhausted
  window adds 50, so a task only waits for a reset when no host has room. The entry records
  `hostId`, that host's `repo` root and `placed` (`explainPick`: "least busy of 2: 1 running · CPU
  34% · Claude 5 Hour 70% left (studio-pc: …)", led by "most Claude 5 Hour left of 2" when the quota
  changed the pick), shown on the card as "on <host> · why"; the group chooser's loads show the
  quota part too. Items, retries, trust (`trusted[host + root]`) and naming use the
  entry's host. The composer hint names the group's hosts and the next pick. No host with the
  repo, or none online → the composer says so and sends nothing. A thread started while the repo
  had no known remote (`local:<host>:<root>`) stays reachable once its remote is learned: it is
  matched by its local id (`findGroupRepo`), and picking the repo goes back to it.
- A dispatch is one `worktree.create { cwd: root, branch: "dispatch/<slug>", base?, label: slug,
  existing: false, trust, agent: { kind: "omp", name: slug, model, thinking, plan, prompt | command, images?, roleModels?, fallbackChains?, autoAnswer? } }`.
  The footer's More options chip (what is set, when anything is) opens "More agent options" (dialog, sheet on phones):
  the agent's own model roles and fallback chains (`features/agentRoles`) and decide for me (`features/autoAnswer`),
  kept with the options; picking a template keeps them. The policy goes only to a host with decide for me, checked
  as each task goes to its host (Auto: the host picked; an older tf-hostd gets none and never decides); the dialog
  and the chip go by the composer's host (Auto: the next pick). A template's prompt frames the message (as in Fan out). With
  Settings → AI naming on (and the host's omp able to answer), the entry first goes through
  `naming`: omp's tiny model suggests the
  slug (`suggestBranch`, 10 s cap, "Naming…" on the card, ✨ beside the result); otherwise, on no
  answer, an agent-like answer ("I need to inspect the repository" is rejected by the sanitizer),
  or after a reload mid-naming, the slug comes from the prompt's lead sentence (`slugFromPrompt`).
  The composer asks for the name ahead of time (after ~1.2 s idle with 3+ words; ai.ts caches it),
  so most sends skip the wait. Either way the slug is deduped against existing branches, live agent
  names and every live dispatch on the host (herdr agent names are unique per host, so other repos'
  pending dispatches count).
- Commands: `/` opens the session composer's palette (`useSlashPalette`, `features/session/composer/SlashPalette.tsx`):
  omp's builtins, the folder's skills (`skills.list` for the repository, user level for a chat; switched-off ones left
  out) and the prompt templates and extension commands a live session there lists (`agent.commands` of a bridged agent
  in the repository, a chat for a chat), with argument hints and argument choices; ↑↓, Tab or Enter picks, Esc closes.
  A pick only completes the text (Enter then dispatches). It offers what makes sense as a brand-new agent's first
  message (`NEW_AGENT_OFFER`), and only such argument choices: not what works on what a session already has
  (`/compact`, `/retry`, `/fork`, `/btw`, `/todo`, `/goal pause`), leaves or replaces the session (`/new`, `/resume`,
  `/exit`), acts on a running turn (`/queue`) or on omp for every agent (`/logout`, `/reload-plugins`), nor what omp
  shows in its own TUI only (`/usage`, `/settings`, bare `/goal`, `/model roles`) or TeleFlock's controls of a running
  agent (`/stop`, `/terminal`) — the catalog's `notFirst` and modes (`@/core/ompCommands`). A message is a command when
  what was typed starts with `/` and it carries no images or videos, as in the session composer (a leading space makes
  it text; a paste token doesn't count). A line above the text says "Runs /plan in the new agent" (plus that `/plan`,
  `/vibe`, `/goal` or `/guided-goal` picks the mode, so the Plan option is left off, and that a template's text isn't
  added to a command: its model, thinking and plan still apply), or why it can't run (`firstCommand`: unknown, a skill
  the folder lacks, one line only, needs arguments, no first message), and the send refuses with the same words. The
  agent's spec carries it as `command` (`AgentSpec.command`) instead of a prompt: its host runs it once the agent is idle and linked, as `agent.slash`
  does (architecture §3.7), so `/plan add a settings page` starts it in plan mode on that task, and a skill or prompt
  template expands as in omp. A command omp refuses shows on the agent as an error activity ("/x didn't run").
  TeleFlock's `/model <id>` goes as `/switch <id>`. It is named after the task its arguments give (`commandTask`:
  builtins whose arguments are one, such as `/plan`, `/vibe`, `/goal`, `/loop`, and every skill, prompt template and
  extension command; a leading choice like `/goal set` left out), with AI naming as for any task, else after the
  command itself without AI (`/fast on` → `fast-on`, `/skill:review` → `review`). Only tf-hostd 0.9.1 and newer runs
  it (`takesCommands`; an older daemon would drop it and start the agent idle): a single such host refuses the send
  (update it, or start the message with a space to send it as text), Auto leaves such hosts out. The thread shows
  the message as typed with the command in mono; one that starts no turn (`/fast on`) stops showing "Starting agent"
  once the agent's link has been up 10 s. The thread has no reply box: later messages to the agent go through its session.
- Sends never wait for each other: up to 3 creates per thread run at once, more wait as "Queued".
  The composer clears and keeps focus. Enter dispatches on desktop (Shift+Enter newline); on phones
  Enter is a newline and the send button dispatches.
- Reply card: (Naming…) → Queued → Creating worktree → Starting agent (agent present, no turn yet)
  → live status from host state (orb, state pill from `vocab.agentStateWord`, streaming line / tool
  chip, elapsed, quiet chip), Needs-you answered inline with the board's `QuickAnswer`, To review /
  Waiting for prompt / Done; "sent with:" options line; Open session, Terminal, Review.
  Failures show `describeError` with "Trust repository & retry" (untrusted) and "Retry".
  A timeout / lost connection (`timeout`, `not_connected`, `disconnected`) or a reload mid-request
  leaves the entry "Unconfirmed" (amber notice, not a failure): the host may still be creating it,
  so the entry keeps looking for its agent. Every Retry checks first: a matching agent is linked;
  an existing `dispatch/<name>` worktree gets the agent started in it (`agent.start`; "name taken"
  means it is still starting, so it waits); only otherwise is the worktree created again, under a
  fresh name if a leftover branch is in the way.
- Agents are linked only inside the entry's own worktree (same repo root and branch, or the
  checkout path herdr reported), never to a same-named agent of another repo.
  Entries whose agent is gone show the last seen lane ("Finished · closed"), no error.
- Threads keep the newest 200 entries; the view renders the last 60 with "Show earlier" and scrolls
  to each new message (keyed on the newest entry). The thread menu removes failed entries or clears
  the thread (agents and worktrees are untouched).
- Persistence is budgeted: at most 600 entries across all threads, prompts up to 4000 characters.
  A full localStorage retries with a slimmer copy, then stops persisting; the in-memory thread keeps working.
