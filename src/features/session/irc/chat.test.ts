import { describe, expect, test } from "bun:test";
import type { IrcEntry } from "@/core";
import type { AgentChatLog, AgentChatMessage, IrcMessage, Subagent } from "@/core/gen";
import {
  agentNamer,
  type BoardMessage,
  type ChatLog,
  deliveryOf,
  filterMessages,
  firstUnread,
  fromTranscript,
  MAX_MESSAGES,
  mergeChatPage,
  participants,
  positionText,
  recipientsText,
  unreadCount,
  USER,
} from "./chat";

const msg = (id: string, at: number, m: Partial<AgentChatMessage> = {}): AgentChatMessage => ({
  id,
  from: "A",
  to: ["B"],
  broadcast: false,
  text: id,
  at,
  wakeRelay: false,
  progress: false,
  receipts: [],
  rev: 1,
  ...m,
});

const page = (p: Partial<AgentChatLog>): AgentChatLog => ({ epoch: "e1", rev: 1, messages: [], reset: false, truncated: false, live: true, ...p });
const ids = (log: ChatLog) => log.messages.map((m) => m.id);

describe("merging pages of the log", () => {
  test("the first page is the whole log, in time order", () => {
    const log = mergeChatPage(undefined, page({ rev: 3, reset: true, messages: [msg("m2", 20), msg("m1", 10)] }));
    expect(ids(log)).toEqual(["m1", "m2"]);
    expect(log).toMatchObject({ epoch: "e1", rev: 3, live: true, truncated: false });
  });

  test("a later page replaces what changed by id and adds what is new; the rest keep their objects", () => {
    const first = mergeChatPage(undefined, page({ rev: 2, reset: true, messages: [msg("m1", 10), msg("m2", 20)] }));
    const delivered = msg("m2", 20, { receipts: [{ to: "B", outcome: "injected" }], rev: 3 });
    const next = mergeChatPage(first, page({ rev: 4, messages: [delivered, msg("m3", 30, { rev: 4 })] }));
    expect(ids(next)).toEqual(["m1", "m2", "m3"]);
    expect(next.messages[0]).toBe(first.messages[0] as BoardMessage);
    expect(next.messages[1]).toBe(delivered);
    expect(next.rev).toBe(4);
  });

  test("a message whose time narrowed moves to its place; equal times keep the host's order", () => {
    const first = mergeChatPage(undefined, page({ rev: 3, reset: true, messages: [msg("m1", 10), msg("m2", 20), msg("m3", 20)] }));
    const next = mergeChatPage(first, page({ rev: 4, messages: [msg("m3", 5, { rev: 4 })] }));
    expect(ids(next)).toEqual(["m3", "m1", "m2"]);
  });

  test("another epoch (tf-hostd rebuilt the log) or a reset starts over", () => {
    const first = mergeChatPage(undefined, page({ rev: 9, reset: true, messages: [msg("m1", 10), msg("m2", 20)] }));
    const rebuilt = mergeChatPage(first, page({ epoch: "e2", rev: 2, messages: [msg("m1", 10, { text: "other" })] }));
    expect(ids(rebuilt)).toEqual(["m1"]);
    expect(rebuilt).toMatchObject({ epoch: "e2", rev: 2 });
    expect(rebuilt.messages[0]?.text).toBe("other");
    expect(ids(mergeChatPage(first, page({ rev: 9, reset: true, messages: [msg("m2", 20)] })))).toEqual(["m2"]);
  });

  test("an empty page that changes nothing keeps the copy", () => {
    const first = mergeChatPage(undefined, page({ rev: 2, reset: true, messages: [msg("m1", 10)] }));
    expect(mergeChatPage(first, page({ rev: 2 }))).toBe(first);
    expect(mergeChatPage(first, page({ rev: 2, truncated: true })).truncated).toBe(true);
  });

  test("the oldest go beyond the host's cap", () => {
    const many = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => msg(`m${i + 1}`, i));
    const log = mergeChatPage(undefined, page({ reset: true, messages: many }));
    expect(log.messages).toHaveLength(MAX_MESSAGES);
    expect(log.messages[0]?.id).toBe("m6");
  });
});

