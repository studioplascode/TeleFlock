import type { Answer, ChangedFile, NeedsOption, PlanReview, Subagent, ToolView, UiKind } from "@/core/gen";
import { fileBody } from "./codegen";
import type { Rng } from "./rng";

/** A tool call the simulated agent makes. */
export interface ToolSpec {
  tool: string;
  title: string;
  intent?: string;
  args: unknown;
  /** Run time (ms). */
  ms: number;
  /** Output streamed line by line while running (ANSI allowed). */
  output?: string[];
  /** Final rich view. Bash views get their output filled in automatically. */
  view?: ToolView;
  exitCode?: number;
  error?: string;
  /** Files this call changes (edit/write). */
  files?: ChangedFile[];
  /** Task tool: subagents that run in parallel during `ms`. */
  subagents?: SubagentSpec[];
  /** Produce no events while running (quiet detection). */
  silent?: boolean;
}

export interface SubagentSpec {
  name: string;
  description: string;
  ms: number;
  model?: string;
  lines: string[];
}

export interface UiSpec {
  kind: UiKind;
  /** NeedsYou kind override (approvals are `select` UIs with `approval` needs). */
  needs?: "ask" | "approval" | "planReview" | "confirm" | "input";
  title: string;
  message?: string;
  options: NeedsOption[];
  allowOther?: boolean;
  allowChat?: boolean;
  initial?: string;
  plan?: PlanReview;
  command?: string;
  /** The tool call shown while waiting (ask tool / gated bash). */
  tool?: ToolSpec;
}

export type Step =
  | { t: "user"; text: string; author?: string; steering?: boolean; synthetic?: boolean }
  | { t: "think"; ms: number; text: string }
  | { t: "say"; text: string }
  | { t: "tool"; spec: ToolSpec }
  | { t: "todo"; task: string; status: "pending" | "inProgress" | "completed" | "abandoned" | "blocked" }
  | { t: "ui"; ui: UiSpec; then: (a: Answer) => Step[] }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string }
  | { t: "mode"; text: string }
  | { t: "wait"; ms: number };

// ------------------------------------------------------------------ builders

export const opt = (id: string, extra: Partial<NeedsOption> = {}): NeedsOption => ({
  id,
  label: extra.label ?? id,
  recommended: false,
  tone: "neutral",
  ...extra,
});

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const B = "\x1b[1m";
const X = "\x1b[0m";

export function bash(command: string, output: string[], ms: number, exitCode = 0, intent?: string): Step {
  return {
    t: "tool",
    spec: {
      tool: "bash",
      title: command,
      intent,
      args: { command },
      ms,
      output,
      exitCode,
      view: { type: "bash", command, output: "", exitCode, background: false, timedOut: false },
      error: exitCode === 0 ? undefined : `exit code ${exitCode}`,
    },
  };
}

export function read(path: string, lines = 88): Step {
  return {
    t: "tool",
    spec: {
      tool: "read",
      title: path,
      args: { path },
      ms: 400,
      view: { type: "read", path, range: `1-${lines}`, lines, preview: fileBody(path, 14), lang: path.split(".").pop() },
    },
  };
}

export function grep(query: string, hits: { path: string; line: number; text: string }[]): Step {
  const files = new Set(hits.map((h) => h.path)).size;
  return {
    t: "tool",
    spec: {
      tool: "grep",
      title: query,
      args: { pattern: query },
      ms: 700,
      view: { type: "search", query, matches: hits.length, files, hits },
    },
  };
}

export function edit(file: ChangedFile, intent?: string): Step {
  return {
    t: "tool",
    spec: {
      tool: file.status === "added" ? "write" : "edit",
      title: file.path,
      intent,
      args: { path: file.path },
      ms: 900,
      files: [file],
    },
  };
}

export function think(text: string, ms = 2500): Step {
  return { t: "think", ms, text };
}

export function say(text: string): Step {
  return { t: "say", text };
}

export function todo(task: string, status: "pending" | "inProgress" | "completed" | "abandoned" | "blocked"): Step {
  return { t: "todo", task, status };
}

// ------------------------------------------------------------------ per-agent turns

