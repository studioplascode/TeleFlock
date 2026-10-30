import { describe, expect, test } from "bun:test";
import type { AgentEnded, AutoResume } from "@/core/gen";
import { ACTIONS } from "@/features/shell/vocab";
import { findCommand } from "../composer/slash";
import { badgeText, dontToast, endedWords, formatResumeAt, isResumeKey, nothingReason, retryToast, stripWords, ticketActions, ticketTickMs } from "./words";

const UTC = { locale: "en-GB", timeZone: "UTC" };
/** Tue 3 Nov 2026, 01:00 UTC. */
const NOW = Date.UTC(2026, 10, 3, 1, 0);
const H = 3_600_000;
const kind = (k: string) => k as unknown as AutoResume["kind"];

const ticket = (over: Partial<AutoResume> = {}): AutoResume => ({
  status: "waiting",
  kind: "usageLimit",
  reason: "Claude Max 5-hour limit reached",
  provider: "anthropic",
  model: "claude-opus-5",
  resumeAt: NOW + 2 * H,
  basis: "window",
  since: NOW - H / 2,
  attempts: 0,
  root: true,
  subagentIds: [],
  ...over,
});

const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("resume words", () => {
  test("resume times: today, later this week, further out, due", () => {
    expect(formatResumeAt(NOW + 2 * H, NOW, UTC)).toBe("~03:00");
    expect(formatResumeAt(NOW + 26 * H, NOW, UTC)).toBe("~Wed 03:00");
    expect(formatResumeAt(NOW + 240 * H, NOW, UTC)).toBe("~13 Nov, 01:00");
    expect(formatResumeAt(NOW - 1000, NOW, UTC)).toBe("~now");
  });

  test("strip: waiting, backoff, subagents, attempts, checking, resuming, manual, kinds it doesn't know", () => {
    expect(stripWords(ticket({ subagentIds: ["s1"] }), NOW, UTC)).toMatchObject({
      text: "Usage limit · resumes ~03:00 · +1 subagent",
      tone: "wait",
      actions: { resume: "Resume now", cancel: "Don't auto-resume", dismiss: false },
    });
    expect(stripWords(ticket({ kind: "rateLimit", basis: "backoff", resumeAt: NOW + H / 4, attempts: 2 }), NOW, UTC).text).toBe("Rate limit · checks again ~01:15 · tried 2×");
    // A provider that failed (HTTP 529/503/5xx) is no limit: its own words, no usage check.
    expect(stripWords(ticket({ kind: "overloaded", basis: "backoff", resumeAt: NOW + H / 4 }), NOW, UTC).text).toBe("Overloaded · checks again ~01:15");
    expect(stripWords(ticket({ kind: "providerError", status: "checking" }), NOW, UTC).text).toBe("Checking…");
    expect(stripWords(ticket({ root: false, subagentIds: ["a", "b"] }), NOW, UTC).text).toBe("Usage limit · resumes ~03:00 · 2 subagents stopped");
    expect(stripWords(ticket({ status: "checking" }), NOW, UTC)).toMatchObject({ text: "Checking usage…", actions: { dismiss: false } });
    expect(stripWords(ticket({ status: "resuming" }), NOW, UTC)).toMatchObject({ text: "Resuming…", actions: null });
    expect(stripWords(ticket({ status: "manual", reason: "omp exited while waiting", resumeAt: undefined }), NOW, UTC)).toMatchObject({
      text: "Won't resume by itself — omp exited while waiting",
      tone: "manual",
      actions: { resume: "Resume now", cancel: "Dismiss", dismiss: true },
    });
    expect(stripWords(ticket({ kind: kind("quota") }), NOW, UTC).text).toBe("Stopped · resumes ~03:00");
    expect(stripWords(ticket(), NOW, UTC).detail).toEqual(["Claude Max 5-hour limit reached", "anthropic · claude-opus-5", "Stopped 00:30", "Resumes when the account's usage window resets."]);
  });

  test("restart on a live agent (its previous omp ended): a seconds countdown, Continue, Dismiss", () => {
    const restart = ticket({ kind: "restart", reason: "its previous process ended unexpectedly", provider: undefined, model: undefined, basis: undefined, resumeAt: NOW + 42_000 });
    expect(ticketTickMs(restart)).toBe(1000);
    expect(ticketTickMs(ticket())).toBe(60_000);
    expect(stripWords(restart, NOW, UTC)).toMatchObject({ text: "Continuing where it stopped in 0:42", actions: { resume: "Continue now", cancel: "Don't auto-continue", dismiss: false } });
    expect(stripWords({ ...restart, resumeAt: NOW - 1 }, NOW, UTC).text).toBe("Continuing where it stopped…");
    expect(stripWords({ ...restart, status: "manual", reason: "You asked not to continue it by itself", resumeAt: undefined }, NOW, UTC)).toMatchObject({
      text: "Cut off mid-turn · You asked not to continue it by itself",
      actions: { resume: "Continue", cancel: "Dismiss", dismiss: true },
    });
    expect(stripWords({ ...restart, status: "resuming" }, NOW, UTC).text).toBe("Continuing…");
    expect(badgeText({ ...restart, status: "manual" }, NOW, UTC)).toBe("Continue by hand");
    expect(badgeText(restart, NOW, UTC)).toBe("Continuing soon");
  });

  const ENDED: AgentEnded = { at: NOW - 22 * 60_000, cause: "herdrStopped", reason: "herdr stopped", turn: "working", lastAction: "bash: sleep 30; echo done >> /tmp/c.out" };

  test("an ended card's ticket brings it back: countdown, its end in the tooltip, why it waits, Continue / Dismiss", () => {
    const o = { ...UTC, ended: ENDED };
    const back = ticket({ kind: "restart", reason: "herdr stopped", provider: undefined, model: undefined, basis: undefined, resumeAt: NOW + 5_000, since: ENDED.at });
    expect(stripWords(back, NOW, o)).toMatchObject({
      text: "Bringing it back in 0:05",
      detail: ["Ended at 00:38 (herdr stopped)", "It was in bash: sleep 30; echo done >> /tmp/c.out"],
      tone: "wait",
      actions: { resume: "Continue now", cancel: "Don't auto-continue", dismiss: false },
    });
    expect(stripWords({ ...back, resumeAt: NOW }, NOW, o).text).toBe("Bringing it back…");
    expect(stripWords({ ...back, status: "resuming" }, NOW, o)).toMatchObject({ text: "Bringing it back…", actions: null });
    const off: AutoResume = { ...back, status: "manual", reason: "Auto-resume is off on this host", resumeAt: undefined };
    expect(stripWords(off, NOW, o)).toMatchObject({ text: "Ended: herdr stopped · Auto-resume is off on this host", tone: "manual", actions: { resume: "Continue", cancel: "Dismiss", dismiss: true } });
    expect(stripWords({ ...off, reason: "herdr stopped" }, NOW, o).text).toBe("Ended: herdr stopped");
    expect(stripWords({ ...off, reason: "Couldn't continue: omp did not start", attempts: 3 }, NOW, o).text).toBe("Ended: herdr stopped · Couldn't continue: omp did not start · tried 3×");
    // the ended card's one chip: the countdown's state, else when it ended
    expect([badgeText(back, NOW, o), badgeText({ ...back, status: "resuming" }, NOW, o), badgeText(off, NOW, o)]).toEqual(["coming back", "coming back…", "ended 00:38"]);
    expect(ticketActions(back, o)?.cancelHint).toBe("It stays ended until you continue it");
    expect(ticketActions(off, o)?.cancelHint).toContain("Done");
    // limit tickets keep their words, whatever the card
    expect(ticketActions(ticket(), o)).toMatchObject({ resume: "Resume now", resumeHint: ACTIONS.resumeNow.description, cancelHint: ACTIONS.noAutoResume.description });
  });

  test("an ended card without a ticket: when, why, what it was doing; comes back once herdr runs", () => {
    expect(endedWords(ENDED, NOW, { ...UTC, herdrDown: true })).toEqual({
      chip: "ended 00:38",
      text: "Ended at 00:38 (herdr stopped) · comes back when herdr runs again",
      detail: ["It was in bash: sleep 30; echo done >> /tmp/c.out"],
    });
    expect(endedWords(ENDED, NOW, UTC).text).toBe("Ended at 00:38 (herdr stopped)");
    expect(endedWords({ ...ENDED, lastAction: undefined }, NOW, UTC).detail).toEqual(["It was working"]);
    expect(endedWords({ ...ENDED, turn: "replying", lastAction: undefined }, NOW, UTC).detail).toEqual(["It was writing a reply"]);
    expect(endedWords({ ...ENDED, turn: "idle" }, NOW, UTC).detail).toEqual(["It was idle", "Last action: bash: sleep 30; echo done >> /tmp/c.out"]);
    // the night before: with its weekday; a 24-hour clock in every locale, like herdr's own words
    expect(endedWords({ ...ENDED, at: NOW - 3 * H }, NOW, UTC).chip).toBe("ended Mon 22:00");
    expect(endedWords({ ...ENDED, at: NOW + 12 * H }, NOW + 12 * H, { locale: "en-US", timeZone: "UTC" }).chip).toBe("ended 13:00");
  });

  test("Don't: the toast says what stays put", () => {
    expect(dontToast("audit", ticket(), undefined).title).toBe("audit won't resume by itself");
    expect(dontToast("soak", ticket({ kind: "restart" }), ENDED).title).toBe("soak won't come back by itself");
    expect(dontToast("schema", ticket({ kind: "restart" }), undefined).title).toBe("schema won't continue by itself");
  });

  test("board badge", () => {
    expect(badgeText(ticket(), NOW, UTC)).toBe("Limit · ~03:00");
    expect(badgeText(ticket({ resumeAt: NOW + 26 * H }), NOW, UTC)).toBe("Limit · ~Wed 03:00");
    expect(badgeText(ticket({ status: "checking" }), NOW, UTC)).toBe("Limit · checking");
    expect(badgeText(ticket({ status: "resuming" }), NOW, UTC)).toBe("Resuming…");
    expect(badgeText(ticket({ status: "manual" }), NOW, UTC)).toBe("Resume by hand");
    expect(badgeText(ticket({ kind: "overloaded" }), NOW, UTC)).toBe("Overloaded · ~03:00");
    expect(badgeText(ticket({ kind: "providerError" }), NOW, UTC)).toBe("Provider error · ~03:00");
    expect(badgeText(ticket({ kind: kind("quota") }), NOW, UTC)).toBe("Stopped · ~03:00");
  });

  test("retry answers and the keys", () => {
    expect(retryToast({ started: true, via: "retry" }, "x")).toBeNull();
    expect(retryToast({ started: false, via: "retry" }, "It's working right now.")).toMatchObject({ title: "Nothing to resume", description: "It's working right now." });
    expect(retryToast({ started: true, via: "command" }, "")?.title).toBe("Sent /retry to omp");
    expect(nothingReason({ column: "running" })).toBe("It's working right now.");
    expect(nothingReason({ column: "needs", needs: {} })).toBe("It's waiting for your answer.");
    expect(nothingReason({ column: "review" })).toBe("Its last turn neither failed nor was stopped.");
    expect(isResumeKey({ ...keys, key: "F5", code: "F5" })).toBe(true);
    expect(isResumeKey({ ...keys, key: "F5", code: "F5", ctrlKey: true })).toBe(false);
    expect(isResumeKey({ ...keys, key: "r", code: "KeyR", altKey: true })).toBe(true);
    expect(isResumeKey({ ...keys, key: "r", code: "KeyR" })).toBe(false);
    expect(isResumeKey({ ...keys, key: "®", code: "KeyR", altKey: true })).toBe(true);
    expect(isResumeKey({ ...keys, key: "p", code: "KeyR", altKey: true })).toBe(false);
  });

  test("/retry in the composer is the native retry", () => {
    expect(findCommand("retry")?.modeFor("")).toBe("native");
  });
});