describe("the session's own IRC rows (hosts before 0.9.0)", () => {
  const irc = (m: Partial<IrcMessage>): IrcMessage => ({ direction: "in", peer: "Scout", text: "", broadcast: false, wakeRelay: false, fromParent: false, receipts: [], ...m });
  const entry = (itemId: string, at: number, m: Partial<IrcMessage>, status?: IrcEntry["status"], error?: string): IrcEntry => ({ itemId, at, message: irc(m), status, error });

  test("inbound reaches Main, sends go out from it; pending, refused and broadcast sends; replies link by omp id", () => {
    const rows = [
      entry("r2", 200, { direction: "out", peer: "Scout", text: "yes", replyTo: "omp-1" }, "running"),
      entry("r1", 100, { peer: "Scout", text: "go?", messageId: "omp-1" }),
      entry("r3", 300, { direction: "out", peer: "Gone", text: "x" }, "error", "Failed: Gone is not running."),
      entry("r4", 400, { direction: "out", peer: "all", broadcast: true, text: "all", receipts: [{ to: "Scout", outcome: "injected" }, { to: "Pinger", outcome: "woken" }] }, "ok"),
    ];
    const [asked, answer, refused, everyone] = fromTranscript(rows);
    expect(asked).toMatchObject({ id: "r1", itemId: "r1", from: "Scout", to: ["Main"], receipts: [] });
    expect(answer).toMatchObject({ from: "Main", to: ["Scout"], replyTo: "r1", receipts: [{ to: "Scout", outcome: "pending" }] });
    expect(refused?.receipts).toEqual([{ to: "Gone", outcome: "failed", error: "Failed: Gone is not running." }]);
    expect(everyone).toMatchObject({ broadcast: true, to: ["Scout", "Pinger"] });
  });
});

describe("who is who in the tree", () => {
  const sub = (id: string, extra: Partial<Subagent> = {}): Subagent => ({ id, name: id, status: "running", ...extra });
  const subs = [sub("Bench"), sub("Bench.Sweep", { parentId: "Bench" }), sub("Bench.Sweep.Size64", { status: "failed" }), sub("Scout")];
  const who = agentNamer(subs, "pool");

  test("a nested subagent is named without its parents and says where it runs", () => {
    expect(who("Bench.Sweep.Size64")).toMatchObject({ kind: "subagent", label: "Size64", under: ["Bench", "Sweep"] });
    expect(positionText(who("Bench.Sweep"))).toBe("under Bench");
    expect(positionText(who("Scout"))).toBe("");
    expect(who("Scout").sub?.id).toBe("Scout");
  });

  test("Main is the session, user is You; an agent the roster lacks reads from its dotted id", () => {
    expect(who("Main")).toMatchObject({ kind: "main", label: "pool" });
    expect(who(USER)).toMatchObject({ kind: "user", label: "You" });
    expect(who("Lab.Ui.Shots")).toMatchObject({ kind: "subagent", label: "Shots", under: ["Lab", "Ui"], sub: undefined });
  });

  test("subagents listed by name resolve too (ids that aren't omp's)", () => {
    const byName = agentNamer([{ id: "pool-sub-1", name: "Bench", status: "running" }, { id: "pool-sub-1.Sweep", name: "Bench.Sweep", status: "running", parentId: "pool-sub-1" }], "pool");
    expect(byName("Bench.Sweep")).toMatchObject({ label: "Sweep", under: ["Bench"] });
  });

  test("participants: the main agent first, the roster in tree order, others as they came, You last", () => {
    const log = [msg("m1", 1, { from: USER, to: ["Scout"] }), msg("m2", 2, { from: "Stranger", to: ["Main"] }), msg("m3", 3, { from: "Bench.Sweep.Size64", to: ["Bench.Sweep"] }), msg("m4", 4, { from: "Scout", to: ["Main"] })];
    expect(participants(log, subs, who).map((p) => [p.agent.label, p.count])).toEqual([
      ["pool", 2],
      ["Sweep", 1],
      ["Size64", 1],
      ["Scout", 2],
      ["Stranger", 1],
      ["You", 1],
    ]);
  });

  test("recipients in a line", () => {
    expect(recipientsText(["Bench.Sweep"], false, who)).toBe("Sweep");
    expect(recipientsText(["Main", "Scout", "Bench", "Bench.Sweep"], false, who)).toBe("pool, Scout +2");
    expect(recipientsText(["Main", "Scout"], true, who)).toBe("everyone");
  });
});