const BOARD_TESTS = [
  `${G}❯${X} bun test src/board`,
  `bun test v1.4.3`,
  ``,
  `${G}✓${X} columns.test.ts ${D}(6)${X}`,
  `${G}✓${X} persist.test.ts ${D}(9)${X}`,
  `${G}✓${X} drag-drop.test.ts ${D}(12)${X}`,
  `${R}✗${X} keyboard-move.test.ts ${D}(2/6)${X}`,
  `  ${R}●${X} moves a card down with Shift+J ${D}— expected index 2, got 3${X}`,
  `${G}✓${X} lane-order.test.ts ${D}(4)${X}`,
  `${Y}●${X} a11y.test.ts ${D}(0/3) running…${X}`,
  ``,
  `${B}31/40 passing${X} ${D}· 9 failed · 1.82s${X}`,
];

const BOARD_TESTS_GREEN = [
  `${G}❯${X} bun test src/board`,
  `bun test v1.4.3`,
  ``,
  `${G}✓${X} columns.test.ts ${D}(6)${X}`,
  `${G}✓${X} persist.test.ts ${D}(9)${X}`,
  `${G}✓${X} drag-drop.test.ts ${D}(12)${X}`,
  `${G}✓${X} keyboard-move.test.ts ${D}(6)${X}`,
  `${G}✓${X} lane-order.test.ts ${D}(4)${X}`,
  `${G}✓${X} a11y.test.ts ${D}(3)${X}`,
  ``,
  `${G}${B}40 pass${X} ${D}· 0 fail · 112 expect() calls · 1.64s${X}`,
];

export function kanbanTurn(): Step[] {
  return [
    bash("bun test src/board", BOARD_TESTS, 9000, 1, "Run the board suite after the persistence change"),
    think(
      "keyboard-move fails only for Shift+J at the end of a lane. The move handler computes the target index before removing the card from its old position, so moving down skips one slot. Fix: remove first, then clamp the insertion index.",
      5200,
    ),
    read("src/features/board/keyboard.ts", 74),
    grep("moveCard\\(", [
      { path: "src/features/board/keyboard.ts", line: 31, text: "moveCard(lanes, key, dir)" },
      { path: "src/features/board/BoardView.tsx", line: 88, text: "onMove={(k, d) => moveCard(lanes, k, d)}" },
      { path: "src/features/board/keyboard-move.test.ts", line: 12, text: "expect(moveCard(l, 'a', 1)).toEqual(…)" },
    ]),
    edit({ path: "src/features/board/keyboard.ts", added: 14, removed: 7, status: "modified" }, "Remove before insert; clamp the index"),
    say("The off-by-one was in `moveCard`: it computed the destination **before** removing the card, so Shift+J skipped a slot at lane ends. Re-running the suite."),
    bash("bun test src/board", BOARD_TESTS_GREEN, 7000, 0),
    todo("Keyboard move (J/K + Shift)", "completed"),
    todo("Card flight animation", "inProgress"),
    think("Card flights: give every card a stable layoutId derived from the agent key, and wrap lanes in one LayoutGroup so a column change animates across lanes.", 3200),
    edit({ path: "src/features/board/AgentCard.tsx", added: 62, removed: 8, status: "modified" }, "Shared-layout card flights"),
    edit({ path: "src/features/board/BoardView.tsx", added: 9, removed: 3, status: "modified" }),
    bash("bun run typecheck", [`${G}❯${X} bun run typecheck`, `$ tsc -b --noEmit`, `${D}Done in 4.1s${X}`], 4500),
    todo("Card flight animation", "completed"),
    todo("a11y announcements", "inProgress"),
    edit({ path: "src/features/board/announce.ts", added: 38, removed: 0, status: "added" }, "Live-region announcements for moves"),
    todo("a11y announcements", "completed"),
    todo("Reduced-motion fallbacks", "inProgress"),
    edit({ path: "src/features/board/Lane.tsx", added: 11, removed: 2, status: "modified" }),
    todo("Reduced-motion fallbacks", "completed"),
    bash("bun test src/board", BOARD_TESTS_GREEN, 6000, 0),
    say(
      "Board is done: keyboard moves, card flights and a11y announcements, with all 40 tests green.\n\n| Area | Change |\n|---|---|\n| Keyboard | `moveCard` removes before inserting; Shift+J/K clamp at lane ends |\n| Motion | Cards share `layoutId`s, so lane changes fly instead of jumping |\n| a11y | Moves are announced in a polite live region |\n| Reduced motion | Flights become cross-fades |\n\nTypecheck is clean.",
    ),
  ];
}

