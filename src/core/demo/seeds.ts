import type { AgentDef } from "./data";
import { bash, edit, grep, read, say, type Step, think, todo } from "./scripts";

const G = "\x1b[32m";
const D = "\x1b[2m";
const X = "\x1b[0m";

const FIRST_PROMPTS: Record<string, string> = {
  kanban: "Build the drag-and-drop kanban board: four lanes, persist column order per host, J/K keyboard moves. Use dnd-kit.",
  pool: "Our gateway opens a Postgres connection per request and p99 is awful under load. Replace it with a pooled client and prove the win.",
  ci: "CI takes 6+ minutes on every push. Cache bun install and turbo artifacts properly.",
  push: "Add push notifications to the Android app so I get pinged the moment an agent goes blocked. Tailnet only, no public endpoints.",
  limits: "Add per-tenant rate limits with a sliding window. Config per tenant in Postgres, 429 with Retry-After.",
  reconnect: "SSH drops when my phone switches networks and herdr attach doesn't come back. Make reconnect automatic and resume the attach.",
  hero: "Redesign the marketing hero: an animated flock illustration in the omp gradient. Keep Lighthouse above 95.",
  docs: "Write the README and an architecture overview for new contributors.",
  flaky: "auth token refresh test fails ~1 in 20 runs on CI. Find out why and fix it.",
  deps: "Bump tailscale and herdr in the Ansible roles to the latest stable versions.",
  render: "Batch-render the onboarding video frames at 4K.",
  assets: "Compress the app store screenshots without visible quality loss.",
};

const HERO_SHOT = btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#0e7490"/></linearGradient><linearGradient id="o" x1="0" x2="1"><stop offset="0" stop-color="#f053d0"/><stop offset=".5" stop-color="#a15eef"/><stop offset="1" stop-color="#7fa2e7"/></linearGradient></defs><rect width="480" height="270" fill="url(#g)"/><rect x="36" y="70" width="190" height="20" rx="10" fill="#fff" opacity=".92"/><rect x="36" y="102" width="240" height="10" rx="5" fill="#fff" opacity=".4"/><rect x="36" y="150" width="96" height="30" rx="15" fill="url(#o)"/><g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"><path d="M300 70l12 10 12-10"/><path d="M340 50l10 8 10-8"/><path d="M332 110l14 12 14-12"/><path d="M384 86l10 8 10-8"/><path d="M412 120l12 10 12-10"/><path d="M372 150l8 6 8-6"/></g></svg>`,
);

