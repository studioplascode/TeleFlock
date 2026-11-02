import { describe, expect, test } from "bun:test";
import type { Agent, AutoDecision, NeedsYou } from "@/core/gen";
import {
  changeAnswerMessage,
  changeBlock,
  choiceChanged,
  collectDecisions,
  decidedSince,
  decisionAgent,
  decisionMeta,
  decisionQuestion,
  inboxBadge,
  otherOptions,
  pickedText,
  sameDecisions,
  sentChoice,
} from "./review";

const decision = (patch: Partial<AutoDecision> = {}): AutoDecision => ({
  id: "d1",
  agentId: "push",
  agentName: "push",
  requestId: "r1",
  title: "Question",
  question: "Which database?",
  options: [
    { label: "Use SQLite", recommended: true, picked: true },
    { label: "Use Postgres", recommended: false, picked: false },
    { label: "MySQL 8", recommended: false, picked: false },
  ],
  multi: false,
  earlier: false,
  at: 1_000,
  waitedMs: 1_200_000,
  source: "host",
  ...patch,
});

const hostWith = (...decisions: AutoDecision[]) => ({ state: { info: decisions.length ? { decisions } : {} } });

describe("collectDecisions", () => {
  test("every host's, oldest first; at the same time host order wins; hidden ones are left out", () => {
    const hosts = {
      b: hostWith(decision({ id: "b1", at: 50 }), decision({ id: "b2", at: 10 })),
      a: hostWith(decision({ id: "a1", at: 10 }), decision({ id: "a2", at: 30 })),
      c: hostWith(),
      gone: undefined,
    };
    const keys = (list: { hostId: string; id: string }[]) => list.map((d) => `${d.hostId}/${d.id}`);
    expect(keys(collectDecisions(hosts, ["a", "b", "c"]))).toEqual(["a/a1", "b/b2", "a/a2", "b/b1"]);
    // a host with state but no profile still counts, after the profiles
    expect(keys(collectDecisions(hosts, ["b"]))).toEqual(["b/b2", "a/a1", "a/a2", "b/b1"]);
    expect(keys(collectDecisions(hosts, ["a", "b"], { "a/a1": true, "b/b1": true }))).toEqual(["b/b2", "a/a2"]);
    expect(collectDecisions({ c: hostWith() }, ["c"])).toEqual([]);
  });

  test("lists compare by host and id", () => {
    const one = collectDecisions({ a: hostWith(decision()) }, ["a"]);
    expect(sameDecisions(one, collectDecisions({ a: hostWith(decision()) }, ["a"]))).toBe(true);
    expect(sameDecisions(one, collectDecisions({ b: hostWith(decision()) }, ["b"]))).toBe(false);
    expect(sameDecisions(one, [])).toBe(false);
  });

  test("decidedSince counts what was decided after the gap began", () => {
    expect(decidedSince([decision({ at: 5 }), decision({ at: 10 }), decision({ at: 20 })], 10)).toBe(2);
    expect(decidedSince(undefined, 0)).toBe(0);
  });
});

describe("decisionAgent", () => {
  const agent = (id: string, patch: Partial<Agent> = {}) => ({ id, ...patch }) as Pick<Agent, "id" | "omp" | "parked">;
  const link = { link: "live" } as NonNullable<Agent["omp"]>;

  test("by id, else the agent continuing its omp session, else none (it ended)", () => {
    const d = decision({ agentId: "push", sessionId: "s1", sessionFile: "/s/push.jsonl" });
    const same = agent("push");
    expect(decisionAgent(d, [agent("other"), same])).toBe(same);
    // resumed after being parked: a new id, the same omp session
    const resumed = agent("push-2", { omp: { ...link, sessionId: "s1" } });
    expect(decisionAgent(d, [agent("other"), resumed])).toBe(resumed);
    const byFile = agent("push-3", { omp: { ...link, sessionFile: "/s/push.jsonl" } });
    expect(decisionAgent(d, [byFile])).toBe(byFile);
    const parked = agent("push-4", { parked: { at: 1, sessionFile: "/s/push.jsonl" } });
    expect(decisionAgent(d, [parked])).toBe(parked);
    expect(decisionAgent(d, [agent("other", { omp: { ...link, sessionId: "s2" } })])).toBeUndefined();
    expect(decisionAgent(decision({ agentId: "gone" }), [agent("other")])).toBeUndefined();
  });

  test("not the newer session its pane went on to (/new): that one never saw the question", () => {
    const d = decision({ agentId: "push", sessionId: "s1", sessionFile: "/s/push.jsonl" });
    const newer = agent("push", { omp: { ...link, sessionId: "s2", sessionFile: "/s/push-2.jsonl" } });
    // ended: Open goes to Past sessions, Change answer says it ended
    expect(decisionAgent(d, [newer])).toBeUndefined();
    // the session it asked in, resumed in another pane, is still found
    const resumed = agent("push-2", { omp: { ...link, sessionId: "s1" } });
    expect(decisionAgent(d, [newer, resumed])).toBe(resumed);
    // a session the board doesn't know yet, or a decision from a host that kept none: the id decides
    const unknown = agent("push", { omp: link });
    expect(decisionAgent(d, [unknown])).toBe(unknown);
    expect(decisionAgent(decision({ agentId: "push" }), [newer])).toBe(newer);
  });

  test("Change answer needs the agent live on an online host, not waiting for another answer", () => {
    const needs = { kind: "ask", answerable: true } as NeedsYou;
    expect(changeBlock(undefined, true)).toBe("ended");
    expect(changeBlock({ state: "idle", parked: { at: 1, sessionFile: "f" } }, true)).toBe("ended");
    expect(changeBlock({ state: "idle" }, false)).toBe("offline");
    expect(changeBlock({ state: "blocked", needs }, true)).toBe("waiting");
    // a question only the terminal can answer doesn't stop a prompt
    expect(changeBlock({ state: "blocked", needs: { ...needs, answerable: false } }, true)).toBeNull();
    expect(changeBlock({ state: "working" }, true)).toBeNull();
    expect(changeBlock({ state: "idle" }, true)).toBeNull();
  });
});

