import { describe, expect, test } from "bun:test";
import type { ApiError } from "@/core/gen";
import { PR_TTL, ghUnavailable, isShipped, prFromError, prFromResult, shippedWords } from "./worktreePr";

const NOW = 1_800_000_000_000;
const pr = (state: string, number = 91) => ({ pr: { number, url: `https://github.com/demo/x/pull/${number}`, title: "t", state, draft: false } });
const err = (code: string, message: string, extra: Partial<ApiError> = {}): ApiError => ({ code, message, retryable: false, ...extra });

describe("worktree PR answers", () => {
  test("merged and closed are shipped and hold longest; open and none are asked again sooner", () => {
    const merged = prFromResult(pr("MERGED"), NOW);
    expect(isShipped(merged)).toBe(true);
    expect(merged).toEqual({ state: "MERGED", number: 91, until: NOW + PR_TTL.shipped });
    expect(isShipped(prFromResult(pr("CLOSED"), NOW))).toBe(true);
    const open = prFromResult(pr("OPEN"), NOW);
    expect(isShipped(open)).toBe(false);
    expect(open.until).toBe(NOW + PR_TTL.open);
    expect(prFromResult({}, NOW)).toEqual({ state: null, until: NOW + PR_TTL.none });
    expect(PR_TTL.open).toBeLessThan(PR_TTL.none);
    expect(PR_TTL.none).toBeLessThan(PR_TTL.shipped);
  });

  test("gh missing, signed out or an older host quiets the host; other gh failures don't", () => {
    expect(ghUnavailable(err("gh_error", "the GitHub CLI (gh) is not installed on this host", { hint: "Install it from https://cli.github.com and run `gh auth login` on the host." }))).toBe(true);
    expect(ghUnavailable(err("gh_error", "To get started with GitHub CLI, please run:  gh auth login", { hint: "gh is not authenticated on this host. Run `gh auth login` there (or set GH_TOKEN for the daemon)." }))).toBe(true);
    expect(ghUnavailable(err("unknown_method", "unknown method gh.prStatus"))).toBe(true);
    expect(ghUnavailable(err("gh_error", "none of the git remotes configured for this repository point to a known GitHub host", { hint: "This repository has no GitHub remote." }))).toBe(false);
    expect(ghUnavailable(err("timeout", "gh pr timed out", { retryable: true }))).toBe(false);
  });

  test("transient failures keep what was known and retry soon; others hide the button for a while", () => {
    const known = prFromResult(pr("MERGED"), NOW - 60_000);
    expect(prFromError(err("timeout", "gh pr timed out", { retryable: true }), known, NOW)).toEqual({ state: "MERGED", number: 91, until: NOW + PR_TTL.retry });
    expect(prFromError(err("not_connected", "host offline"), undefined, NOW)).toEqual({ state: null, number: undefined, until: NOW + PR_TTL.retry });
    const noRemote = prFromError(err("gh_error", "no git remotes"), known, NOW);
    expect(isShipped(noRemote)).toBe(false);
    expect(noRemote.until).toBe(NOW + PR_TTL.never);
  });

  test("shipped wording", () => {
    expect(shippedWords({ state: "MERGED", number: 91 })).toBe("PR #91 is merged");
    expect(shippedWords({ state: "CLOSED" })).toBe("Its pull request was closed");
  });
});
