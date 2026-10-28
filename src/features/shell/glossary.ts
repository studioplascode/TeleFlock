/**
 * Plain-language meanings of the terms TeleFlock, herdr and omp use. Shown by `<Term>` (dotted
 * underline + tooltip, tap on phones), menu second lines and the shortcuts sheet's Terms column.
 * Keep each entry to one or two short sentences that say what it means for the user.
 */
export const GLOSSARY = {
  herdr: { term: "herdr", text: "The terminal workspace manager your agents run in. TeleFlock shows its panes; they keep running without the app." },
  omp: { term: "omp", text: "The coding agent (oh-my-pi) running in each pane. TeleFlock is a window onto it." },
  host: { term: "Host", text: "A machine that runs herdr and omp. TeleFlock connects to it over Tailscale SSH, locally or in WSL." },
  workspace: { term: "Workspace", text: "A folder in herdr, usually a git checkout, with the panes working in it." },
  worktree: { term: "Worktree", text: "An extra checkout of a repository on its own branch, so parallel agents never edit the same files." },
  pane: { term: "Pane", text: "A terminal pane in herdr. Ids like w5:p1 mean workspace 5, pane 1." },
  session: { term: "Session", text: "One omp conversation: transcript, context and cost. Saved on the host and resumable." },
  turn: { term: "Turn", text: "One run of the agent, from a prompt until it stops and waits." },
  steer: { term: "Steer", text: "A message that reaches the agent during its current turn." },
  followUp: { term: "Follow-up", text: "A message queued until the current turn ends, then sent as the next prompt." },
  context: { term: "Context", text: "How much of the model's memory window the session fills. Compact frees space." },
  compact: { term: "Compact", text: "Summarise older turns so the session has room to keep going." },
  handoff: { term: "Hand off", text: "Continue in a fresh session that starts from a summary of this one." },
  thinking: { term: "Thinking", text: "How long the model reasons before it answers. Higher is slower, smarter and costlier." },
  plan: { term: "Plan mode", text: "The agent proposes a plan and waits for your OK before it edits anything." },
  fast: { term: "Fast mode", text: "The provider's priority tier: quicker responses at a higher price, where offered." },
  goal: { term: "Goal mode", text: "A long-running objective with a budget; the agent keeps working towards it." },
  subagent: { term: "Subagent", text: "A helper the agent started for part of the task. Its cost counts toward the session." },
  advisor: { term: "Advisor", text: "A second model omp consults on hard steps. Its cost counts toward the session." },
  btw: { term: "BTW", text: "Side questions answered without interrupting the agent (/btw)." },
  dispatch: { term: "Dispatch", text: "Send a task like a message: it gets its own worktree and agent." },
  fanOut: { term: "Fan out", text: "Run one task on several agents at once, each in its own worktree, and keep the best." },
  markDone: { term: "Mark done", text: "Moves a card to Done. The worktree and session stay; drag it back to reopen." },
  stale: { term: "Stale", text: "The last known state of a host that is offline. Frozen and read-only until it reconnects." },
  collab: { term: "Session sharing", text: "omp's collab: TeleFlock joins each session as a private guest on the host, so it sees it live." },
  bridge: { term: "TeleFlock bridge", text: "TeleFlock's omp extension. Sessions that load it show up live by themselves, with exact controls (model, queue, tree) instead of typed keystrokes." },
  hostd: { term: "tf-hostd", text: "The small helper TeleFlock installs in ~/.teleflock on each host. It talks to herdr and omp for the app." },
  tinyModel: { term: "Tiny model", text: "omp's tiny model role (modelRoles.tiny). TeleFlock asks it to name branches and agents and to draft messages." },
} as const satisfies Record<string, { term: string; text: string }>;

export type GlossaryId = keyof typeof GLOSSARY;