describe("what a row shows", () => {
  const earlier = decision({
    multi: true,
    earlier: true,
    text: "  keep SQLite for tests ",
    options: [
      { label: "Postgres", recommended: true, picked: true },
      { label: "SQLite", recommended: true, picked: false },
      { label: "MySQL 8", recommended: false, picked: true },
    ],
  });

  test("what was sent: ★ picks, or the earlier answer with its typed text", () => {
    expect(pickedText(decision())).toBe("★ Use SQLite");
    const multi = decision({ multi: true, options: [{ label: "A", recommended: true, picked: true }, { label: "B", recommended: true, picked: true }, { label: "C", recommended: false, picked: false }] });
    expect(pickedText(multi)).toBe("★ A, ★ B");
    expect(sentChoice(earlier)).toEqual({ labels: ["Postgres", "MySQL 8"], text: "keep SQLite for tests" });
    expect(pickedText(earlier)).toBe("your earlier answer (Postgres, MySQL 8, “keep SQLite for tests”)");
    expect(pickedText(decision({ earlier: true, text: "just Postgres", options: [{ label: "SQLite", recommended: true, picked: false }] }))).toBe("your earlier answer (“just Postgres”)");
  });

  test("the options not sent, ★ kept", () => {
    expect(otherOptions(decision())).toEqual([
      { label: "Use Postgres", recommended: false },
      { label: "MySQL 8", recommended: false },
    ]);
    expect(otherOptions(earlier)).toEqual([{ label: "SQLite", recommended: true }]);
  });

  test("omp's title shows above the question only when it says something", () => {
    expect(decisionQuestion(decision())).toEqual({ question: "Which database?" });
    expect(decisionQuestion(decision({ title: "Database" }))).toEqual({ title: "Database", question: "Which database?" });
    expect(decisionQuestion(decision({ title: "Which database?" }))).toEqual({ question: "Which database?" });
  });

  test("how long it waited, whose setting", () => {
    expect(decisionMeta(decision({ waitedMs: 1_200_000 }))).toBe("waited 20 min · host default");
    expect(decisionMeta(decision({ waitedMs: 5_400_000, source: "agent" }))).toBe("waited 1 h 30 min · its own setting");
  });

  test("the Inbox badge counts decisions too, calm while nothing waits on you", () => {
    expect(inboxBadge(2, 3)).toEqual({ count: 5, calm: false });
    expect(inboxBadge(0, 3)).toEqual({ count: 3, calm: true });
    expect(inboxBadge(1, 0)).toEqual({ count: 1, calm: false });
    expect(inboxBadge(0, 0)).toEqual({ count: 0, calm: false });
  });
});

describe("changing an answer", () => {
  test("Send needs a choice other than what was sent", () => {
    const d = decision();
    expect(choiceChanged(d, { labels: ["Use SQLite"] })).toBe(false);
    expect(choiceChanged(d, { labels: [] })).toBe(false);
    expect(choiceChanged(d, { labels: [], text: "   " })).toBe(false);
    expect(choiceChanged(d, { labels: ["Use Postgres"] })).toBe(true);
    expect(choiceChanged(d, { labels: ["Use SQLite"], text: "with WAL on" })).toBe(true);
    expect(choiceChanged(d, { labels: [], text: "Postgres 17" })).toBe(true);
    // multi: the same set in another order is the same answer
    const multi = decision({ multi: true, earlier: true, text: "x", options: [{ label: "A", recommended: true, picked: true }, { label: "B", recommended: false, picked: true }] });
    expect(choiceChanged(multi, { labels: ["B", "A"], text: " x " })).toBe(false);
    expect(choiceChanged(multi, { labels: ["B", "A"] })).toBe(true);
    expect(choiceChanged(multi, { labels: ["A"], text: "x" })).toBe(true);
  });

  test("the follow-up says what was sent and what to do instead", () => {
    expect(changeAnswerMessage(decision(), { labels: ["Use Postgres"] })).toBe(
      "Your question “Which database?” was answered automatically while I was away (decide for me picked “Use SQLite”). Please go with “Use Postgres” instead.",
    );
    const earlier = decision({ multi: true, earlier: true, text: "keep SQLite\nfor tests", options: [{ label: "Postgres", recommended: true, picked: true }, { label: "Redis", recommended: false, picked: false }, { label: "MySQL 8", recommended: false, picked: false }] });
    expect(changeAnswerMessage(earlier, { labels: ["Redis", "MySQL 8"], text: " and drop the cache " })).toBe(
      "Your question “Which database?” was answered automatically while I was away (decide for me sent my earlier answer “Postgres”, “keep SQLite for tests”). Please go with “Redis”, “MySQL 8”, “and drop the cache” instead.",
    );
    // no question text: the title names it; a long question is cut
    expect(changeAnswerMessage(decision({ question: " ", title: "Database" }), { labels: ["Use Postgres"] }).startsWith("Your question “Database” was answered")).toBe(true);
    const long = changeAnswerMessage(decision({ question: "x".repeat(400) }), { labels: ["Use Postgres"] });
    expect(long).toContain(`“${"x".repeat(159)}…”`);
    expect(changeAnswerMessage(decision(), { labels: [], text: "  " })).toBe("");
  });
});
