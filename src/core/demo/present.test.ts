import { describe, expect, test } from "bun:test";
import { assetKey, cssRefs, keyDir, markdownRefs, markupRefs } from "@/features/session/artifacts/sandbox";
import { parseBlocks } from "@/features/session/markdown/parse";
import type { ArtifactContent, ArtifactFile, PresentedArtifact, SessionArtifacts, SessionSnapshot, ToolItem } from "../gen";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";

/** A call to the forge demo host. */
type Call = <T>(method: string, params?: unknown) => Promise<T>;
type Presented = ToolItem & { artifact: PresentedArtifact };

function rig(): Call {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  engine.subscribe(() => {});
  clock.advance(8000);
  return async <T>(method: string, params: unknown = {}): Promise<T> => {
    const p = engine.callHost("forge", method, params);
    clock.advance(400);
    return (await p) as T;
  };
}

/** The docs session's finished `present` rows and its artifacts listing. */
async function docs(call: Call): Promise<{ rows: Presented[]; list: SessionArtifacts }> {
  const snap = await call<SessionSnapshot>("session.open", { agentId: "docs" });
  const rows = snap.items.flatMap((i): Presented[] => (i.kind === "tool" && i.tool === "present" && i.artifact ? [{ ...i, artifact: i.artifact }] : []));
  return { rows, list: await call<SessionArtifacts>("session.artifacts", { agentId: "docs" }) };
}

const read = (call: Call, name: string, base64 = false) => call<ArtifactContent>("session.artifact", { agentId: "docs", kind: "local", name, ...(base64 ? { base64: true } : {}) });
const bytesOf = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const assetsDir = (a: PresentedArtifact) => `presented/${a.slug}-v${a.version}.files/`;

describe("demo host: presented artifacts", () => {
  test("the docs session presented the migration notes and the Q3 report, versions 1 and 2 each", async () => {
    const { rows } = await docs(rig());
    const versions = (title: string) => rows.filter((r) => r.artifact.title === title).map((r) => r.artifact.version);
    expect(versions("Migration notes")).toEqual([1, 2]);
    expect(versions("Q3 revenue report")).toEqual([1, 2]);
    for (const { artifact: a, ...r } of rows) {
      expect(r).toMatchObject({ status: "ok", title: a.title, args: { title: a.title, path: a.source } });
      expect(a.name).toBe(`presented/${a.slug}-v${a.version}.${a.kind === "html" ? "html" : "md"}`);
      expect(a.url).toBe(`local://${a.name}`);
      expect(r.output?.split("\n")[0]).toContain(a.url);
    }
    // a version is the same slug with the next number
    expect(new Set(rows.filter((r) => r.artifact.title === "Q3 revenue report").map((r) => r.artifact.slug)).size).toBe(1);
  });

  test("every row's snapshot is listed with its size and title, its copied files as its asset count", async () => {
    const { rows, list } = await docs(rig());
    for (const { artifact: a, output } of rows) {
      expect(list.files.find((f) => f.name === a.name)).toMatchObject({ kind: "local", url: a.url, size: a.size, title: a.title });
      const assets = list.files.filter((f) => f.name.startsWith(assetsDir(a)));
      expect(assets.length).toBe(a.assets);
      expect(assets.every((f) => f.kind === "local" && f.url === `local://${f.name}`)).toBe(true);
      // what the bridge's result says it copied: how many files, and their size
      const included = /Included (\d+) referenced files? \((\d+) KB\)/.exec(output ?? "");
      expect(included?.slice(1).map(Number)).toEqual([a.assets, Math.ceil(assets.reduce((n, f) => n + f.size, 0) / 1024)]);
    }
    // the screenshot came with the notes' second version
    expect(rows.map((r) => r.artifact.assets)).toEqual([1, 2, 3, 3]);
  });

  test("a document's copied files are exactly the ones it loads, stylesheets' own references included", async () => {
    const call = rig();
    const { rows, list } = await docs(call);
    for (const { artifact: a } of rows) {
      const doc = await read(call, a.name);
      expect(doc.binary).toBe(false);
      const text = doc.text ?? "";
      const loads = new Set<string>();
      const add = (refs: string[], base: string) => {
        for (const ref of refs) {
          const key = assetKey(ref, base);
          if (key !== undefined) loads.add(key);
        }
      };
      add(a.kind === "markdown" ? markdownRefs(text) : markupRefs(text), "");
      for (const key of [...loads].filter((k) => k.endsWith(".css"))) add(cssRefs((await read(call, `${assetsDir(a)}${key}`)).text ?? ""), keyDir(key));
      const copied = list.files.filter((f) => f.name.startsWith(assetsDir(a))).map((f) => f.name.slice(assetsDir(a).length));
      expect(copied.sort()).toEqual([...loads].sort());
    }
  });

  test("reads: documents as text, every file as base64 of its listed size; the screenshot is binary", async () => {
    const call = rig();
    const { list } = await docs(call);
    const presented = list.files.filter((f) => f.name.startsWith("presented/"));
    expect(presented.length).toBe(4 + 1 + 2 + 3 + 3);
    for (const f of presented) {
      const data = await read(call, f.name, true);
      expect(data).toMatchObject({ name: f.name, url: f.url, size: f.size, mtime: f.mtime, truncated: false });
      expect(data.text).toBeUndefined();
      expect(bytesOf(data.data ?? "").length).toBe(f.size);
      const text = await read(call, f.name);
      expect(text.binary).toBe(f.name.endsWith(".png"));
      if (text.binary) expect(text.text).toBeUndefined();
      else expect(new TextEncoder().encode(text.text).length).toBe(f.size);
    }
    const png = presented.find((f) => f.name.endsWith(".png")) as ArtifactFile;
    expect([...bytesOf((await read(call, png.name, true)).data ?? "").subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("the documents use what the viewer renders: the notes' Markdown blocks, the report's script", async () => {
    const call = rig();
    const { rows } = await docs(call);
    const notes = await read(call, rows.find((r) => r.artifact.kind === "markdown")?.artifact.name ?? "");
    const blocks = parseBlocks(notes.text ?? "");
    expect(new Set(blocks.map((b) => b.t))).toEqual(new Set(["h", "p", "list", "table", "code"]));
    expect(blocks.flatMap((b) => (b.t === "code" ? [[b.lang, b.open]] : []))).toEqual([["ts", false], ["mermaid", false]]);
    for (const r of rows.filter((x) => x.artifact.kind === "html")) {
      const page = (await read(call, r.artifact.name)).text ?? "";
      const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
      expect(scripts.length).toBe(1);
      // it parses (the page is built in a template literal: an escape gone wrong would break it)
      expect(() => new Function(scripts[0] ?? "")).not.toThrow();
      expect(page).toContain("<canvas");
    }
  });

  test("other sessions list no presented files", async () => {
    const list = await rig()<SessionArtifacts>("session.artifacts", { agentId: "kanban" });
    expect(list.files.length).toBeGreaterThan(0);
    expect(list.files.some((f) => f.name.startsWith("presented/"))).toBe(false);
  });
});
