import { describe, expect, test } from "bun:test";
import type { McpServer } from "@/core/gen";
import { AnswerOrder } from "./answers";
import { rowActions } from "./model";

describe("mcp.list answer order", () => {
  test("a change's answer that lost to a later read asks for a fresh read, never just dropped", () => {
    const o = new AnswerOrder();
    const save = o.start();
    const poll = o.start();
    // The poll started after the save but answered first, from before the save reached the files.
    expect(o.answer(poll, "poll", false)).toEqual({ show: true });
    expect(o.answer(save, "change", true)).toEqual({ show: false, next: "read" });
    const read = o.start();
    expect(o.answer(read, "read", true)).toEqual({ show: true });
  });

  test("polls ask again after a dropped answer or while a check runs; reads and newer changes just show", () => {
    const o = new AnswerOrder();
    const poll = o.start();
    const change = o.start();
    expect(o.answer(change, "change", true)).toEqual({ show: true });
    expect(o.answer(poll, "poll", false)).toEqual({ show: false, next: "poll" });
    const next = o.start();
    expect(o.answer(next, "poll", true)).toEqual({ show: true, next: "poll" });
    const last = o.start();
    expect(o.answer(last, "poll", false)).toEqual({ show: true });
    const stale = o.start();
    const fresh = o.start();
    expect(o.answer(fresh, "read", false).show).toBe(true);
    expect(o.answer(stale, "read", false)).toEqual({ show: false });
  });
});

describe("row actions", () => {
  const row = (s: Partial<McpServer>): McpServer => ({
    name: "docs",
    origin: "user",
    path: "/home/me/.omp/agent/mcp.json",
    server: { transport: "http", url: "https://x.dev/mcp", args: [], env: [], headers: [] },
    enabled: true,
    signedIn: false,
    shadowed: false,
    status: "needsAuth",
    tools: [],
    extra: [],
    ...s,
  });

  test("a hidden imported server has no working switch and no test", () => {
    expect(rowActions(row({ origin: "imported", shadowed: true, path: "/home/me/.cursor/mcp.json" }))).toEqual({ toggle: false, test: false, signIn: false });
    expect(rowActions(row({ origin: "imported", path: "/home/me/.claude.json" }))).toEqual({ toggle: true, test: true, signIn: false });
    expect(rowActions(row({ shadowed: true }))).toMatchObject({ toggle: true, test: true });
  });

  test("sign-in only for omp's own mcp.json servers that connect over HTTP and are on", () => {
    expect(rowActions(row({})).signIn).toBe(true);
    expect(rowActions(row({ path: "C:\\Users\\me\\.omp\\agent\\mcp.json" })).signIn).toBe(true);
    expect(rowActions(row({ path: "/home/me/.omp/agent/.mcp.json" })).signIn).toBe(false);
    expect(rowActions(row({ enabled: false })).signIn).toBe(false);
    expect(rowActions(row({ server: { transport: "stdio", command: "npx", args: [], env: [], headers: [] } })).signIn).toBe(false);
  });
});
