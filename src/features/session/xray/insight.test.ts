import { describe, expect, test } from "bun:test";
import { demoInsight } from "@/core/demo/insight";
import type { Agent, ArtifactFile, ContextXray, SessionArtifacts, SessionMeta, TranscriptItem } from "@/core/gen";
import { artifactRows, formatBytes, isPlan } from "../artifacts/artifacts";
import { biggestOutputs, roomText, sharePct, suggestFocus, toolRowOf, xraySegments } from "./xray";

const file = (kind: ArtifactFile["kind"], name: string, mtime: number, extra: Partial<ArtifactFile> = {}): ArtifactFile => ({
  kind,
  name,
  url: kind === "local" ? `local://${name}` : kind === "agent" ? `agent://${name.replace(/^.*\//, "").replace(/\.md$/, "")}` : undefined,
  size: 100,
  mtime,
  ...extra,
});

describe("artifact rows", () => {
  const files = [
    file("handoff", "handoff-2026.md", 9),
    file("agent", "Explore.md", 8, { title: "Findings" }),
    file("local", "reports/scan.md", 7),
    file("local", "auth-plan.md", 6, { title: "Auth plan" }),
    file("local", "PLAN.md", 5),
  ];

  test("sections in order; plans are omp's `…plan.md` local files", () => {
    expect(isPlan(files[3]!)).toBe(true);
    expect(isPlan(file("agent", "x-plan.md", 1))).toBe(false);
    const groups = artifactRows(files, undefined);
    expect(groups.map((g) => [g.section, g.rows.map((r) => r.title)])).toEqual([
      ["plans", ["Auth plan", "PLAN.md"]],
      ["notes", ["scan.md"]],
      ["outputs", ["Findings"]],
      ["handoffs", ["handoff-2026.md"]],
    ]);
    expect(groups[2]!.rows[0]!.ref).toBe("agent://Explore");
  });

  test("a pending plan review is pinned first, its file not listed twice", () => {
    const groups = artifactRows(files, { title: "Auth rework", content: "# Plan", path: "local://auth-plan.md" });
    expect(groups[0]).toMatchObject({ section: "review", rows: [{ title: "Auth rework", ref: "local://auth-plan.md", file: files[3] }] });
    expect(groups[1]!.rows.map((r) => r.title)).toEqual(["PLAN.md"]);
    // a review of a file outside local:// still shows (its text comes with the review)
    const outside = artifactRows([], { content: "steps", path: "docs/plan.md" });
    expect(outside[0]!.rows[0]).toMatchObject({ title: "plan.md", ref: "docs/plan.md", file: undefined });
  });

  test("sizes", () => {
    expect([formatBytes(812), formatBytes(4300), formatBytes(18_500), formatBytes(1_400_000)]).toEqual(["812 B", "4.2 KB", "18 KB", "1.3 MB"]);
  });
});

const xray = (over: Partial<ContextXray> = {}): ContextXray => ({
  source: "omp",
  window: 200_000,
  used: 23_116,
  buffer: 30_000,
  free: 146_884,
  threshold: 170_000,
  categories: [
    { id: "system-prompt", label: "System Prompt (excluding Skills)", tokens: 9874, weight: 10_420, entries: 3, children: [], top: [] },
    { id: "custom-tools", label: "Custom Tools", tokens: 0, weight: 0, entries: 0, children: [], top: [] },
    { id: "tool-output", label: "Tool Output", tokens: 13_242, weight: 14_000, entries: 2, children: [], top: [{ id: "o1", label: "bash", tokens: 1500, preview: "x", chars: 10, callId: "c1" }] },
  ],
  images: 0,
  dropImages: true,
  at: 1,
  ...over,
});

describe("context x-ray", () => {
  test("shares and the room left, as omp's overview prints them", () => {
    expect([sharePct(9874, 200_000), sharePct(50, 200_000), sharePct(0, 200_000), sharePct(5, 0)]).toEqual(["4.9%", "<0.1%", "0.0%", "—"]);
    expect(roomText(xray())).toBe("146,884 left before auto-compaction at 85%");
    expect(roomText(xray({ used: 180_000 }))).toBe("Past auto-compaction at 85%");
    expect(roomText(xray({ threshold: undefined }))).toBe("146,884 free");
  });

  test("bar segments: used categories, free space, then the buffer", () => {
    expect(xraySegments(xray()).map((s) => [s.id, s.tokens])).toEqual([
      ["system-prompt", 9874],
      ["tool-output", 13_242],
      ["free", 146_884],
      ["buffer", 30_000],
    ]);
    expect(biggestOutputs(xray()).map((e) => e.callId)).toEqual(["c1"]);
  });

  test("compaction focus: goal, else the task in progress, else the latest prompt", () => {
    const items = [
      { kind: "user", id: "u1", text: "first ask" },
      { kind: "tool", id: "t1", callId: "c1" },
      { kind: "user", id: "u2", text: "  fix the\nlanes  " },
    ] as unknown as TranscriptItem[];
    const meta = (m: Partial<SessionMeta>) => m as SessionMeta;
    expect(suggestFocus(meta({ goal: { objective: "Ship the cache", status: "active" }, todos: [] }), items)).toBe("Ship the cache");
    expect(suggestFocus(meta({ todos: [{ name: "Cache", tasks: [{ content: "Migrate", status: "inProgress" }] }] } as unknown as Partial<SessionMeta>), items)).toBe("Migrate (Cache)");
    expect(suggestFocus(meta({ todos: [] }), items)).toBe("fix the lanes");
    expect(suggestFocus(undefined, [])).toBe("");
    expect(toolRowOf(items, "c1")).toBe("t1");
    expect(toolRowOf(items, "nope")).toBeUndefined();
  });
});

describe("demo host", () => {
  const agent = { id: "kanban", name: "kanban", kind: "omp", title: "Fix the lanes", turns: 6, omp: { context: { tokens: 50_000, window: 200_000, pct: 25 } } } as unknown as Agent;

  test("lists, reads and breaks down a demo session", () => {
    const list = demoInsight("session.artifacts", { agentId: "kanban" }, agent, 1_000_000_000, "/home/ada") as SessionArtifacts;
    expect(list.files.map((f) => f.kind)).toContain("handoff");
    expect(list.files[0]!.mtime).toBeGreaterThanOrEqual(list.files.at(-1)!.mtime);
    const plan = list.files.find((f) => isPlan(f))!;
    const read = demoInsight("session.artifact", { agentId: "kanban", kind: plan.kind, name: plan.name }, agent, 1, "/home/ada") as { text: string };
    expect(read.text.startsWith("# Plan: Fix the lanes")).toBe(true);
    expect(() => demoInsight("session.artifact", { agentId: "kanban", kind: "local", name: "../etc" }, agent, 1, "/home/ada")).toThrow();
    const x = demoInsight("session.context", { agentId: "kanban" }, agent, 1, "/home/ada") as ContextXray;
    expect(x.categories.reduce((sum, c) => sum + (c.tokens ?? 0), 0)).toBe(50_000);
    expect(x.used + x.buffer + x.free).toBe(x.window);
    const out = x.categories.find((c) => c.id === "tool-output")!;
    expect(out.children.reduce((sum, c) => sum + (c.tokens ?? 0), 0)).toBe(out.tokens);
  });
});
