# features/wall (owner: Wall)

The wall (`#/wall`, desktop): live transcripts of 4 or 9 agents side by side for a big monitor. The split
view stops at two panes; the wall is the screen you leave open on the second monitor.

```ts
// @/features/wall/WallView — route screen (lazy). Phones get a "needs a bigger screen" page pointing to Ambient.
export function WallView(): JSX.Element;
```

Entry points: sidebar nav (Wall), the palette (Views › Wall; while open: Wall: 2×2 / 3×3 / unpin every tile).

## Tiles

- **What a tile shows** (`layout.ts`, pure, tested in `layout.test.ts`): its pin, else (Auto-fill on) the agent it
  showed before while that one is still a candidate, else the most important candidate not on the wall yet.
  Candidates, most important first: needs you (oldest question first), running (longest turn first), to review
  (newest first), fresh agents waiting for a prompt; done and parked agents are never auto-filled.
  A candidate that outranks an auto-filled agent takes its tile: at once when it needs you, otherwise only once
  that agent has been in its current state for `LINGER_MS` (2 min), so a finished transcript stays readable and
  auto tiles never reshuffle when running agents trade places. Pinned tiles never change by themselves.
- **Arranging:** click a tile's agent name to show another agent there (a searchable list by lane; an agent
  already on the wall trades places), drag a tile's header onto another tile to swap them (HTML5 drag and drop
  with a private MIME type, so the app's stray-file-drop guard ignores it), or use the tile's ⋯ menu: Pin / Unpin,
  Move to tile N±1, Remove from the wall (auto-fill skips it until you pick it again). Every arrangement made by
  hand pins the tiles involved. Toolbar: 2×2 / 3×3, Auto-fill, Reset (unpin all, bring removed agents back).
- **Answering:** a waiting question or approval shows as the compact ask card at the bottom of its tile (number
  keys stay with the full session: nine tiles can't share them). Clicking a tile makes it the active one, which
  also gets the composer (one composer on the wall, not nine); ⋯ → Reply focuses it.
- **Following agents:** a parked agent resumed under a new id keeps its tile (`onAgentMoved` while the wall is
  open, `useSuccessor` per tile for resumes that happened while it wasn't); agents whose session was deleted
  leave it (`onAgentsPruned`, replayed on mount).
- **Non-omp agents** (Claude Code, Codex, …) have no transcript: their tile watches the real terminal like the
  board's live tile (`TerminalPane mode="observe" compact`: the pane keeps its size and its driver's input, DOM
  renderer); ⋯ → Terminal opens it to type. Agents of a host that isn't online rank after every live agent.
- **Persistence:** `store.ts` (`tf.wall` in localStorage, per device): grid size, pins for all 9 tiles (a 3×3
  arrangement survives a trip to 2×2), the removed list, Auto-fill. What auto-fill chose is not persisted.

Keys: `F` hides the sidebar (focus mode, as in a session), `Esc` brings it back; leaving the wall ends it.

## Rendering budget (architecture §6.3)

- Each tile is a `SessionPane` (`compact`, no header, `composer` only on the active tile, `bloom={false}`: no
  blurred sunset layer behind ask cards). Transcripts are the session's virtualised list; each tile subscribes
  to its session while mounted (`openSession`, ref-counted, released 8 s after the tile changes agent).
- While the window is hidden (minimized, tray, another tab) the tiles unmount their transcripts, so the sessions
  are released and nothing streams into nine lists nobody sees; they reopen (from the cache) when shown.
- Tile headers use the board's leaf pieces (`AgentOrb`, a per-tile state time that ticks once a second only while
  running or waiting); `WallSync` turns core state into candidates with an equality check, so tiles re-render
  only when a tile's agent changes, not per streamed token.
