import { describe, expect, test } from "bun:test";
import { mediaByPath, sniffMedia } from "@/features/review/diff/media";
import { kindForName } from "@/features/session/artifacts/kinds";
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

const read = (call: Call, name: string, how: { base64?: boolean; offset?: number; maxBytes?: number } = {}) => call<ArtifactContent>("session.artifact", { agentId: "docs", kind: "local", name, ...how });
const bytesOf = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const assetsDir = (a: PresentedArtifact) => `presented/${a.slug}-v${a.version}.files/`;
const ascii = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
/** CRC-32 (IEEE) by table: checks the ZIP writer's bitwise one. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => (bytes.reduce((c, b) => (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
/** The documents that reference files the bridge copies next to them. */
const referencing = (a: PresentedArtifact) => a.kind === "html" || a.kind === "markdown";

/** What the bridge names a snapshot's extension: the kind's own, else the source's, else `bin`. */
function snapshotExt(a: PresentedArtifact): string {
  const own: Partial<Record<PresentedArtifact["kind"], string>> = { html: "html", markdown: "md", mermaid: "mmd", pdf: "pdf" };
  return own[a.kind] ?? /\.([a-z0-9]{1,10})$/.exec(a.source ?? "")?.[1] ?? "bin";
}

describe("demo host: presented artifacts", () => {
  test("the docs session presented the notes and the report in two versions, then the board pack and the chimes", async () => {
    const { rows } = await docs(rig());
    const versions = (title: string) => rows.filter((r) => r.artifact.title === title).map((r) => r.artifact.version);
    expect(versions("Migration notes")).toEqual([1, 2]);
    expect(versions("Q3 revenue report")).toEqual([1, 2]);
    expect(rows.map((r) => [r.artifact.title, r.artifact.kind])).toEqual([
      ["Migration notes", "markdown"],
      ["Migration notes", "markdown"],
      ["Q3 revenue report", "html"],
      ["Q3 revenue report", "html"],
      ["Q3 report (PDF)", "pdf"],
      ["Q3 board pack data", "file"],
      ["Board pack pipeline", "mermaid"],
      ["Notification chimes", "audio"],
      ["Card flight", "video"],
    ]);
    for (const { artifact: a, ...r } of rows) {
      // a file by its path; inline text with its kind
      const args = a.source !== undefined ? { title: a.title, path: a.source } : { title: a.title, content: expect.any(String), kind: a.kind };
      expect(r).toMatchObject({ status: "ok", title: a.title, args });
      expect(a.name).toBe(`presented/${a.slug}-v${a.version}.${snapshotExt(a)}`);
      expect(a.url).toBe(`local://${a.name}`);
      expect(r.output?.split("\n")[0]).toContain(a.url);
      // what the app shows it as by its name alone (the Artifacts list opens it so)
      expect(kindForName(a.name)).toBe(a.kind);
    }
    // a version is the same slug with the next number
    expect(new Set(rows.filter((r) => r.artifact.title === "Q3 revenue report").map((r) => r.artifact.slug)).size).toBe(1);
  });

  test("every row's snapshot is listed with its size and title, its copied files as its asset count", async () => {
    const { rows, list } = await docs(rig());
    for (const { artifact: a, output } of rows) {
      expect(list.files.find((f) => f.name === a.name)).toMatchObject({ kind: "local", url: a.url, size: a.size, title: referencing(a) ? a.title : undefined });
      const assets = list.files.filter((f) => f.name.startsWith(assetsDir(a)));
      expect(assets.length).toBe(a.assets);
      expect(assets.every((f) => f.kind === "local" && f.url === `local://${f.name}`)).toBe(true);
      // what the bridge's result says it copied: how many files, and their size
      const included = /Included (\d+) referenced files? \((\d+) KB\)/.exec(output ?? "");
      if (a.assets === 0) expect(included).toBeNull();
      else expect(included?.slice(1).map(Number)).toEqual([a.assets, Math.ceil(assets.reduce((n, f) => n + f.size, 0) / 1024)]);
    }
    // the screenshot came with the notes' second version
    expect(rows.map((r) => r.artifact.assets)).toEqual([1, 2, 3, 3, 0, 0, 0, 0, 0]);
  });

  test("a document's copied files are exactly the ones it loads, stylesheets' own references included", async () => {
    const call = rig();
    const { rows, list } = await docs(call);
    for (const { artifact: a } of rows.filter((r) => referencing(r.artifact))) {
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

  test("reads: documents as text, every file as base64 of its listed size; the screenshot, PDF, ZIP, WAV and WebM are binary", async () => {
    const call = rig();
    const { list } = await docs(call);
    const presented = list.files.filter((f) => f.name.startsWith("presented/"));
    expect(presented.length).toBe(4 + 1 + 2 + 3 + 3 + 5);
    for (const f of presented) {
      const data = await read(call, f.name, { base64: true });
      expect(data).toMatchObject({ name: f.name, url: f.url, size: f.size, mtime: f.mtime, truncated: false });
      expect(data.text).toBeUndefined();
      expect(data.offset).toBeUndefined();
      expect(bytesOf(data.data ?? "").length).toBe(f.size);
      const text = await read(call, f.name);
      expect(text.binary).toBe(/\.(png|pdf|zip|wav|webm)$/.test(f.name));
      if (text.binary) expect(text.text).toBeUndefined();
      else expect(new TextEncoder().encode(text.text).length).toBe(f.size);
    }
    const png = presented.find((f) => f.name.endsWith(".png")) as ArtifactFile;
    expect([...bytesOf((await read(call, png.name, { base64: true })).data ?? "").subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("ranged reads, as tf-hostd answers them: the bytes from the offset as base64, the offset echoed, the rest marked", async () => {
    const call = rig();
    const { rows } = await docs(call);
    const wav = rows.find((r) => r.artifact.kind === "audio")?.artifact as PresentedArtifact;
    const whole = bytesOf((await read(call, wav.name, { base64: true })).data ?? "");
    const parts: Uint8Array[] = [];
    for (let at = 0; ; ) {
      const r = await read(call, wav.name, { offset: at, maxBytes: 16 << 10 });
      expect(r).toMatchObject({ offset: at, size: wav.size, binary: true });
      const bytes = bytesOf(r.data ?? "");
      parts.push(bytes);
      at += bytes.length;
      expect(r.truncated).toBe(at < wav.size);
      if (!r.truncated) break;
    }
    expect(parts.length).toBe(Math.ceil(wav.size / (16 << 10)));
    const joined = new Uint8Array(whole.length);
    let filled = 0;
    for (const p of parts) {
      joined.set(p, filled);
      filled += p.length;
    }
    expect(filled === whole.length && joined.every((b, i) => b === whole[i])).toBe(true);
    // past the end: nothing, nothing more; a range is bytes even without `base64`
    expect(await read(call, wav.name, { offset: wav.size + 10 })).toMatchObject({ offset: wav.size, data: "", truncated: false });
    // a text read stops at `maxBytes` (4 KiB at least), its text cut there
    const page = rows.find((r) => r.artifact.kind === "html")?.artifact as PresentedArtifact;
    const cut = await read(call, page.name, { maxBytes: 100 });
    expect(cut.truncated).toBe(true);
    // 4 KiB, less a character the cut halved
    const cutBytes = new TextEncoder().encode(cut.text).length;
    expect(cutBytes).toBeLessThanOrEqual(4 << 10);
    expect(cutBytes).toBeGreaterThan((4 << 10) - 4);
  });

  test("the board pack and the chimes are the files they say they are", async () => {
    const call = rig();
    const { rows } = await docs(call);
    const bytes = async (kind: PresentedArtifact["kind"]) => {
      const a = rows.find((r) => r.artifact.kind === kind)?.artifact as PresentedArtifact;
      return { a, b: bytesOf((await read(call, a.name, { base64: true })).data ?? "") };
    };
    // The PDF: two pages, every object where the cross-reference table says, typed as Review types PDFs.
    const pdf = await bytes("pdf");
    const text = ascii(pdf.b);
    expect(text.startsWith("%PDF-1.4\n") && text.endsWith("%%EOF\n")).toBe(true);
    expect(text).toContain("/Count 2");
    const xref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(xref, xref + 5)).toBe("xref\n");
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBe(8);
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(sniffMedia(pdf.b)).toEqual(mediaByPath(pdf.a.name));
    expect(mediaByPath(pdf.a.name)?.mime).toBe("application/pdf");
    // The WAV: RIFF sizes that add up, 16 kHz 16-bit mono, about 3.4 s of the four chimes.
    const wav = await bytes("audio");
    const v = new DataView(wav.b.buffer, wav.b.byteOffset, wav.b.byteLength);
    expect([ascii(wav.b.subarray(0, 4)), ascii(wav.b.subarray(8, 16)), ascii(wav.b.subarray(36, 40))]).toEqual(["RIFF", "WAVEfmt ", "data"]);
    expect([v.getUint32(4, true), v.getUint32(40, true)]).toEqual([wav.b.length - 8, wav.b.length - 44]);
    expect([v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)]).toEqual([1, 16_000, 16]);
    expect((wav.b.length - 44) / 2 / 16_000).toBeCloseTo(3.37, 1);
    expect(sniffMedia(wav.b)).toEqual(mediaByPath(wav.a.name));
    // The ZIP: its three entries, each stored with its CRC-32.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const zip = await bytes("file");
    const z = new DataView(zip.b.buffer, zip.b.byteOffset, zip.b.byteLength);
    const end = zip.b.length - 22;
    expect(z.getUint32(end, true)).toBe(0x06054b50);
    const names: string[] = [];
    for (let at = z.getUint32(end + 16, true), n = 0; n < z.getUint16(end + 10, true); n++) {
      expect(z.getUint32(at, true)).toBe(0x02014b50);
      const nameLength = z.getUint16(at + 28, true);
      const head = z.getUint32(at + 42, true);
      names.push(ascii(zip.b.subarray(at + 46, at + 46 + nameLength)));
      const size = z.getUint32(head + 18, true);
      const data = zip.b.subarray(head + 30 + nameLength, head + 30 + nameLength + size);
      expect(z.getUint32(head + 14, true)).toBe(crc32(data));
      at += 46 + nameLength;
    }
    expect(names).toEqual(["q3-revenue-by-plan.csv", "q3-revenue-by-region.csv", "README.txt"]);
    // The diagram: Mermaid source, as the transcript draws it.
    const mmd = rows.find((r) => r.artifact.kind === "mermaid")?.artifact as PresentedArtifact;
    expect((await read(call, mmd.name)).text?.startsWith("flowchart TB\n")).toBe(true);
    // The clip: a WebM (EBML) of its listed size, typed as Review types WebM.
    const webm = await bytes("video");
    expect([webm.b.length, sniffMedia(webm.b)?.mime, mediaByPath(webm.a.name)?.mime]).toEqual([webm.a.size, "video/webm", "video/webm"]);
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
