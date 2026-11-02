// Tests for the bridge's 2.3.0 `present` tool (docs/bridge-protocol.md "Presented artifacts"):
// slugs, kinds and extensions, the references a document loads, the versioned snapshot with the
// files it references, the argument checks, the session's `local://` root, and the registration
// omp sees.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	copyPresentAssets,
	cssAssetRefs,
	markdownAssetRefs,
	markupAssetRefs,
	nextPresentVersion,
	normalizeAssetRef,
	PRESENT_TEXT_MAX,
	type PresentDetails,
	presentArtifact,
	PresentError,
	presentKindForExt,
	presentLocalRoot,
	presentSlug,
	registerPresentTool,
	sniffPresentKind,
} from "./teleflock-bridge";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-present-"));
	temps.push(dir);
	return dir;
}

function put(file: string, data: string | Uint8Array): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
}

/** A worktree with a report page and what it references, and a session's `local://` root. */
function workspace() {
	const root = tmp();
	const cwd = path.join(root, "repo");
	const localRoot = path.join(root, "session", "local");
	put(
		path.join(cwd, "report/index.html"),
		`<!doctype html><html><head><title>Q3</title>
<link rel="stylesheet" href="css/site.css?v=3"><link rel="preconnect" href="https://fonts.example">
<script src="https://cdn.example/chart.js"></script><script src="js/app.js"></script>
<style>.hero { background: url('img/hero.png') }</style></head>
<body><img src="chart.png" srcset="chart.png 1x, chart@2x.png 2x"><img src="../outside.png"><img src="/etc/logo.png">
<img src="data:image/png;base64,AAAA"><a href="details.html">details</a><!-- <img src="commented.png"> -->
<script>const fake = '<img src="in-script.png">';</script><img src="missing.png"></body></html>`,
	);
	put(path.join(cwd, "report/css/site.css"), `@import "theme.css";\n/* url(comment.png) */\nbody { background: url(../img/bg.png) }`);
	put(path.join(cwd, "report/css/theme.css"), `h1 { background-image: url("../img/h1.png") }`);
	put(path.join(cwd, "report/img/bg.png"), "bg");
	put(path.join(cwd, "report/img/h1.png"), "h1");
	put(path.join(cwd, "report/img/hero.png"), "hero");
	put(path.join(cwd, "report/js/app.js"), "console.log(1)");
	put(path.join(cwd, "report/chart.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]));
	put(path.join(cwd, "report/chart@2x.png"), "2x");
	put(path.join(cwd, "outside.png"), "outside");
	return { root, cwd, localRoot, env: { cwd, localRoot, linked: true } };
}

describe("names and kinds", () => {
	test("slugs", () => {
		expect(presentSlug("Q3 Report: Revenue & Costs")).toBe("q3-report-revenue-costs");
		expect(presentSlug("  Bericht über Q3 —  Zahlen ")).toBe("bericht-uber-q3-zahlen");
		expect(presentSlug("x".repeat(30) + " " + "y".repeat(30))).toBe(`${"x".repeat(30)}-${"y".repeat(17)}`);
		expect(presentSlug(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
		// nothing ASCII left: a stable name from the title, different titles apart
		expect(presentSlug("日本語のレポート")).toMatch(/^artifact-[0-9a-f]{6}$/);
		expect(presentSlug("日本語のレポート")).toBe(presentSlug("日本語のレポート"));
		expect(presentSlug("日本語のレポート")).not.toBe(presentSlug("别的报告"));
	});

	test("kinds from extensions and content", () => {
		expect(["html", "htm", "md", "mdx", "svg", "png", "jpeg", "csv", "tsv", "json", "log", "rs", "jsonl", "weird"].map(presentKindForExt)).toEqual([
			"html", "html", "markdown", "markdown", "svg", "image", "image", "csv", "csv", "json", "text", "code", "code", undefined,
		]);
		expect(sniffPresentKind("  <!DOCTYPE html><p>x")).toBe("html");
		expect(sniffPresentKind("<html><body>")).toBe("html");
		expect(sniffPresentKind('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe("svg");
		expect(sniffPresentKind('{"a": [1, 2]}')).toBe("json");
		expect(sniffPresentKind("[link](x) and more")).toBe("markdown");
		expect(sniffPresentKind("# Findings\n\n- one")).toBe("markdown");
	});

	test("versions count every extension and the files dir", () => {
		const names = ["report-v1.html", "report-v2.md", "report-v7.files", "report-v3.pdf.bak", "reports-v9.html", "x-report-v8.html", "report-v10.txt"];
		expect(nextPresentVersion(names, "report")).toBe(11);
		expect(nextPresentVersion([], "report")).toBe(1);
	});
});

describe("references", () => {
	test("relative paths inside the folder only", () => {
		expect(normalizeAssetRef("img/a.png?v=2#x")).toBe("img/a.png");
		expect(normalizeAssetRef("./img/../img/a%20b.png")).toBe("img/a b.png");
		expect(normalizeAssetRef("../a.png", "css")).toBe("a.png");
		expect(normalizeAssetRef("theme.css", "css")).toBe("css/theme.css");
		for (const ref of ["../a.png", "/a.png", "//cdn.x/a.png", "https://x/a.png", "data:image/png;base64,AA", "#frag", "c:/x.png", "a\\b.png", "", "..", "x/../.."]) {
			expect(normalizeAssetRef(ref)).toBeUndefined();
		}
		expect(normalizeAssetRef("../../a.png", "css")).toBeUndefined();
	});

	test("what a page loads, not what it links or keeps in scripts and comments", () => {
		const html = fs.readFileSync(path.join(workspace().cwd, "report/index.html"), "utf8");
		expect(markupAssetRefs(html)).toEqual([
			"css/site.css?v=3",
			"https://cdn.example/chart.js",
			"js/app.js",
			"img/hero.png",
			"chart.png",
			"chart.png",
			"chart@2x.png",
			"../outside.png",
			"/etc/logo.png",
			"data:image/png;base64,AAAA",
			"missing.png",
		]);
		const svg = `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image href="a.png"/><use xlink:href="sprites.svg#i"/><feImage href="f.png"/><a href="x.svg">x</a><g style="fill:url(#g)"/></svg>`;
		expect(markupAssetRefs(svg)).toEqual(["a.png", "sprites.svg#i", "f.png", "#g"]);
		expect(markdownAssetRefs(`![chart](img/c.png "Chart") ![](<my file.png>) [link](doc.md) <img src='raw.png'>`)).toEqual(["img/c.png", "my file.png", "raw.png"]);
	});

	test("referenced files are copied inside the folder, within the limits", () => {
		const { cwd, root } = workspace();
		// a link inside the folder that leads out of it
		fs.symlinkSync(path.join(cwd, "outside.png"), path.join(cwd, "report/sneaky.png"));
		const html = `<img src="sneaky.png"><img src="chart.png"><link rel="stylesheet" href="css/site.css">`;
		const dest = path.join(root, "dest");
		const out = copyPresentAssets("html", html, path.join(cwd, "report"), dest);
		expect(out.copied).toEqual(["chart.png", "css/site.css", "img/bg.png", "css/theme.css", "img/h1.png"]);
		expect(out.skipped).toEqual([{ ref: "sneaky.png", reason: "outside the document's folder" }]);
		expect(fs.readFileSync(path.join(dest, "img/h1.png"), "utf8")).toBe("h1");
		expect(fs.statSync(path.join(dest, "chart.png")).mode & 0o777).toBe(0o600);
		// a file over the per-file limit is named, the rest still copied
		const big = path.join(cwd, "report/big.png");
		fs.writeFileSync(big, "");
		fs.truncateSync(big, (4 << 20) + 1);
		const out2 = copyPresentAssets("html", `<img src="big.png"><img src="chart.png">`, path.join(cwd, "report"), path.join(root, "dest2"));
		expect(out2.copied).toEqual(["chart.png"]);
		expect(out2.skipped[0]?.ref).toBe("big.png");
		expect(out2.skipped[0]?.reason).toContain("per file");
	});

	test("scanning takes time in proportion to the text: inputs that made the patterns backtrack finish at once", () => {
		// They run on omp's event loop, synchronously: each of these took seconds (and grows with
		// the square of the text up to the 4 MB limit) when a pattern could run on past where its
		// match must end (a tag past the next `<`, a URL past `(`, a comment to the end of the text).
		const cases: Array<[string, () => unknown]> = [
			["prose with `<` and no `>`", () => markupAssetRefs("if a<b then c. ".repeat(20_000))],
			["a tag's quotes run on", () => markupAssetRefs('<a "'.repeat(30_000))],
			["comments that never close", () => markupAssetRefs("<!--".repeat(40_000))],
			["CSS comments that never close", () => cssAssetRefs("/* ".repeat(50_000))],
			["url( that never closes", () => cssAssetRefs("url(".repeat(30_000))],
			["in a <style> block", () => markupAssetRefs(`<style>${"url(".repeat(30_000)}</style>`)],
			["Markdown images that never close", () => markdownAssetRefs("![](".repeat(20_000))],
			["their alt text", () => markdownAssetRefs("![".repeat(60_000))],
			["their <destination>", () => markdownAssetRefs("![](<".repeat(20_000))],
			["their (title)", () => markdownAssetRefs("![](a (".repeat(30_000))],
		];
		for (const [what, scan] of cases) {
			const started = performance.now();
			scan();
			expect([what, performance.now() - started < 300]).toEqual([what, true]);
		}
		// The whole call too.
		const started = performance.now();
		presentArtifact({ title: "Notes", content: `<!doctype html><p>${"if a<b then c. ".repeat(20_000)}</p>` }, workspace().env);
		expect(performance.now() - started).toBeLessThan(500);
	});

	test("references in a page whose patterns had to be tightened still count", () => {
		expect(markupAssetRefs(`<p>a < b</p><img alt="1 < 2 > 0" src="x.png"><img src='y.png' alt='<'>`)).toEqual(["x.png", "y.png"]);
		expect(cssAssetRefs(`a { background: url(img/a.png) } b { background: url( "img/b.png" ) } /* url(c.png) */ c { x: url(d.png) }`)).toEqual(["img/a.png", "img/b.png", "d.png"]);
		expect(markupAssetRefs(`<!-- <img src="gone.png"> --><img src="kept.png"><!-- unclosed <img src="late.png">`)).toEqual(["kept.png", "late.png"]);
		expect(markdownAssetRefs(`![a](a.png) ![b](<b c.png> "B") ![c](c.png 'C') ![d](d.png (D)) ![](e.png)`)).toEqual(["a.png", "b c.png", "c.png", "d.png", "e.png"]);
	});
});

describe("presentArtifact", () => {
	test("an HTML report: snapshot, its files, versions", () => {
		const { cwd, localRoot, env } = workspace();
		const first = presentArtifact({ title: "Q3 report", path: "report/index.html" }, env);
		const d: PresentDetails = first.details;
		expect(d).toMatchObject({ title: "Q3 report", kind: "html", name: "presented/q3-report-v1.html", url: "local://presented/q3-report-v1.html", slug: "q3-report", version: 1, source: "report/index.html" });
		expect(d.size).toBe(fs.statSync(path.join(cwd, "report/index.html")).size);
		const files = path.join(localRoot, "presented/q3-report-v1.files");
		for (const f of ["css/site.css", "css/theme.css", "img/bg.png", "img/h1.png", "img/hero.png", "js/app.js", "chart.png", "chart@2x.png"]) {
			expect(fs.existsSync(path.join(files, f))).toBe(true);
		}
		expect(d.assets).toBe(8);
		expect(d.skipped?.map((s) => s.ref)).toEqual(["https://cdn.example/chart.js", "../outside.png", "/etc/logo.png", "missing.png"]);
		expect(d.skipped?.[0]?.reason).toContain("no network access");
		expect(fs.existsSync(path.join(files, "../outside.png"))).toBe(false);
		const snap = path.join(localRoot, "presented/q3-report-v1.html");
		expect(fs.statSync(snap).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.join(localRoot, "presented")).mode & 0o777).toBe(0o700);
		expect(first.text.split("\n")[0]).toBe('Presented "Q3 report" (html, version 1) to the user: local://presented/q3-report-v1.html');
		expect(first.text).toContain("Included 8 referenced files");
		expect(first.text).toContain("Not included: https://cdn.example/chart.js (external URL");

		// The page changes; presenting it again under the same title adds version 2, version 1 stays.
		const before = fs.readFileSync(snap, "utf8");
		put(path.join(cwd, "report/index.html"), "<!doctype html><p>v2</p>");
		const second = presentArtifact({ title: "Q3 report", path: path.join(cwd, "report/index.html") }, env);
		expect(second.details).toMatchObject({ name: "presented/q3-report-v2.html", version: 2, assets: 0 });
		expect(second.details.skipped).toBeUndefined();
		expect(fs.readFileSync(snap, "utf8")).toBe(before);
		// Another document under that title (another kind) is the next version too.
		const third = presentArtifact({ title: "Q3 Report", content: "# Q3\n\nNotes." }, env);
		expect(third.details).toMatchObject({ kind: "markdown", name: "presented/q3-report-v3.md", version: 3 });
		expect(third.details.source).toBeUndefined();
	});

	test("inline content: kinds, extensions, languages", () => {
		const { env, localRoot } = workspace();
		expect(presentArtifact({ title: "Data", content: '{"a":1}' }, env).details).toMatchObject({ kind: "json", name: "presented/data-v1.json" });
		expect(presentArtifact({ title: "Logo", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" }, env).details).toMatchObject({ kind: "svg", name: "presented/logo-v1.svg" });
		expect(presentArtifact({ title: "Fix", content: "fn main() {}", kind: "code", language: "Rust" }, env).details).toMatchObject({ kind: "code", language: "rust", name: "presented/fix-v1.rs" });
		expect(presentArtifact({ title: "Table", content: "a,b\n1,2", kind: "csv" }, env).details).toMatchObject({ kind: "csv", name: "presented/table-v1.csv" });
		expect(presentArtifact({ title: "Log", content: "plain", kind: "text" }, env).details).toMatchObject({ kind: "text", name: "presented/log-v1.txt" });
		expect(fs.readFileSync(path.join(localRoot, "presented/fix-v1.rs"), "utf8")).toBe("fn main() {}");
		// inline HTML resolves its references against the session's working directory
		const page = presentArtifact({ title: "Inline page", content: '<!doctype html><img src="report/chart.png">' }, env);
		expect(page.details).toMatchObject({ kind: "html", assets: 1 });
		expect(fs.existsSync(path.join(localRoot, "presented/inline-page-v1.files/report/chart.png"))).toBe(true);
	});

	test("files: local://, code languages, images", () => {
		const { cwd, localRoot, env } = workspace();
		put(path.join(localRoot, "notes/plan.md"), "# Plan");
		expect(presentArtifact({ title: "Plan", path: "local://notes/plan.md" }, env).details).toMatchObject({ kind: "markdown", source: "local://notes/plan.md" });
		put(path.join(cwd, "src/main.rs"), "fn main() {}");
		expect(presentArtifact({ title: "Main", path: "src/main.rs" }, env).details).toMatchObject({ kind: "code", language: "rust", name: "presented/main-v1.rs" });
		const shot = presentArtifact({ title: "Chart", path: "report/chart.png" }, env).details;
		expect(shot).toMatchObject({ kind: "image", name: "presented/chart-v1.png", size: 6, assets: 0 });
		expect(fs.readFileSync(path.join(localRoot, shot.name))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
		// an unknown extension with text in it is text
		put(path.join(cwd, "NOTES"), "hello");
		expect(presentArtifact({ title: "Notes", path: "NOTES" }, env).details).toMatchObject({ kind: "text", name: "presented/notes-v1.txt" });
	});

	test("arguments the agent has to fix", () => {
		const { cwd, env } = workspace();
		put(path.join(cwd, "bin.dat"), new Uint8Array([0xff, 0xfe, 0, 1]));
		put(path.join(cwd, "notes.txt"), "x");
		const big = path.join(cwd, "big.html");
		fs.writeFileSync(big, "");
		fs.truncateSync(big, PRESENT_TEXT_MAX + 1);
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ path: "notes.txt" }, "`title` is required"],
			[{ title: " ", path: "notes.txt" }, "`title` is required"],
			[{ title: "x".repeat(201), path: "notes.txt" }, "under 200"],
			[{ title: "T" }, "exactly one of"],
			[{ title: "T", path: "notes.txt", content: "x" }, "exactly one of"],
			[{ title: "T", path: "nope.html" }, "nope.html: no such file"],
			[{ title: "T", path: "report" }, "report: not a file"],
			[{ title: "T", path: "big.html" }, "at most 4 MB"],
			[{ title: "T", path: "bin.dat" }, "not UTF-8 text"],
			[{ title: "T", path: "notes.txt", kind: "image" }, "an image must be a png"],
			[{ title: "T", content: "abc", kind: "image" }, "An image needs `path`"],
			[{ title: "T", content: "abc", kind: "pdf" }, "`kind` must be one of"],
			[{ title: "T", content: "  " }, "`content` is empty"],
			[{ title: "T", path: "local://../escape.md" }, "not a file in the session's local:// root"],
		];
		for (const [input, message] of cases) {
			let error: unknown;
			try {
				presentArtifact(input, env);
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(PresentError);
			expect(String((error as Error).message)).toContain(message);
		}
		expect(fs.existsSync(path.join(env.localRoot, "presented/t-v1.html"))).toBe(false);
	});

	test("an unlinked session says when the user will see it", () => {
		const { env } = workspace();
		const out = presentArtifact({ title: "T", content: "# x" }, { ...env, linked: false });
		expect(out.text).toContain("TeleFlock is not connected to this session right now");
	});

	test("a page with thousands of missing references: the result names the first 50 and counts them all", () => {
		const { env } = workspace();
		const page = `<!doctype html>${Array.from({ length: 3_000 }, (_, i) => `<img src="https://cdn.example/${i}.png">`).join("")}`;
		const started = performance.now();
		const out = presentArtifact({ title: "Gallery", content: page }, env);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(out.details.skipped).toHaveLength(50);
		expect(out.details.skipped?.[49]?.ref).toBe("https://cdn.example/49.png");
		expect(out.details.skippedCount).toBe(3_000);
		expect(out.text).toContain("; and 2990 more.");
		// Fewer: all of them, no count.
		const few = presentArtifact({ title: "Two", content: '<!doctype html><img src="//cdn.example/a.png"><img src="/b.png">' }, env);
		expect(few.details.skipped).toHaveLength(2);
		expect(few.details.skippedCount).toBeUndefined();
	});

	test("languages, extensions and entities named like Object's own members are none", () => {
		const { cwd, env } = workspace();
		for (const language of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			const d = presentArtifact({ title: `Lang ${language}`, content: "x = 1", kind: "code", language }, env).details;
			expect(d.name).toMatch(/^presented\/lang-[a-z-]+-v1\.txt$/);
		}
		for (const ext of ["constructor", "__proto__", "valueOf"]) {
			put(path.join(cwd, `notes.${ext}`), "plain notes");
			const d = presentArtifact({ title: `Ext ${ext}`, path: `notes.${ext}` }, env).details;
			expect([d.kind, d.language, d.name.endsWith(".txt")]).toEqual(["text", undefined, true]);
		}
		expect(markupAssetRefs(`<img src="&constructor;.png"><img src="&__proto__;b.png"><img src="&amp;c.png">`)).toEqual(["&constructor;.png", "&__proto__;b.png", "&c.png"]);
	});
});

describe("the session's local:// root", () => {
	test("omp's resolveLocalRoot", () => {
		const opts = { getArtifactsDir: () => "/s/-w/2026_S1", getSessionId: () => "S1" };
		const sm = { getArtifactsDir: () => "/other", getSessionId: () => "other" };
		expect(presentLocalRoot({ localProtocolOptions: opts, sessionManager: sm, cwd: "/w" }, "linux")).toBe("/s/-w/2026_S1/local");
		expect(presentLocalRoot({ sessionManager: sm, cwd: "/w" }, "linux")).toBe("/other/local");
		// no artifacts dir (a session not on disk): omp's temp root
		expect(presentLocalRoot({ localProtocolOptions: { getArtifactsDir: () => null, getSessionId: () => "a/b c" }, cwd: "/w" }, "linux")).toBe(path.join(os.tmpdir(), "omp-local", "a_b_c"));
		// Windows: a long root moves to %TEMP%
		const long = `C:\\${"d".repeat(200)}`;
		expect(presentLocalRoot({ localProtocolOptions: { getArtifactsDir: () => long, getSessionId: () => "S1" }, cwd: "/w" }, "win32")).toBe(path.join(os.tmpdir(), "omp-local", "S1"));
		expect(presentLocalRoot(undefined, "linux")).toBe(path.join(os.tmpdir(), "omp-local", "session"));
	});
});

describe("registration", () => {
	/** The slice of omp's zod the tool uses: records what was built. */
	function fakeZod() {
		const field = (type: string, extra: Record<string, unknown> = {}) => {
			const f: Record<string, unknown> = { type, ...extra };
			f.optional = () => ((f.optional_ = true), f);
			f.describe = (text: string) => ((f.description = text), f);
			return f;
		};
		return { object: (shape: Record<string, unknown>) => ({ type: "object", shape }), string: () => field("string"), enum: (values: readonly string[]) => field("enum", { values }) };
	}

	test("omp sees an essential tool that snapshots into the calling session", async () => {
		const { cwd, root } = workspace();
		const tools: Array<Record<string, unknown>> = [];
		let linked = false;
		const pi = { zod: fakeZod(), registerTool: (t: Record<string, unknown>) => tools.push(t) };
		expect(registerPresentTool(pi as never, () => linked)).toBe(true);
		const tool = tools[0]!;
		expect([tool.name, tool.label, tool.loadMode]).toEqual(["present", "Present", "essential"]);
		expect(String(tool.description)).toContain("sandboxed without network access");
		const shape = (tool.parameters as { shape: Record<string, Record<string, unknown>> }).shape;
		expect(Object.keys(shape)).toEqual(["title", "path", "content", "kind", "language"]);
		expect(shape.title?.optional_).toBeUndefined();
		expect(shape.kind?.values).toEqual(["html", "markdown", "svg", "image", "code", "csv", "json", "text"]);
		const artifacts = path.join(root, "sessions/2026_S1");
		const ctx = { cwd, sessionManager: { getArtifactsDir: () => artifacts, getSessionId: () => "S1" } };
		const execute = tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: PresentDetails }>;
		// omp's order (toolCallId, params, signal, onUpdate, ctx) and the older (…, onUpdate, ctx, signal)
		const a = await execute("c1", { title: "Q3 report", path: "report/index.html" }, undefined, undefined, ctx);
		expect(a.details.name).toBe("presented/q3-report-v1.html");
		expect(fs.existsSync(path.join(artifacts, "local/presented/q3-report-v1.html"))).toBe(true);
		expect(a.content[0]?.text).toContain("not connected");
		linked = true;
		const b = await execute("c2", { title: "Q3 report", content: "# v2" }, undefined, ctx, undefined);
		expect(b.details.version).toBe(2);
		expect(b.content[0]?.text).not.toContain("not connected");
		await expect(execute("c3", { title: "Q3 report" }, undefined, undefined, ctx)).rejects.toBeInstanceOf(PresentError);
	});

	test("an omp without the schema builder gets no tool", () => {
		const tools: unknown[] = [];
		expect(registerPresentTool({ registerTool: (t: unknown) => tools.push(t) } as never, () => true)).toBe(false);
		expect(tools).toEqual([]);
	});
});
