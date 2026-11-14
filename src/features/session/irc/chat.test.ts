import { describe, expect, test } from "bun:test";
import type { IrcEntry } from "@/core";
import type { AgentChatLog, AgentChatMessage, IrcMessage, IrcReceipt, Subagent } from "@/core/gen";
import {
  agentNamer,
  type BoardMessage,
  type ChatLog,
  deliveryNotes,
  deliveryOf,
  deliveryTip,
  filterMessages,
  firstUnread,
  fromTranscript,
  logEntryOf,
  MAX_MESSAGES,
  mergeChatPage,
  participants,
  positionText,
  receiptText,
  recipientsText,
  rowReceipts,
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
    const settled = msg("m2", 20, { receipts: [{ to: "B", outcome: "injected" }], rev: 3 });
    const next = mergeChatPage(first, page({ rev: 4, messages: [settled, msg("m3", 30, { rev: 4 })] }));
    expect(ids(next)).toEqual(["m1", "m2", "m3"]);
    expect(next.messages[0]).toBe(first.messages[0] as BoardMessage);
    expect(next.messages[1]).toBe(settled);
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
  const r = (to: string, outcome: string, error?: string): IrcReceipt => ({ to, outcome, ...(error ? { error } : {}) });
  /** The status line as the bubble and the board write it. */
  const line = (receipts: IrcReceipt[]) => {
    const d = deliveryOf({ receipts });
    return "label" in d ? [d.label, ...deliveryNotes(d).map((n) => n.text)].join(" · ") : d.kind;
  };

  test("pending, failed with why, one recipient's state", () => {
    expect(deliveryOf({ receipts: [] })).toEqual({ kind: "none" });
    expect(deliveryOf({ receipts: [r("B", "pending")] })).toEqual({ kind: "sending" });
    expect(deliveryOf({ receipts: [r("B", "failed", "Failed: B is not running.")] })).toEqual({ kind: "failed", error: "Failed: B is not running." });
    expect(deliveryOf({ receipts: [r("B", "woken")] })).toMatchObject({ kind: "delivered", label: "woke it" });
    expect(deliveryOf({ receipts: [r("B", "revived")] })).toMatchObject({ kind: "delivered", label: "revived it" });
    expect(deliveryOf({ receipts: [r("B", "received")] })).toMatchObject({ kind: "delivered", label: "delivered", queued: [] });
  });

  test("what omp queued for a busy recipient (injected) is queued until its transcript has it, not delivered", () => {
    expect(deliveryOf({ receipts: [r("AuditXDatasets", "injected")] })).toEqual({ kind: "queued", label: "queued", queued: ["AuditXDatasets"], pending: 0, failed: [] });
    expect(receiptText(r("B", "injected"))).toBe("queued");
    expect(receiptText(r("B", "received"))).toBe("delivered");
  });

  test("several recipients: how many have it, and how many wait, are in flight or got nothing", () => {
    expect(line([r("A", "received"), r("B", "woken"), r("C", "injected")])).toBe("2/3 delivered · 1 queued");
    expect(line([r("A", "injected"), r("B", "injected"), r("C", "injected")])).toBe("3 queued");
    expect(line([r("A", "injected"), r("B", "received"), r("C", "pending"), r("D", "failed")])).toBe("1/4 delivered · 1 queued · 1 sending · not to D");
    expect(line([r("A", "injected"), r("B", "failed"), r("C", "failed")])).toBe("1 queued · 2 not delivered");
  });

  test("tooltips say why a queued message waits, as far as the host's log can tell", () => {
    const follows = { follows: true, oldHost: false };
    const one = [r("AuditXDatasets", "injected")];
    const tip = (w: { follows: boolean; oldHost: boolean }) => deliveryTip(one, deliveryOf({ receipts: one }), w);
    expect(tip(follows)).toBe("Waiting for AuditXDatasets to finish its current step: omp queued the message until then.");
    expect(tip({ follows: false, oldHost: false })).toBe("omp queued the message: AuditXDatasets gets it at its next step.\nTeleFlock can't tell yet whether that happened.");
    expect(tip({ follows: false, oldHost: true })).toBe("omp queued the message: AuditXDatasets gets it at its next step.\nThis host can't tell when that happens (tf-hostd 0.9.5 can).");
    const three = [r("Scout", "received"), r("Audit", "injected"), r("Bench", "injected")];
    expect(deliveryTip(three, deliveryOf({ receipts: three }), follows)).toBe(
      "Scout: delivered\nAudit: queued\nBench: queued\n\nWaiting for Audit and Bench to finish their current step: omp queued the message until then.",
    );
    expect(deliveryTip([r("Scout", "received")], deliveryOf({ receipts: [r("Scout", "received")] }), follows)).toBe("Scout has it");
  });
});

describe("a transcript's sends in the log", () => {
  const r = (to: string, outcome: string): IrcReceipt => ({ to, outcome });
  const send = (at: number, m: Partial<AgentChatMessage> = {}) => msg(`m${at}`, at, { from: "Main", to: ["Audit"], text: "Rank per request.", ...m });
  const row = (at: number, to = "Audit", text = "Rank per request.") => ({ from: "Main", to, text, at });

  test("an outbound row is the log's message from the same sender to the same recipient with the same text, sent at or after the row", () => {
    const log = [send(90, { from: "Scout" }), send(100, { to: ["Bench"] }), send(105, { text: "Other." }), send(110), send(500)];
    expect(logEntryOf(log, row(100, "Audit", "  Rank per request.\n"))?.id).toBe("m110");
    // Both tell time by omp's clock: one sent a little before the row's time (a row the host stamped) still is.
    expect(logEntryOf([send(98)], row(100))?.id).toBe("m98");
    expect(logEntryOf([send(100 - 3_001)], row(100))).toBeUndefined();
  });

  test("the same text sent twice: each row its own message, in order", () => {
    // The second call's message started right after the first send.
    const log = [send(1_000), send(1_040)];
    expect(logEntryOf(log, row(900))?.id).toBe("m1000");
    expect(logEntryOf(log, row(1_020))?.id).toBe("m1040");
  });

  test("a broadcast is the log's broadcast; a body tf-hostd cut still matches", () => {
    const log = [send(10, { to: ["Audit", "Bench"], broadcast: true }), send(20)];
    expect(logEntryOf(log, row(5, "all"))?.id).toBe("m10");
    expect(logEntryOf(log, row(5))?.id).toBe("m20");
    const cut = send(30, { text: `${"x".repeat(50)}\n\n…` });
    expect(logEntryOf([cut], row(25, "Audit", `${"x".repeat(50)}${"y".repeat(50)}`))).toBe(cut);
  });

  test("the log's received takes a recipient out of the queue; without the log's word it stays queued", () => {
    const receipts = [r("Audit", "injected"), r("Bench", "woken"), r("Scout", "injected")];
    expect(rowReceipts(receipts, { receipts: [r("Audit", "received"), r("Bench", "received"), r("Scout", "injected")] })).toEqual([r("Audit", "received"), r("Bench", "woken"), r("Scout", "injected")]);
    expect(rowReceipts(receipts, undefined)).toBe(receipts);
    expect(deliveryOf({ receipts: rowReceipts([r("Audit", "injected")], undefined) })).toMatchObject({ kind: "queued", label: "queued" });
    // A row from an omp before receipts takes the log's.
    expect(rowReceipts([], { receipts: [r("Audit", "received")] })).toEqual([r("Audit", "received")]);
  });
});
