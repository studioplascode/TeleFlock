import { describe, expect, test } from "bun:test";
import type { ArtifactFile, PresentKind } from "@/core/gen";
import { artifactRows } from "./artifacts";
import { isImageName, isPresentedAsset, kindForName, mimeFor, parseCsv, presentedAssetsDir, presentedName, presentedVersions } from "./kinds";
import { type DocRef, docFileName, docKind, opensAsIs, otherVersion } from "./load";

const file = (name: string, mtime: number, extra: Partial<ArtifactFile> = {}): ArtifactFile => ({ kind: "local", name, url: `local://${name}`, size: 10, mtime, ...extra });

describe("renderer selection", () => {
  test("what the agent said wins; else the name", () => {
    expect(docKind({ kind: "local", name: "presented/x-v1.txt", as: "markdown" })).toBe("markdown");
    expect(["r.html", "r.HTM", "n.md", "d.svg", "s.png", "s.webp", "t.csv", "t.tsv", "d.json", "a.rs", "a.tsx", "log.txt", "LICENSE"].map(kindForName)).toEqual([
      "html", "html", "markdown", "svg", "image", "image", "csv", "csv", "json", "code", "code", "text", "text",
    ]);
    // subagent outputs, handoffs and the plan under review are Markdown
    expect(docKind({ kind: "agent", name: "Explore.md" })).toBe("markdown");
    expect(docKind({ kind: "review", name: "" })).toBe("markdown");
  });

  test("PDFs, audio, video and diagrams by Review's map; archives and other binaries are files to save", () => {
    const names = ["q3.pdf", "chimes.wav", "talk.OPUS", "clip.m4a", "demo.mp4", "demo.mov", "demo.webm", "spin.apng", "flow.mmd", "flow.mermaid", "pack.zip", "deck.pptx", "app.exe", "db.sqlite", "x.bin"];
    expect(names.map(kindForName)).toEqual(["pdf", "audio", "audio", "audio", "video", "video", "video", "image", "mermaid", "mermaid", "file", "file", "file", "file", "file"]);
    // the type the bytes get, by extension
    expect(["q3.pdf", "chimes.wav", "demo.mov", "spin.apng", "font.woff2", "pack.zip", "x.bin"].map(mimeFor)).toEqual([
      "application/pdf", "audio/wav", "video/quicktime", "image/apng", "font/woff2", "application/zip", "application/octet-stream",
    ]);
    // an SVG is a drawing, not an image to save as one
    expect(["a.png", "a.apng", "a.avif", "a.svg", "a.pdf"].map(isImageName)).toEqual([true, true, true, false, false]);
  });

  test("Save and Open in browser: the extension follows what is shown, never one a default app runs outside the sandbox", () => {
    const save = (name: string, kind: PresentKind) => docFileName({ name }, kind, "save");
    const open = (name: string, kind: PresentKind) => docFileName({ name }, kind, "open");
    expect(save("presented/q3-report-v2.html", "html")).toBe("q3-report-v2.html");
    // a page presented as code is its source: never an .html a browser would run
    expect(save("presented/q3-report-v1.html", "code")).toBe("q3-report-v1.html.txt");
    expect(open("presented/q3-report-v1.html", "code")).toBe("q3-report-v1.html.txt");
    expect(save("presented/tool-v1.js", "code")).toBe("tool-v1.js.txt");
    expect(save("notes/feed.xml", "code")).toBe("feed.xml.txt");
    expect(save("presented/main-v1.rs", "code")).toBe("main-v1.rs");
    expect(save("presented/notes-v1.txt", "markdown")).toBe("notes-v1.md");
    expect(save("presented/data-v1.json", "json")).toBe("data-v1.json");
    expect(save("LICENSE", "text")).toBe("LICENSE.txt");
    expect(save("presented/shot-v1.png", "image")).toBe("shot-v1.png");
    // a drawing: the SVG itself to keep; in the browser a page that shows it as an image
    expect(save("presented/logo-v1.svg", "svg")).toBe("logo-v1.svg");
    expect(open("presented/logo-v1.svg", "svg")).toBe("logo-v1.html");
    // a table opens as text: a spreadsheet app would evaluate its formulas
    expect(save("presented/sales-v1.tsv", "csv")).toBe("sales-v1.tsv");
    expect(open("presented/sales-v1.csv", "csv")).toBe("sales-v1.csv.txt");
    expect(docFileName({ name: "", title: "Auth: plan?" }, "markdown", "save")).toBe("Auth_ plan_.md");
    // a PDF, audio and video keep their type; a diagram is its source to keep, a page that shows it to open
    expect([save("presented/q3-pdf-v1.pdf", "pdf"), open("presented/q3-pdf-v1.pdf", "pdf")]).toEqual(["q3-pdf-v1.pdf", "q3-pdf-v1.pdf"]);
    expect([save("presented/chimes-v1.wav", "audio"), save("presented/demo-v2.webm", "video"), save("presented/demo-v3.wav", "video")]).toEqual(["chimes-v1.wav", "demo-v2.webm", "demo-v3.bin"]);
    expect([save("presented/flow-v1.mmd", "mermaid"), open("presented/flow-v1.mmd", "mermaid")]).toEqual(["flow-v1.mmd", "flow-v1.html"]);
  });

  test("a file handed over keeps the name the agent gave it, and opens only as a type that can't run", () => {
    const handed = (name: string, source?: string) => docFileName({ name }, "file", "save", source);
    expect(handed("presented/q3-board-pack-data-v1.zip", "~/finance/q3-report/q3-board-pack.zip")).toBe("q3-board-pack.zip");
    // a source without an extension the bridge keeps (`.bin`), a Windows path, what a file system refuses
    expect(handed("presented/build-v1.bin", "C:\\src\\Makefile")).toBe("Makefile");
    expect(handed("presented/notes-v1.bin", "out/notes:draft?.ABC_DEF")).toBe("notes_draft_.ABC_DEF");
    // no source (a file opened from the list, or a subagent's): the snapshot's own name
    expect([handed("presented/q3-board-pack-data-v1.zip"), handed("presented/x-v2.bin", "")]).toEqual(["q3-board-pack-data-v1.zip", "x-v2.bin"]);
    expect(docFileName({ name: "presented/q3-board-pack-data-v1.zip" }, "file", "open", "q3.zip")).toBe("q3.zip");
    // Open in browser keeps these as they are (src-tauri `docs.rs` OPENABLE): viewers and players, never a page, a script or a program
    expect(["q3.pdf", "chimes.wav", "clip.MOV", "shot.png", "main.rs", "notes.md", "data.json"].every(opensAsIs)).toBe(true);
    expect(["report.html", "report.htm", "logo.svg", "setup.exe", "run.bat", "tool.js", "sheet.xlsx", "sales.csv", "pack.zip", "Makefile", "x.constructor"].some(opensAsIs)).toBe(false);
  });

  test("another version shows as itself: the kind and language carry over only with the same extension", () => {
    const v1: DocRef = { agentKey: "h1|a1", kind: "local", name: "presented/report-v1.html", as: "html", title: "Report" };
    const v2 = otherVersion(v1, "presented/report-v2.md");
    expect(v2).toEqual({ agentKey: "h1|a1", kind: "local", name: "presented/report-v2.md", as: undefined, language: undefined, title: "Report" });
    expect(docKind(v2)).toBe("markdown");
    const code: DocRef = { ...v1, name: "presented/report-v1.ts", as: "code", language: "typescript" };
    expect(otherVersion(code, "presented/report-v3.ts")).toMatchObject({ as: "code", language: "typescript" });
    expect(otherVersion(code, "presented/report-v3.py")).toMatchObject({ as: undefined, language: undefined });
  });

  test("presented names", () => {
    expect(presentedName("presented/q3-report-v12.html")).toEqual({ slug: "q3-report", version: 12, ext: "html" });
    for (const n of ["presented/q3-report-v0.html", "presented/Q3-v1.html", "presented/a/b-v1.html", "q3-report-v1.html", "presented/q3-report-v1"]) expect(presentedName(n)).toBeUndefined();
    expect(presentedAssetsDir("presented/q3-report-v2.html")).toBe("presented/q3-report-v2.files");
    expect(isPresentedAsset("presented/q3-report-v2.files/css/site.css")).toBe(true);
    expect(isPresentedAsset("presented/q3-report-v2.html")).toBe(false);
  });

  test("CSV: quotes, doubled quotes, CRLF, the row cap", () => {
    expect(parseCsv('a,"b, c",d\r\n1,"say ""hi""",3\n\n', ",", 10)).toEqual({ rows: [["a", "b, c", "d"], ["1", 'say "hi"', "3"]], truncated: false, columns: 3 });
    expect(parseCsv("a\tb\n1\t2", "\t", 10).rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("h\n1\n2\n3\n", ",", 2)).toEqual({ rows: [["h"], ["1"]], truncated: true, columns: 1 });
    expect(parseCsv('"multi\nline",x', ",", 5).rows).toEqual([["multi\nline", "x"]]);
  });

  test("CSV: a row keeps its first columns; the rest are counted, not kept", () => {
    const wide = parseCsv(`a,${",".repeat(999_999)}\n1,2\n`, ",", 10, 100);
    expect(wide.rows[0]).toHaveLength(100);
    expect(wide.rows[0]![0]).toBe("a");
    expect(wide.rows[1]).toEqual(["1", "2"]);
    expect(wide.columns).toBe(1_000_001);
    expect(parseCsv("x,y,z", ",", 10, 2)).toEqual({ rows: [["x", "y"]], truncated: false, columns: 3 });
  });
});

describe("the inspector's list", () => {
  test("a presented document is one row, its newest version; its files are not listed", () => {
    const files = [
      file("presented/q3-report-v2.html", 50, { title: "Q3 report" }),
      file("presented/q3-report-v2.files/logo.svg", 50),
      file("presented/migration-notes-v1.md", 40, { title: "Migration notes" }),
      file("presented/q3-report-v1.html", 30, { title: "Q3 report (draft)" }),
      file("presented/q3-report-v1.files/logo.svg", 30),
      file("notes/scan.md", 20, { title: "Scan" }),
      file("auth-plan.md", 10),
    ];
    const groups = artifactRows(files, undefined);
    expect(groups.map((g) => g.section)).toEqual(["presented", "plans", "notes"]);
    const presented = groups[0]!.rows;
    expect(presented.map((r) => [r.title, r.file?.name, r.versions])).toEqual([
      ["Q3 report", "presented/q3-report-v2.html", 2],
      ["Migration notes", "presented/migration-notes-v1.md", 1],
    ]);
    expect(presentedVersions(files, "q3-report").map((v) => v.version)).toEqual([1, 2]);
  });
});