/** Transcript history (instant) for each seeded agent. Ends where the live turn picks up. */
export function historyFor(def: AgentDef): Step[] {
  const prompt = FIRST_PROMPTS[def.id] ?? def.title;
  const steps: Step[] = [{ t: "user", text: prompt }];
  const files = def.files ?? [];
  steps.push(think(`Let me look at how the ${def.title.toLowerCase()} fits the existing code before changing anything.`, 6000 + (def.age % 7) * 1000));
  const firstFile = files[0]?.path ?? "README.md";
  steps.push(read(firstFile, 140));
  if (def.id === "pool") {
    // A long exploration so `session.history` paging has something to page.
    for (let i = 0; i < 70; i++) {
      const f = ["internal/http/router.go", "internal/db/pool.go", "internal/http/middleware.go", "cmd/gateway/main.go"][i % 4] as string;
      steps.push(i % 3 === 0 ? grep(`db\\.Open|QueryRow`, [{ path: f, line: 20 + i, text: "conn, err := db.Open(ctx, cfg.DSN)" }]) : read(f, 60 + i));
      if (i % 10 === 9) steps.push(say(`Checked ${i + 1} call sites so far; most open a connection per request.`));
    }
    steps.push({ t: "mode", text: "Model switched to gpt-5.5 · xhigh" });
    steps.push({ t: "notice", level: "warn", text: "Context is 61% full — consider /compact before the next large read" });
  }
  if (def.todos?.length) {
    steps.push({
      t: "tool",
      spec: {
        tool: "todo_write",
        title: `${def.todos.reduce((n, p) => n + p.tasks.length, 0)} tasks in ${def.todos.length} phase${def.todos.length > 1 ? "s" : ""}`,
        args: {},
        ms: 300,
        view: { type: "todo", phases: def.todos },
      },
    });
  }
  for (const f of files) steps.push(edit(f));
  switch (def.id) {
    case "push":
      steps.push(
        grep("NotificationCompat|AgentState", [
          { path: "android/app/src/main/java/dev/teleflock/notify/AgentStateWatcher.kt", line: 12, text: "class AgentStateWatcher(private val herdr: HerdrClient)" },
          { path: "android/app/src/main/java/dev/teleflock/MainActivity.kt", line: 41, text: "NotificationCompat.Builder(this, CHANNEL_AGENTS)" },
        ]),
        {
          t: "tool",
          spec: {
            tool: "task",
            title: "2 subagents",
            args: {},
            ms: 41_000,
            subagents: [
              { name: "FcmScout", description: "Map FCM setup cost for a tailnet-only app", ms: 41_000, lines: ["done"] },
              { name: "NtfyScout", description: "Evaluate self-hosted ntfy on forge", ms: 37_000, lines: ["done"] },
            ],
          },
        },
        bash("./gradlew :app:testDebugUnitTest", [`> Task :app:testDebugUnitTest`, `AgentStateWatcherTest > ignores working→idle flaps ${G}PASSED${X}`, `AgentStateWatcherTest > survives reconnect mid-stream ${G}PASSED${X}`, `${G}BUILD SUCCESSFUL${X} in 18s`, `34 tests completed, 0 failed`], 18_200),
        say("The watcher is in and tested (34/34). Delivery is the open decision. Both options work; they trade setup effort against independence from Google."),
      );
      break;
    case "limits":
      steps.push(
        bash("go test ./internal/ratelimit/...", [`ok  \tgateway/internal/ratelimit\t1.932s`], 4000),
        say("The sliding window and the middleware are done and tested. Next I need to apply the tenant config migration on staging."),
      );
      break;
    case "reconnect":
      steps.push(
        bash("cargo test -p tf-transport", [`running 48 tests`, `${D}…${X}`, `test result: ${G}ok${X}. 48 passed; 0 failed; 0 ignored`], 21_000),
        {
          t: "tool",
          spec: {
            tool: "github",
            title: "gh pr create --draft",
            args: {},
            ms: 2600,
            view: { type: "markdown", text: "**#142 · Auto-reconnect SSH and resume herdr attach** (draft)\n\nBackoff 1→30 s with jitter, resume on network change, replay missed state.\n\nhttps://github.com/demo/teleflock/pull/142" },
          },
        },
        say("✓ 48 tests passed · PR #142 (draft). Reconnect survives network switches and resumes the herdr attach without losing state."),
      );
      break;
    case "hero":
      steps.push(
        bash("bunx lighthouse http://localhost:4321 --only-categories=performance --quiet", [`Performance: ${G}98${X}`, `LCP 0.9 s · CLS 0 · TBT 10 ms`], 24_000),
        {
          t: "tool",
          spec: {
            tool: "browser",
            title: "screenshot http://localhost:4321",
            args: { url: "http://localhost:4321" },
            ms: 3200,
            view: { type: "image", image: { mime: "image/svg+xml", data: HERO_SHOT, width: 480, height: 270 }, alt: "New hero with the animated flock", url: "http://localhost:4321" },
          },
        },
        say("✓ Lighthouse 98 · preview screenshot above. The flock drifts on a 14 s loop and falls back to a static pose with reduced motion. Preview it at http://localhost:4321."),
      );
      break;
    case "docs":
      steps.push(
        { t: "tool", spec: { tool: "write", title: "docs/architecture.md", args: {}, ms: 900, files: [{ path: "docs/architecture.md", added: 214, removed: 0, status: "added" }] } },
        say("README and architecture overview are merged in #139."),
      );
      break;
    case "flaky":
      steps.push(say("The refresh test raced a 50 ms timer against the mock clock. Switched it to fake timers; 500/500 runs pass. Merged in #87."));
      break;
    case "deps":
      steps.push(
        bash("ansible-playbook site.yml --check --diff", [`PLAY RECAP`, `forge : ok=42 changed=2 unreachable=0 failed=0`], 30_000),
        say("Bumped tailscale to 1.92 and herdr to 0.9.0. Dry run is clean. Merged in #61."),
      );
      break;
    case "kanban":
      steps.push(
        {
          t: "tool",
          spec: {
            tool: "lsp",
            title: "diagnostics src/features/board",
            args: { action: "diagnostics", path: "src/features/board" },
            ms: 1300,
            output: ["BoardView.tsx:88:7  warning  'lanes' is possibly undefined", "Lane.tsx:14:3     warning  unused import 'motion'", "0 errors, 2 warnings"],
          },
        },
        say("Lanes, drag and drop, and persistence are in. Running the board suite now."),
      );
      break;
    case "pool":
      steps.push(say("Baseline: p99 41 ms at 4k req/s with a fresh connection per request. Spawning scouts to map the hot paths."));
      break;
    case "ci":
      steps.push(bash("git push", [`To github.com:demo/infra.git`, `   8c1d2e0..4be91a7  ci/bun-cache -> ci/bun-cache`], 2500), say("Pushed. Waiting for the warm CI run to confirm the cache hits."));
      break;
    default:
      steps.push(say(def.line ?? "Done."));
  }
  if (def.id === "pool") steps.splice(3, 0, todo("Profile connection churn under load", "completed"));
  return steps;
}

export { HERO_SHOT };