export function poolTurn(): Step[] {
  return [
    {
      t: "tool",
      spec: {
        tool: "task",
        title: "3 subagents exploring query hot paths",
        intent: "Parallel investigation of where connections churn",
        args: { tasks: 3 },
        ms: 34_000,
        subagents: [
          { name: "QueryScout", description: "Rank handlers by connection opens per request", ms: 26_000, model: "sonnet-5", lines: ["reading internal/http/router.go", "tracing db.Open call sites", "12 handlers open a fresh conn", "ranking by p99 contribution"] },
          { name: "PoolBench", description: "Benchmark pgxpool sizes 8/16/32 against staging replica", ms: 33_000, model: "sonnet-5", lines: ["go test -bench Pool -benchtime 10s", "size=8 p99 41ms", "size=16 p99 18ms", "size=32 p99 17ms (diminishing)"] },
          { name: "LockAudit", description: "Check for session-level state that breaks pooling", ms: 21_000, model: "luna", lines: ["grep SET LOCAL / advisory locks", "2 handlers use SET search_path", "both can switch to schema-qualified names"] },
        ],
      },
    },
    think("16 connections gives most of the win. Search and tenants dominate opens; billing uses advisory locks so it should move last.", 3800),
    say("Findings: **12 handlers** open a fresh connection per request. A pool of **16** cuts p99 from 41 ms to 18 ms on the staging replica; 32 barely helps. Two handlers rely on `SET search_path`, which I can make schema-qualified."),
    {
      t: "ui",
      ui: {
        kind: "multiSelect",
        needs: "ask",
        title: "Question",
        message: "Which endpoints should move to the pool in this PR?",
        options: [
          opt("/v1/search", { recommended: true, description: "Hottest path: 61% of connection opens", tone: "primary" }),
          opt("/v1/tenants", { recommended: true, description: "22% of opens, no session state" }),
          opt("/v1/events", { description: "Streaming endpoint; holds conns longer" }),
          opt("/v1/billing", { description: "Uses advisory locks; needs care" }),
        ],
        allowOther: true,
        allowChat: true,
        tool: { tool: "ask", title: "Which endpoints first?", args: {}, ms: 0 },
      },
      then: (a) => [
        say(a.chat ? "Sure, let's talk it through. My default would be search + tenants first." : `Moving ${a.choices.length ? a.choices.map((c) => `\`${c}\``).join(", ") : "the hot paths"} to the pool.`),
        todo("Map query hot paths", "completed"),
        todo("pgxpool client with health checks", "inProgress"),
        edit({ path: "internal/db/pool.go", added: 48, removed: 12, status: "modified" }, "Health-checked pgxpool with 16 conns"),
        todo("pgxpool client with health checks", "completed"),
        todo("Wire pool into handlers", "inProgress"),
        edit({ path: "internal/http/router.go", added: 22, removed: 31, status: "modified" }),
        bash("go test ./internal/db/... ./internal/http/...", [`ok  \tgateway/internal/db\t2.114s`, `ok  \tgateway/internal/http\t3.870s`], 8000),
        todo("Wire pool into handlers", "completed"),
        todo("Load test p99", "inProgress"),
        bash(
          "hey -z 30s -c 64 http://127.0.0.1:8080/v1/search?q=flock",
          [`Summary:`, `  Total:\t30.0021 secs`, `  Requests/sec:\t4182.3`, ``, `Latency distribution:`, `  50% in 0.0061 secs`, `  90% in 0.0119 secs`, `  99% in 0.0176 secs`, ``, `Status code distribution:`, `  [200]\t125471 responses`],
          31_000,
          0,
          "Load test against the local gateway (dev server on :8080)",
        ),
        todo("Load test p99", "completed"),
        todo("Docs", "completed"),
        say("p99 is now **17.6 ms** (was 41 ms) at 4.2k req/s. The pool is health-checked every 30 s and exposes `db_pool_*` metrics. Ready for review; preview the dev server at http://localhost:8080/debug/pool."),
      ],
    },
  ];
}

export function ciTurn(): Step[] {
  return [
    {
      t: "tool",
      spec: {
        tool: "bash",
        title: "gh run watch 9127 --exit-status",
        intent: "Wait for the warm CI run",
        args: { command: "gh run watch 9127 --exit-status" },
        ms: 128_000,
        silent: true,
        output: [
          `${G}✓${X} ci/bun-cache CI · 9127`,
          `Triggered via push about 2 minutes ago`,
          ``,
          `${B}JOBS${X}`,
          `${G}✓${X} build in 1m48s (ID 51122)`,
          `  ${G}✓${X} Restore bun cache ${D}(hit: 412 MB)${X}`,
          `  ${G}✓${X} Restore turbo cache ${D}(89/91 tasks cached)${X}`,
          `  ${G}✓${X} bun install --frozen-lockfile ${D}0.9s${X}`,
          `  ${G}✓${X} turbo run build test ${D}41s${X}`,
        ],
        view: { type: "bash", command: "gh run watch 9127 --exit-status", output: "", exitCode: 0, background: false, timedOut: false },
        exitCode: 0,
      },
    },
    say("Warm run finished in **1m48s** (was 6m12s): bun cache hit 412 MB, 89/91 turbo tasks cached."),
    todo("Verify a warm run", "completed"),
    {
      t: "ui",
      ui: {
        kind: "confirm",
        needs: "confirm",
        title: "Open a draft PR?",
        message: "Push ci/bun-cache and open a draft PR against main?",
        options: [opt("Yes", { tone: "primary", recommended: true }), opt("No")],
      },
      then: (a) =>
        a.choices.includes("Yes")
          ? [
              bash("git push -u origin ci/bun-cache", [`To github.com:demo/infra.git`, ` * [new branch]      ci/bun-cache -> ci/bun-cache`, `branch 'ci/bun-cache' set up to track 'origin/ci/bun-cache'.`], 3000),
              {
                t: "tool",
                spec: {
                  tool: "github",
                  title: "gh pr create --draft",
                  args: { draft: true },
                  ms: 2500,
                  view: { type: "markdown", text: "**#64 · Cache bun install + turbo artifacts in CI** (draft)\n\nCuts warm CI from 6m12s to 1m48s.\n\nhttps://github.com/demo/infra/pull/64" },
                },
              },
              say("Opened draft PR **#64**."),
            ]
          : [say("OK, leaving the branch local. It's ready whenever you want to push.")],
    },
  ];
}

export const PUSH_ASK: UiSpec = {
  kind: "select",
  needs: "ask",
  title: "Question",
  message: "How should notifications reach your phone?",
  options: [
    opt("ntfy on your tailnet", { recommended: true, tone: "primary", description: "Self-hosted on forge. No Google account, and it never leaves Tailscale." }),
    opt("Firebase Cloud Messaging", { description: "Best battery life, but needs a Google project and a public push path." }),
    opt("UnifiedPush", { description: "Pick a distributor per device. More moving parts." }),
  ],
  allowOther: true,
  allowChat: true,
  tool: { tool: "ask", title: "How should notifications reach your phone?", args: {}, ms: 0 },
};

export function pushAfter(a: Answer): Step[] {
  if (a.cancel) return [{ t: "notice", level: "warn", text: "Question dismissed" }, say("No problem: I'll stop here. The watcher and tests are in; the delivery transport is still open.")];
  if (a.chat) return [say("Happy to talk it through. The short version: ntfy keeps everything on your tailnet, FCM is the most battery-friendly but needs Google, UnifiedPush is flexible but more setup. What matters most to you?")];
  const choice = a.text ?? a.choices[0] ?? "ntfy on your tailnet";
  const fcm = choice.startsWith("Firebase");
  return [
    say(`Going with **${choice}**.`),
    todo("Pick a delivery transport", "completed"),
    todo("Notification actions: Answer, Open terminal", "inProgress"),
    edit({ path: "android/app/src/main/java/dev/teleflock/notify/NotifyModule.kt", added: fcm ? 64 : 41, removed: 6, status: "modified" }, fcm ? "FCM messaging service" : "ntfy subscription over the tailnet"),
    edit({ path: "android/app/build.gradle.kts", added: fcm ? 4 : 2, removed: 0, status: "modified" }),
    bash(
      "./gradlew :app:testDebugUnitTest",
      [`> Task :app:compileDebugKotlin`, `> Task :app:testDebugUnitTest`, ``, `AgentStateWatcherTest > emits on blocked ${G}PASSED${X}`, `AgentStateWatcherTest > ignores working→idle flaps ${G}PASSED${X}`, `NotifyModuleTest > action buttons ≤ 3 ${G}PASSED${X}`, ``, `${G}BUILD SUCCESSFUL${X} in 21s`, `37 tests completed, 0 failed`],
      14_000,
    ),
    todo("Notification actions: Answer, Open terminal", "completed"),
    todo("Deep-link into the agent session", "inProgress"),
    edit({ path: "android/app/src/main/java/dev/teleflock/notify/DeepLink.kt", added: 27, removed: 0, status: "added" }),
    todo("Deep-link into the agent session", "completed"),
    say(`Push is wired end to end via ${choice}: blocked agents raise a notification with **Answer** and **Open terminal** actions, and tapping it deep-links into the session. 37/37 tests pass.`),
  ];
}

export const LIMITS_APPROVAL: UiSpec = {
  kind: "select",
  needs: "approval",
  title: "Allow bash?",
  message: "Allow tool: bash\n\nbun run db:migrate --env staging",
  command: "bun run db:migrate --env staging",
  options: [
    opt("Allow once", { tone: "primary", recommended: true }),
    opt("Allow for session"),
    opt("Deny", { tone: "danger" }),
  ],
  tool: {
    tool: "bash",
    title: "bun run db:migrate --env staging",
    intent: "Apply the rate-limit table on staging",
    args: { command: "bun run db:migrate --env staging" },
    ms: 0,
  },
};

export function limitsAfter(a: Answer): Step[] {
  const allowed = !a.cancel && a.choices.some((c) => c.startsWith("Allow"));
  if (!allowed) {
    return [
      { t: "notice", level: "warn", text: "Tool call denied: bun run db:migrate --env staging" },
      say("Understood, I won't touch staging. I generated `migrations/0042_rate_limits.sql` so you can apply it yourself; everything else is tested locally."),
      todo("Run staging migration", "abandoned"),
    ];
  }
  return [
    bash(
      "bun run db:migrate --env staging",
      [`$ drizzle-kit migrate --config staging.config.ts`, `Reading migrations from ./migrations`, `Applying 0042_rate_limits.sql … ${G}done${X} ${D}(212ms)${X}`, `${G}✓${X} 1 migration applied`],
      6000,
    ),
    todo("Run staging migration", "completed"),
    todo("Load test", "inProgress"),
    bash(
      "k6 run load/rate-limits.js --vus 200 --duration 45s",
      [`running (0m45.0s), 000/200 VUs, 18342 complete iterations`, `✓ status is 200 or 429`, `✓ 429 only after quota`, `http_req_duration..: avg=9.1ms p(95)=21.4ms`, `rate_limited.......: 31.22% ✓ 5727`],
      45_000,
    ),
    todo("Load test", "completed"),
    say("Rate limits are live on staging: tenants get a **sliding 60 s window**, over-quota requests return `429` with `Retry-After`, and p95 stays at 21 ms under 200 VUs."),
  ];
}

// ------------------------------------------------------------------ follow-ups & generic turns

const PLAN = `# Plan: offline snapshot cache

1. **Cache** the last \`HostState\` per host in \`data_dir/cache/<host>.json\` on every snapshot (debounced 2 s).
2. **Boot** from cache: emit it as a stale snapshot before the live link is up.
3. **UI**: desaturate stale cards and shimmer while reconnecting; show "last seen".
4. **Tests**: cache round-trip, stale→live transition, corrupt cache ignored.

Risks: cache size with large boards (cap 2 MB), clock skew in "last seen".`;

/** Questions the director injects so the Needs-you lane keeps cycling through every dialog kind. */
export function injectedAsk(kind: number, agentName: string): Step {
  switch (kind % 5) {
    case 0:
      return {
        t: "ui",
        ui: {
          kind: "planReview",
          needs: "planReview",
          title: "Review plan",
          message: "Approve the plan to start implementing.",
          plan: { title: "Offline snapshot cache", content: PLAN, path: `.omp/plans/${agentName}.md` },
          options: [opt("Approve", { tone: "primary", recommended: true }), opt("Approve and compact"), opt("Refine")],
          allowOther: true,
        },
        then: (a) =>
          a.choices.includes("Refine") || a.text
            ? [say(`Updating the plan${a.text ? `: ${a.text}` : ""}.`), think("Folding the feedback into the plan.", 2500), say("Plan updated; proceeding with step 1.")]
            : [{ t: "mode", text: "Plan approved · implementing" }, edit({ path: "crates/tf-client/src/cache.rs", added: 72, removed: 0, status: "added" }), say("Step 1 done: snapshots are cached per host.")],
      };
    case 1:
      return {
        t: "ui",
        ui: {
          kind: "editor",
          needs: "input",
          title: "Commit message",
          message: "Edit the commit message, then submit.",
          initial: `${agentName}: tighten edge cases\n\n- clamp indices at lane ends\n- cover reconnect mid-stream`,
          options: [],
        },
        then: (a) => [
          bash(`git commit -am "${(a.text ?? "update").split("\n")[0]}"`, [`[${agentName} ${"3fa9c1e"}] ${(a.text ?? "update").split("\n")[0]}`, ` 3 files changed, 41 insertions(+), 9 deletions(-)`], 2000),
          say("Committed."),
        ],
      };
    case 2:
      return {
        t: "ui",
        ui: {
          kind: "select",
          needs: "approval",
          title: "Allow bash?",
          message: "Allow tool: bash\n\nrm -rf node_modules/.cache && bun install",
          command: "rm -rf node_modules/.cache && bun install",
          options: [opt("Allow once", { tone: "primary", recommended: true }), opt("Allow for session"), opt("Deny", { tone: "danger" })],
          tool: { tool: "bash", title: "rm -rf node_modules/.cache && bun install", args: { command: "rm -rf node_modules/.cache && bun install" }, ms: 0 },
        },
        then: (a) =>
          a.choices.some((c) => c.startsWith("Allow"))
            ? [bash("rm -rf node_modules/.cache && bun install", [`bun install v1.4.3`, ``, `${G}+${X} 412 packages installed ${D}[2.31s]${X}`], 4000)]
            : [{ t: "notice", level: "warn", text: "Tool call denied" }, say("Skipping the reinstall.")],
      };
    case 3:
      return {
        t: "ui",
        ui: {
          kind: "select",
          needs: "ask",
          title: "Question",
          message: "Two tests are flaky on CI only. How should I handle them?",
          options: [
            opt("Fix the race", { recommended: true, tone: "primary", description: "Await the debounce flush instead of sleeping" }),
            opt("Quarantine for now", { description: "Mark .skip with a tracking issue" }),
            opt("Increase timeouts", { description: "Quick, but hides the bug" }),
          ],
          allowOther: true,
          allowChat: true,
          tool: { tool: "ask", title: "Flaky tests: fix or quarantine?", args: {}, ms: 0 },
        },
        then: (a) => [say(`Going with **${a.text ?? a.choices[0] ?? "Fix the race"}**.`), edit({ path: "src/features/board/persist.test.ts", added: 9, removed: 6, status: "modified" })],
      };
    default:
      return {
        t: "ui",
        ui: {
          kind: "confirm",
          needs: "confirm",
          title: "Continue?",
          message: "This will rewrite 14 snapshot files. Continue?",
          options: [opt("Yes", { tone: "primary", recommended: true }), opt("No")],
        },
        then: (a) => (a.choices.includes("Yes") ? [bash("bun test -u", [`${G}14 snapshots updated${X}`], 3000)] : [say("Left the snapshots alone.")]),
      };
  }
}

/** "Write a commit message": inspect the diff, answer with one ```text block, no dialogs. */
function commitMessageTurn(ctx: { repo: string; title?: string; branch?: string; changed?: ChangedFile[] }): Step[] {
  const changed = ctx.changed ?? [];
  const kind = ctx.branch?.startsWith("fix/") ? "fix" : ctx.branch?.startsWith("ci/") ? "ci" : ctx.branch?.startsWith("perf/") ? "perf" : ctx.branch?.startsWith("docs") ? "docs" : "feat";
  const scope = (ctx.branch?.split("/").pop() ?? ctx.repo).split("-")[0] ?? ctx.repo;
  const title = (ctx.title ?? "update").replace(/\.$/, "");
  const subject = `${kind}(${scope}): ${title.charAt(0).toLowerCase()}${title.slice(1)}`.slice(0, 72);
  const bullets = changed.length
    ? changed.slice(0, 6).map((f) => `- ${f.status === "added" || f.status === "untracked" ? "add" : f.status === "deleted" ? "remove" : f.status === "renamed" ? "rename" : "update"} ${f.path} (+${f.added} −${f.removed})`)
    : ["- no functional changes"];
  if (changed.length > 6) bullets.push(`- plus ${changed.length - 6} more file${changed.length - 6 > 1 ? "s" : ""}`);
  const files = changed.length;
  return [
    bash("git diff --stat HEAD", [...changed.slice(0, 8).map((f) => ` ${f.path} | ${f.added + f.removed} ${"+".repeat(Math.min(20, Math.ceil(f.added / 20)))}${"-".repeat(Math.min(10, Math.ceil(f.removed / 20)))}`), ` ${files} file${files === 1 ? "" : "s"} changed`], 1200),
    think("Summarising the diff into a conventional commit: type and scope from the branch, subject from the task, one bullet per notable file.", 2200),
    say(`Here's a commit message for the current changes:\n\n\`\`\`text\n${subject}\n\n${bullets.join("\n")}\n\`\`\``),
  ];
}

/** A scripted reply to a user prompt: keyword-aware, always streams and uses a few tools. */
export function replyTurn(
  text: string,
  ctx: { repo: string; files: string[]; rng: Rng; plan: boolean; title?: string; branch?: string; changed?: ChangedFile[] },
): Step[] {
  const t = text.toLowerCase();
  const file = ctx.rng.pick(ctx.files.length ? ctx.files : ["README.md"]);
  if (/commit message/i.test(text)) return commitMessageTurn(ctx);
  if (ctx.plan) return [think("Drafting a plan before touching code.", 3000), say("Here's how I'd approach it."), injectedAsk(0, ctx.repo)];
  if (/\b(why|what|how|explain)\b|\?$/.test(t)) {
    return [
      think("Looking at the relevant code before answering.", 2600),
      read(file, 120),
      say(
        `Short answer: it's driven by \`${file.split("/").pop()}\`.\n\n- State flows one way: herdr events → hostd → patch → store.\n- Liveness is derived, never stored.\n- The UI only subscribes to the rows it renders.\n\nWant me to add a diagram to the docs?`,
      ),
    ];
  }
  if (/\btest|ci|flaky\b/.test(t)) {
    return [
      bash("bun test", [`bun test v1.4.3`, ``, `${G}✓${X} 212 pass`, `${R}✗${X} 1 fail ${D}(persist.test.ts › survives reload)${X}`], 9000, 1),
      think("The failure is timing-related: the test reads storage before the debounced write lands.", 3000),
      edit({ path: "src/features/board/persist.test.ts", added: 6, removed: 2, status: "modified" }),
      bash("bun test", [`bun test v1.4.3`, ``, `${G}✓${X} 213 pass`, `${D}0 fail · 1.9s${X}`], 7000),
      say("Fixed: the test now awaits the debounced flush. **213/213** pass. Pushing and waiting for CI."),
      bash("git push", [`To github.com:demo/${ctx.repo}.git`, `   4be91a7..c03d9e2  HEAD -> HEAD`], 2500),
      {
        t: "tool",
        spec: {
          tool: "bash",
          title: "gh run watch --exit-status",
          intent: "Wait for CI (no output until it finishes)",
          args: { command: "gh run watch --exit-status" },
          ms: 105_000,
          silent: true,
          output: [`${G}✓${X} CI · build, test, lint`, `${D}completed in 1m44s${X}`],
          view: { type: "bash", command: "gh run watch --exit-status", output: "", exitCode: 0, background: false, timedOut: false },
          exitCode: 0,
        },
      },
      say("CI is green."),
    ];
  }
  if (/\bcommit|pr\b|pull request|ship/.test(t)) {
    return [
      bash("git status --short", [` M ${file}`, `?? docs/notes.md`], 900),
      injectedAsk(1, ctx.repo),
    ];
  }
  if (/\bsearch|research|docs?|look up\b/.test(t)) {
    return [
      {
        t: "tool",
        spec: {
          tool: "web_search",
          title: text.slice(0, 60),
          args: { query: text },
          ms: 4200,
          view: {
            type: "web",
            query: text.slice(0, 80),
            answer: "Both approaches work; the pooled client is the common recommendation for request/response services.",
            sources: [
              { title: "pgxpool package docs", url: "https://pkg.go.dev/github.com/jackc/pgx/v5/pgxpool", snippet: "Pool is a connection pool for pgx…" },
              { title: "Tailscale SSH check mode", url: "https://tailscale.com/kb/1193/tailscale-ssh", snippet: "Check mode requires re-authentication…" },
            ],
          },
        },
      },
      say("Summarised the two most relevant sources above. The pooled approach is what I'd pick."),
    ];
  }
  const rng = ctx.rng;
  return [
    think(`Plan: inspect ${file}, make the change, run the tests.`, 2800 + rng.int(0, 2000)),
    read(file, rng.int(40, 220)),
    edit({ path: file, added: rng.int(4, 40), removed: rng.int(0, 12), status: "modified" }, text.slice(0, 60)),
    bash("bun test --bail", [`bun test v1.4.3`, ``, `${G}✓${X} ${rng.int(30, 220)} pass`, `${D}0 fail · ${rng.int(1, 4)}.${rng.int(0, 9)}s${X}`], 6000 + rng.int(0, 4000)),
    say(`Done: updated \`${file}\` for "${text.length > 70 ? `${text.slice(0, 70)}…` : text}". Tests pass.`),
  ];
}

/** studio-pc: a long render job with progress output. */
export function renderTurn(): Step[] {
  const frames = Array.from({ length: 12 }, (_, i) => `Fra:${(i + 1) * 120} Mem:2.1G | Time:00:${String(8 + i * 3).padStart(2, "0")}.4 | Remaining:${String(Math.max(0, 33 - i * 3)).padStart(2, "0")}s | Rendering ${Math.round(((i + 1) / 12) * 100)}%`);
  return [
    bash("blender -b onboarding.blend -E CYCLES -a", frames, 60_000, 0, "Render frames 1–1440 at 4K"),
    bash("ffmpeg -framerate 60 -i out/%04d.png -c:v libx265 -crf 20 onboarding.mp4", [`frame= 1440 fps=212 q=-0.0 Lsize=   38412kB time=00:00:24.00 bitrate=13110.9kbits/s`, `${G}done${X}`], 12_000),
    say("Rendered all 1440 frames at 4K and encoded `onboarding.mp4` (24 s, 38 MB)."),
  ];
}

/** Prompts another device "sends" so idle agents pick up work again. */
export const DIRECTOR_PROMPTS: string[] = [
  "Can you add tests for the edge cases you mentioned?",
  "Rebase on main and make sure CI is green",
  "Search the docs for how other clients handle reconnect backoff",
  "Why does the lane order reset after a reconnect?",
  "Polish the empty states and run the tests",
  "Commit this and get it ready for a PR",
];

/** Fixed subagent rows for task views, with live progress. */
export function subagentRow(spec: SubagentSpec, id: string, startedAt: number, now: number): Subagent {
  const p = Math.min(1, (now - startedAt) / spec.ms);
  const done = p >= 1;
  const lineIdx = Math.min(spec.lines.length - 1, Math.floor(p * spec.lines.length));
  return {
    id,
    name: spec.name,
    description: spec.description,
    status: done ? "done" : "running",
    startedAt,
    endedAt: done ? startedAt + spec.ms : undefined,
    model: spec.model,
    line: spec.lines[lineIdx],
    progress: Math.round(p * 100) / 100,
    toolCount: Math.floor(p * 14) + 1,
    tokens: Math.floor(p * 38_000),
    costUsd: Math.round(p * 0.42 * 100) / 100,
  };
}