describe("filters", () => {
  const who = agentNamer([], "pool");
  const log = [
    msg("m1", 1, { from: "Main", to: ["Scout"], text: "rank per request" }),
    msg("m2", 2, { from: "Scout", to: ["Audit"], text: "any session state?" }),
    msg("m3", 3, { from: "Audit", to: ["Scout"], text: "no, stateless" }),
    msg("m4", 4, { from: "Bench", to: ["Main", "Scout", "Audit"], broadcast: true, text: "keep connections low" }),
  ];
  const shown = (agents: string[], query = "") => filterMessages(log, { agents, query }, who).map((m) => m.id);

  test("one agent: what it sent or got, broadcasts it got included", () => {
    expect(shown(["Audit"])).toEqual(["m2", "m3", "m4"]);
  });

  test("two agents: only what went between them", () => {
    expect(shown(["Scout", "Audit"])).toEqual(["m2", "m3"]);
    expect(shown(["Main", "Scout"])).toEqual(["m1"]);
  });

  test("text search is literal and case-folded, over the body and the names", () => {
    expect(shown([], "STATE")).toEqual(["m2", "m3"]);
    expect(shown([], "bench")).toEqual(["m4"]);
    expect(shown([], "pool")).toEqual(["m1", "m4"]);
    expect(shown(["Scout"], "stateless")).toEqual(["m3"]);
    expect(filterMessages(log, { agents: [], query: "  " }, who)).toBe(log);
  });
});

describe("unread", () => {
  const log = [msg("m1", 10), msg("m2", 20, { from: USER }), msg("m3", 30), msg("m4", 40)];

  test("messages after the mark, never the user's own", () => {
    expect(unreadCount(log, 0)).toBe(3);
    expect(unreadCount(log, 10)).toBe(2);
    expect(unreadCount(log, 40)).toBe(0);
    expect(firstUnread(log, 10)?.id).toBe("m3");
    expect(firstUnread(log, 40)).toBeUndefined();
  });
});

describe("delivery", () => {
  test("pending, failed with why, one outcome, a broadcast's tally", () => {
    expect(deliveryOf({ receipts: [] })).toEqual({ kind: "none" });
    expect(deliveryOf({ receipts: [{ to: "B", outcome: "pending" }] })).toEqual({ kind: "sending" });
    expect(deliveryOf({ receipts: [{ to: "B", outcome: "failed", error: "Failed: B is not running." }] })).toEqual({ kind: "failed", error: "Failed: B is not running." });
    expect(deliveryOf({ receipts: [{ to: "B", outcome: "woken" }] })).toMatchObject({ kind: "delivered", label: "woke it" });
    expect(
      deliveryOf({
        receipts: [
          { to: "A", outcome: "injected" },
          { to: "B", outcome: "received" },
          { to: "C", outcome: "pending" },
          { to: "D", outcome: "failed" },
        ],
      }),
    ).toMatchObject({ kind: "delivered", label: "2/4 delivered", pending: 1, failed: [{ to: "D", outcome: "failed" }] });
  });
});
