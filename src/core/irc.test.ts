import { describe, expect, test } from "bun:test";
import type { IrcMessage, TranscriptItem } from "@/core/gen";
import { ircOf, ircThreads, ircUnread } from "./irc";

const msg = (m: Partial<IrcMessage>): IrcMessage => ({ direction: "in", peer: "Pinger", text: "", broadcast: false, wakeRelay: false, fromParent: false, receipts: [], ...m });

describe("irc", () => {
  // A message picked up by `wait`: the row is stamped with the call's start (100), omp sent it at 500.
  const waited: TranscriptItem = { kind: "tool", id: "t:w", at: 100, callId: "w", tool: "wait", title: "wait", args: {}, status: "ok", truncated: false, view: { type: "irc", ...msg({ text: "ping", sentAt: 500 }) } };
  const sent: TranscriptItem = { kind: "tool", id: "t:s", at: 300, callId: "s", tool: "write", title: "agent://Pinger", args: {}, status: "ok", truncated: false, view: { type: "irc", ...msg({ direction: "out", text: "pong" }) } };

  test("wait pick-ups use omp's send time", () => {
    expect(ircOf(waited)?.at).toBe(500);
    expect(ircOf(sent)?.at).toBe(300);
    const [t] = ircThreads([ircOf(sent)!, ircOf(waited)!]);
    expect(t?.entries.map((e) => e.message.text)).toEqual(["pong", "ping"]);
    expect(t?.last.message.text).toBe("ping");
    // Seen up to the send: the later ping is still unread.
    expect(ircUnread(t!, 300)).toBe(1);
    expect(ircUnread(t!, 500)).toBe(0);
  });

  test("non-IRC rows carry none", () => {
    expect(ircOf({ kind: "mode", id: "m", at: 1, text: "Model: x" })).toBeNull();
  });
});
