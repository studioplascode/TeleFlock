# RenameCtx lab: "Name it again" end to end

Proves, with the real tf-hostd and a real omp, what omp's tiny model receives when the app names an agent
again from its whole session (0.9.1): host method `session.digest` → `src/core/ai.ts`
(`AI_SYSTEM.agentRename`, `agentRenamePrompt`, `suggestAgentRename`) → host method `ai.complete` →
`omp --model @tiny --system-prompt …` → the mock provider, which records the request.

Everything lives under `/tmp/tf-lab-renamectx` (scripts/lab/run's isolation: own HOME, herdr session
`tf-lab-renamectx`, tf-hostd home, omp agent dir); nothing real is touched.

## Run it

```sh
CARGO_TARGET_DIR=/root/TeleFlock/target/shared cargo build -p tf-hostd -p tf-devserver   # the tree's hostd + devserver (embeds the bridge)
scripts/lab/renamectx/setup.sh --fresh          # herdr, mock (127.0.0.1:18741), tf-devserver (127.0.0.1:7441); pins hostd/devserver/omp copies
bun scripts/lab/renamectx/drive.ts              # ~1 minute, prints ok/FAIL per check, exit 0 when all pass
scripts/lab/stop renamectx --purge              # after drive.ts: its evidence is already copied out
```

Ports: mock 18741, devserver 7441, tf-hostd relay 47741 (setup.sh refuses to start when one is taken).
`drive.ts --out DIR` changes where the evidence is copied (default `/root/TeleFlock/target/evidence/renamectx`, gitignored);
`--no-goal` skips the omp goal.

## What it does

- `mock.ts`: OpenAI chat-completions provider for omp, every role (`default`, `tiny`, …) on `mock/lab-1`
  (`models.yml`, `config.yml`). Records every request body verbatim to `logs/requests.jsonl` (system, messages,
  tool names, the whole body). Answers: `todo` init for the plan prompt, `todo` start for the track decision,
  `write src/hud.rs` for the hud prompt, `Name: bloomworks-m0` / `Title: Bloomworks city-builder, milestone M0`
  for the `agentRename` call, plain acks for everything else (goal continuations, reminders).
- `drive.ts`: starts agent `lab-agent` (omp, through tf-hostd and the TeleFlock bridge) and sends four prompts that
  build one objective (Bloomworks M0 plan with todo phases; a track decision; a layout note; the latest step, a
  tiny edit "Update hud.rs to show the population counter"), setting an omp goal after the second. Then:
  1. `session.digest` → `/tmp/tf-lab-renamectx/digest.json`, checked (first prompt n=1, phases, counts, order).
  2. Imports `src/core/ai.ts` and `src/features/board/renameAgain.ts` into bun, turns `aiNaming` on, and routes
     `ai.complete` (`aiTesting.setComplete`) to the lab host over the devserver's `/ws`. Runs
     `suggestAgentRename` with `agentRenameInput(agent, [], digest)` (session never opened in the app), then the
     whole `renameAgain` flow with its `Io` wired to the lab host (transcript rows from `session.open`,
     `agent.renameHandle`, `agent.rename`), so the rename is applied and read back.
  3. Reads the mock's recording and checks what the tiny model got: the system prompt starts with
     `AI_SYSTEM.agentRename` (omp appends its own `<project-context>` / `<critical>` block), the user message
     contains the client's prompt verbatim (omp prepends a `<system-reminder>` with date and cwd), and its parts
     appear in order `current < goal < first-prompt < later-prompts < latest-prompt < todos < latest-activity`.

## Evidence

In `/tmp/tf-lab-renamectx` and copied to the `--out` dir: `digest.json`, `rename-request.txt` (system prompt +
user message verbatim as the mock received them, plus the model's answer; the `renameAgain` call),
`rename-request-norows.txt` (same without transcript rows), `rename-client-prompt.txt` (what the client composed),
`rename-result.json`, `agent-after.json`, `requests.jsonl` (every provider request of the run), `mock.log`, `hostd.log`.
