import type { PrInfo } from "../gen";
import { bash, edit, read, say, type Step, think } from "./scripts";

/*
 * Make it green / rebase and resolve on the demo host (Review → ship panel). A demo pull request
 * can carry a problem its agent is asked to fix: failing checks (omp's `/green`) or conflicts with
 * its base (the rebase prompt). Once the agent's turn for the fix ends, CI runs again and passes.
 */

/** A demo pull request, with what is wrong with it and when its agent was asked to fix it. */
export type DemoPr = PrInfo & { createdAt: number; problem?: "checks" | "conflicts"; fixAgent?: string; fixAt?: number };

/** Checks take this long on the demo host. */
const CI_MS = 10_000;

/** `/green`: watch the CI runs of HEAD, read the failing job, fix, push, watch again. */
export function greenTurn(): Step[] {
  return [
    think("CI is red on HEAD. Watching the workflow runs for this commit, then reading the failing jobs' logs.", 1800),
    bash("gh run watch --exit-status", ["✓ build in 1m12s", "X lint in 41s", "X test (ubuntu-latest) in 2m03s"], 2600, 1, "Watching CI for HEAD"),
    bash("gh run view --log-failed", ["lint  src/components/Flock.tsx:88:7  'drift' is assigned a value but never used", "test  Hero.test.tsx › reduced motion › renders the static flock: expected 1 frame, got 0"], 1400, 0, "Reading the failing logs"),
    read("src/components/Flock.tsx", 120),
    edit({ path: "src/components/Flock.tsx", added: 6, removed: 4, status: "modified" }, "Use the drift offset; keep one frame under reduced motion"),
    bash("bun test src/components/Hero.test.tsx", ["12 pass", "0 fail"], 1600, 0, "Running the failing test locally"),
    bash("git commit -am 'fix(hero): one static frame under reduced motion' && git push", ["[redesign-hero 4e1b7c2] fix(hero): one static frame under reduced motion", "To github.com:demo/marketing-site.git"], 1500, 0, "Pushing the fix"),
    bash("gh run watch --exit-status", ["✓ build in 1m08s", "✓ lint in 39s", "✓ test (ubuntu-latest) in 1m58s"], 2600, 0, "Watching CI for the new HEAD"),
    say("CI is green on the new HEAD: the lint error and the reduced-motion test are fixed and pushed."),
  ];
}

/** The rebase prompt's turn: fetch, rebase, resolve, test, force-push with lease. */
export function rebaseTurn(onto: string): Step[] {
  return [
    think(`Fetching the base, then rebasing onto ${onto} and resolving the conflicts.`, 1600),
    bash(`git fetch origin && git rebase ${onto}`, ["CONFLICT (content): Merge conflict in crates/tf-transport/src/ssh.rs", "error: could not apply 8d2f1a9... reconnect: resume herdr attach"], 1800, 1, `Rebasing onto ${onto}`),
    read("crates/tf-transport/src/ssh.rs", 140),
    edit({ path: "crates/tf-transport/src/ssh.rs", added: 9, removed: 14, status: "modified" }, "Keep the new keepalive and the reconnect hook"),
    bash("git add -A && GIT_EDITOR=true git rebase --continue", ["Successfully rebased and updated refs/heads/reconnect."], 900, 0, "Continuing the rebase"),
    bash("cargo test -p tf-transport", ["test result: ok. 48 passed; 0 failed"], 2200, 0, "Running the transport tests"),
    bash("git push --force-with-lease", ["+ 3c41d0e...9a7f2b1 reconnect -> reconnect (forced update)"], 1200, 0, "Pushing the rebased branch"),
    say(`Rebased onto ${onto}: the conflict in ssh.rs is resolved (both the keepalive and the reconnect hook stay), tests pass, pushed with --force-with-lease.`),
  ];
}

/** The rebase prompt TeleFlock sends (`features/review/fix.ts` `rebasePrompt`): its target, if it is one. */
export function rebaseTarget(text: string): string | undefined {
  return /rebase this branch onto (\S+?)[ ,(]/i.exec(text)?.[1];
}

/**
 * What `gh pr view` says about a demo pull request at `now`. `fixedAt`: when its agent's turn for
 * the fix ended (after it was asked); CI then runs again from there and passes.
 */
export function demoPrView(pr: DemoPr, now: number, fixedAt: number | undefined): PrInfo {
  const { createdAt, problem, fixAgent: _agent, fixAt: _at, ...rest } = pr;
  const base: PrInfo = { ...rest, baseRef: rest.baseRef ?? "main" };
  if (rest.state !== "OPEN") return base;
  const since = fixedAt ?? createdAt;
  const age = now - since;
  if (age <= CI_MS) {
    const done = Math.floor(age / 1200);
    return { ...base, checks: { passed: done, failed: 0, pending: 9 - done }, mergeable: problem === "conflicts" && fixedAt === undefined ? false : undefined, mergeState: problem === "conflicts" && fixedAt === undefined ? "DIRTY" : "UNKNOWN" };
  }
  if (fixedAt === undefined && problem === "checks") return { ...base, checks: { passed: 7, failed: 2, pending: 0 }, mergeable: true, mergeState: "UNSTABLE" };
  if (fixedAt === undefined && problem === "conflicts") return { ...base, checks: { passed: 9, failed: 0, pending: 0 }, mergeable: false, mergeState: "DIRTY" };
  return { ...base, checks: { passed: 9, failed: 0, pending: 0 }, mergeable: true, mergeState: "CLEAN" };
}
