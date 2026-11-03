import type { PresentKind, PresentedArtifact } from "@/core/gen";
import { written } from "./richContent";
import { DATA_FOLDER_PNG } from "./screenshots";
import { bash, say, type Step, think } from "./scripts";

/*
 * The docs session's presented artifacts (the bridge's `present` tool, bridge ≥ 2.3.0,
 * docs/bridge-protocol.md "Bridge 2.3.0"): migration notes (Markdown) and a Q3 revenue report (HTML),
 * two versions each. One table drives both sides: the transcript's finished `present` rows
 * (`ToolItem.artifact`, the bridge's result text) and the snapshots the bridge writes into the
 * session's `local://` root, `presented/<slug>-v<n>.<ext>` with the files a document references
 * copied to `presented/<slug>-v<n>.files/`, which ./insight lists and reads for the rows a session
 * has (present.test.ts keeps them in step).
 */

interface PresentedDoc {
  title: string;
  kind: "html" | "markdown";
  version: number;
  /** The file the agent presented: `args.path` as it named it (the bridge resolves it against its working directory, `~` to its home). */
  source: string;
  text: string;
  /** The files the document loads, by their path relative to it (what the bridge copies): text, or an image's bytes. */
  assets: Record<string, string | Uint8Array>;
}

// ── migration notes ──

const NOTES = `# Migration notes

**Session cache → schema v2.** For anyone touching \`src/core/cache.ts\`, and for installs that still hold entries written before 0.6.

## What changes

- Every entry carries \`schema: 2\`. Entries without it are migrated once, the first time they are read.
- One record per host replaces the single JSON blob, so a corrupt entry no longer drops the whole cache.
- Writes are batched: at most one flush per second instead of one per event.
- Tests import \`CACHE_SCHEMA\` from \`src/core/cache.ts\`; \`cacheVersion\` is gone.

## Field mapping

| Before (unversioned) | Schema v2 | Notes |
|---|---|---|
| \`entries[hostId]\` | \`hosts/<hostId>\` | one record per host |
| \`entries[hostId].agents\` | \`agents\` | same shape |
| \`lastSeen\` (seconds) | \`seenAt\` (milliseconds) | converted when migrated |
| \`pins\` (agent names) | \`pins\` (agent keys) | \`host::agent\` |
| none | \`schema\` | always \`2\` |

## Running it

The app migrates on start. To see what would change first:

\`\`\`ts
import { migrateCache } from "@/core/cache";

const report = await migrateCache({ dryRun: true });
console.table(report.hosts); // what each host's entries become
await migrateCache(); // old blob kept as cache.v1.json
\`\`\`

## How a read goes

\`\`\`mermaid
flowchart LR
  read([Read entry]) --> check{schema?}
  check -->|2| use[Use it]
  check -->|missing| migrate[Migrate to v2]
  migrate --> save[Write the host record]
  save --> use
  check -->|newer| keep[Leave it alone]
\`\`\`

## Where it sits

![Architecture](architecture.svg)

tf-client fills the cache from each host's snapshots; the board reads it on start, before any host has answered.
`;

const ROLLBACK = `
## Rollback

If a build with schema v2 misbehaves, go back without losing anything the hosts still know:

1. Quit TeleFlock on every device that ran the new build.
2. Install the previous build.
3. Put the old blob back in the data folder; the migration kept it as \`cache.v1.json\`.

The data folder is listed in **Settings → About** (Open shows it in the file manager):

![Settings → About: the data folder](data-folder.png)

\`\`\`sh
cd ~/.local/share/teleflock  # Settings → About
mv cache.v1.json cache.json
rm -r hosts
\`\`\`

Entries written since the upgrade are dropped; the first connection to each host fills them in again.
`;

const DATA_FOLDER_BYTES = Uint8Array.from(atob(DATA_FOLDER_PNG), (c) => c.charCodeAt(0));

const ARCHITECTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 250" width="800" height="250" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0 10 5 0 10z" fill="#64748b"/>
    </marker>
  </defs>
  <rect width="800" height="250" rx="18" fill="#f8fafc"/>
  <text x="24" y="36" font-size="15" font-weight="700" fill="#0f172a">Where the session cache sits</text>
  <g fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5">
    <rect x="24" y="58" width="128" height="64" rx="12"/>
    <rect x="232" y="58" width="140" height="64" rx="12"/>
    <rect x="680" y="58" width="96" height="64" rx="12"/>
    <rect x="452" y="150" width="164" height="30" rx="8"/>
    <rect x="452" y="188" width="164" height="30" rx="8"/>
  </g>
  <rect x="452" y="58" width="164" height="64" rx="12" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <rect x="232" y="150" width="140" height="68" rx="12" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5 4"/>
  <g text-anchor="middle" font-size="14" font-weight="600" fill="#0f172a">
    <text x="88" y="86">tf-hostd</text>
    <text x="302" y="86">tf-client</text>
    <text x="534" y="86">Session cache</text>
    <text x="728" y="86">Board</text>
    <text x="302" y="179" fill="#475569">cache.v1.json</text>
  </g>
  <g text-anchor="middle" font-size="12" fill="#64748b">
    <text x="88" y="106">one per host</text>
    <text x="302" y="106">sync, reconnect</text>
    <text x="534" y="106">schema v2</text>
    <text x="728" y="106">reads on start</text>
    <text x="302" y="199">kept for rollback</text>
  </g>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#334155">
    <text x="466" y="169">hosts/forge</text>
    <text x="466" y="207">hosts/studio-pc</text>
  </g>
  <g fill="none" stroke="#64748b" stroke-width="1.5">
    <path d="M152 90H226" marker-end="url(#arrow)"/>
    <path d="M372 90H446" marker-end="url(#arrow)"/>
    <path d="M616 90H674" marker-end="url(#arrow)"/>
    <path d="M534 122V150"/>
    <path d="M372 165H446" stroke="#94a3b8" stroke-dasharray="5 4" marker-end="url(#arrow)"/>
  </g>
  <g text-anchor="middle" font-size="11" fill="#475569">
    <text x="192" y="81">snapshots</text>
    <text x="412" y="81">writes</text>
    <text x="648" y="81">reads</text>
    <text x="409" y="156">migrated</text>
  </g>
</svg>
`;

// ── Q3 revenue report ──

/** The Acme report kit the page links: page background (a grid tile next to it), cards, links. */
const REPORT_CSS = `/* Acme report kit: page background, cards, links. */
html {
  background: #f5f6fa url(grid.svg);
  background-size: 24px 24px;
}
body {
  -webkit-font-smoothing: antialiased;
}
.card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  box-shadow: 0 1px 2px rgb(17 24 39 / 0.04), 0 10px 28px -18px rgb(17 24 39 / 0.25);
}
a {
  color: #4f46e5;
  font-weight: 600;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
a:hover {
  color: #3730a3;
}
::selection {
  background: #c7d2fe;
}
`;

const GRID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M24 .5H.5V24" fill="none" stroke="#e8eaf2"/></svg>
`;

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="acme" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#0ea5e9"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#acme)"/>
  <path d="M19 47 32 16l13 31M24.5 37h15" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const REGION_SECTION = `

  <section class="card">
    <div class="head"><h2>By region</h2><span class="sub">billing country of the account</span></div>
    <div class="scroll">
      <table>
        <thead><tr><th>Region</th><th>Customers</th><th>Q2</th><th>Q3</th><th>Change</th><th>Share of Q3</th></tr></thead>
        <tbody>
          <tr><td>Americas</td><td>1,912</td><td>$2,288k</td><td>$2,603k</td><td class="good">+13.8%</td><td>54.0%<span class="bar"><b style="width:54%"></b></span></td></tr>
          <tr><td>EMEA</td><td>1,140</td><td>$1,266k</td><td>$1,494k</td><td class="good">+18.0%</td><td>31.0%<span class="bar"><b style="width:31%"></b></span></td></tr>
          <tr><td>APAC</td><td>486</td><td>$531k</td><td>$723k</td><td class="good">+36.2%</td><td>15.0%<span class="bar"><b style="width:15%"></b></span></td></tr>
        </tbody>
        <tfoot><tr><td>Total</td><td>3,538</td><td>$4,085k</td><td>$4,820k</td><td class="good">+18.0%</td><td>100%</td></tr></tfoot>
      </table>
    </div>
    <p class="note">APAC grew fastest after the Singapore region opened in July; the Americas are still more than half of revenue.</p>
  </section>`;

/**
 * The report page: KPI tiles, a bar chart its own script draws on a canvas, the plan table, the
 * Acme kit's stylesheet and logo by relative path, an external link, and a line its script fills
 * with what the sandbox let it do. `regions`: version 2, with the regional breakdown and Q2 next
 * to Q3 in the chart.
 */
function reportPage(regions: boolean): string {
  const q3 = `{ name: "Q3", color: "#4f46e5", values: [412, 1268, 1734, 1406] }`;
  const series = regions ? `[{ name: "Q2", color: "#c7d2fe", values: [389, 1102, 1451, 1143] }, ${q3}]` : `[${q3}]`;
  const chartLabel = regions
    ? "Revenue by plan, Q2 and Q3: Starter $389k and $412k, Team $1.10M and $1.27M, Business $1.45M and $1.73M, Enterprise $1.14M and $1.41M"
    : "Q3 revenue by plan: Starter $412k, Team $1.27M, Business $1.73M, Enterprise $1.41M";
  const legend = regions ? `\n      <div class="legend"><span><i style="background:#c7d2fe"></i>Q2</span><span><i style="background:#4f46e5"></i>Q3</span></div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Q3 revenue report</title>
<link rel="stylesheet" href="report.css">
<style>
  :root { --ink: #111827; --ink-2: #374151; --mute: #6b7280; --line: #e5e7eb; --accent: #4f46e5; --good: #047857; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 24px 40px; }
  .top { display: flex; align-items: center; gap: 16px; }
  .top img { flex: none; border-radius: 13px; box-shadow: 0 8px 20px -10px rgb(79 70 229 / 0.7); }
  .eyebrow { margin: 0; color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  h1 { margin: 2px 0 0; font-size: 30px; line-height: 1.15; letter-spacing: -0.02em; }
  .sub { margin: 4px 0 0; color: var(--mute); font-size: 14px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 28px; }
  .kpi { padding: 14px 16px; }
  .label { color: var(--mute); font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
  .value { margin-top: 2px; font-size: 28px; font-weight: 750; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
  .delta { font-size: 13px; font-weight: 650; }
  .good { color: var(--good); }
  section { margin-top: 16px; padding: 20px 22px; }
  h2 { margin: 0; font-size: 17px; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; margin-bottom: 12px; }
  .legend { display: flex; gap: 14px; color: var(--ink-2); font-size: 13px; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 3px; vertical-align: -1px; }
  canvas { display: block; width: 100%; height: 280px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--mute); font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
  tfoot td { border-bottom: 0; font-weight: 700; }
  .bar { display: inline-block; width: 64px; height: 6px; margin-left: 10px; border-radius: 3px; background: var(--line); vertical-align: middle; overflow: hidden; }
  .bar b { display: block; height: 100%; background: var(--accent); }
  .note { margin: 14px 0 0; color: var(--ink-2); }
  footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; margin-top: 20px; color: var(--mute); font-size: 13px; }
  .sandbox { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  @media (max-width: 560px) {
    main { padding: 20px 14px 32px; }
    h1 { font-size: 24px; }
    .value { font-size: 24px; }
    section { padding: 16px 14px; }
    th, td { padding: 9px 6px; }
    /* customers and share: the columns a phone leaves out */
    th:nth-child(2), td:nth-child(2), th:nth-child(6), td:nth-child(6) { display: none; }
  }
</style>
</head>
<body>
<main>
  <header class="top">
    <img src="logo.svg" alt="Acme" width="52" height="52">
    <div>
      <p class="eyebrow">Acme Cloud · Finance</p>
      <h1>Q3 revenue report</h1>
      <p class="sub">July–September 2026 · recognised revenue in USD</p>
    </div>
  </header>

  <div class="kpis">
    <div class="card kpi"><div class="label">Revenue</div><div class="value">$4.82M</div><div class="delta good">▲ 18.0% vs Q2</div></div>
    <div class="card kpi"><div class="label">Exit ARR</div><div class="value">$20.4M</div><div class="delta good">▲ 20.9% vs June</div></div>
    <div class="card kpi"><div class="label">Net retention</div><div class="value">116%</div><div class="delta good">▲ 3 pts</div></div>
    <div class="card kpi"><div class="label">Logo churn</div><div class="value">1.7%</div><div class="delta good">▼ 0.4 pts</div></div>
  </div>

  <section class="card">
    <div class="head">
      <h2>Revenue by plan</h2>${legend}
    </div>
    <canvas id="chart" role="img" aria-label="${chartLabel}"></canvas>
  </section>

  <section class="card">
    <div class="head"><h2>By plan</h2><span class="sub">the account's plan at the end of each quarter</span></div>
    <div class="scroll">
      <table>
        <thead><tr><th>Plan</th><th>Customers</th><th>Q2</th><th>Q3</th><th>Change</th><th>Share of Q3</th></tr></thead>
        <tbody>
          <tr><td>Starter</td><td>2,140</td><td>$389k</td><td>$412k</td><td class="good">+5.9%</td><td>8.5%<span class="bar"><b style="width:8.5%"></b></span></td></tr>
          <tr><td>Team</td><td>1,024</td><td>$1,102k</td><td>$1,268k</td><td class="good">+15.1%</td><td>26.3%<span class="bar"><b style="width:26.3%"></b></span></td></tr>
          <tr><td>Business</td><td>318</td><td>$1,451k</td><td>$1,734k</td><td class="good">+19.5%</td><td>36.0%<span class="bar"><b style="width:36%"></b></span></td></tr>
          <tr><td>Enterprise</td><td>56</td><td>$1,143k</td><td>$1,406k</td><td class="good">+23.0%</td><td>29.2%<span class="bar"><b style="width:29.2%"></b></span></td></tr>
        </tbody>
        <tfoot><tr><td>Total</td><td>3,538</td><td>$4,085k</td><td>$4,820k</td><td class="good">+18.0%</td><td>100%</td></tr></tfoot>
      </table>
    </div>
  </section>${regions ? REGION_SECTION : ""}

  <footer>
    <span>Source: q3-revenue.csv (4,217 invoice lines) and q2-revenue.csv. Line items: <a href="https://example.com/q3">full ledger</a>.</span>
    <span class="sandbox" id="sandbox">Sandbox: checking…</span>
  </footer>
</main>
<script>
  (function () {
    var plans = ["Starter", "Team", "Business", "Enterprise"];
    var series = ${series};
    var canvas = document.getElementById("chart");

    function money(k) {
      return k >= 1000 ? "$" + (k / 1000).toFixed(2) + "M" : "$" + k + "k";
    }

    function draw() {
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.clientWidth;
      var h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      var g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      var left = 52, right = 8, top = 22, bottom = 30, max = 2000;
      var plotW = w - left - right;
      var plotH = h - top - bottom;
      g.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
      g.textBaseline = "middle";
      for (var v = 0; v <= max; v += 500) {
        var y = Math.round(top + plotH - (v / max) * plotH) + 0.5;
        g.strokeStyle = v === 0 ? "#cbd5e1" : "#eef0f4";
        g.beginPath();
        g.moveTo(left, y);
        g.lineTo(w - right, y);
        g.stroke();
        g.fillStyle = "#6b7280";
        g.textAlign = "right";
        g.fillText(v === 0 ? "$0" : "$" + (v / 1000).toFixed(1) + "M", left - 10, y);
      }
      var slot = plotW / plans.length;
      var gap = 6;
      var bar = Math.min(44, (slot * 0.64 - gap * (series.length - 1)) / series.length);
      var group = bar * series.length + gap * (series.length - 1);
      plans.forEach(function (plan, i) {
        var x0 = left + slot * i + (slot - group) / 2;
        series.forEach(function (s, j) {
          var value = s.values[i];
          var bh = (value / max) * plotH;
          var x = x0 + j * (bar + gap);
          var y = top + plotH - bh;
          var r = Math.min(6, bar / 2, bh);
          g.fillStyle = s.color;
          g.beginPath();
          g.moveTo(x, top + plotH);
          g.lineTo(x, y + r);
          g.quadraticCurveTo(x, y, x + r, y);
          g.lineTo(x + bar - r, y);
          g.quadraticCurveTo(x + bar, y, x + bar, y + r);
          g.lineTo(x + bar, top + plotH);
          g.closePath();
          g.fill();
          if (j === series.length - 1) {
            g.fillStyle = "#111827";
            g.textAlign = "center";
            g.fillText(money(value), x + bar / 2, y - 10);
          }
        });
        g.fillStyle = "#374151";
        g.textAlign = "center";
        g.fillText(plan, left + slot * i + slot / 2, h - bottom / 2 + 2);
      });
    }

    draw();
    window.addEventListener("resize", draw);

    // What the sandbox allows: no network, no reaching into the page that shows this one.
    var out = document.getElementById("sandbox");
    var network = "Network access: checking…";
    var parentPage;
    try {
      parentPage = parent === window ? "Parent page: none (opened on its own)" : parent.document ? "Parent page: reachable" : "Parent page: not reachable";
    } catch (err) {
      parentPage = err && err.name === "SecurityError" ? "Parent page: not reachable" : "Parent page: " + err;
    }
    function show() {
      out.textContent = "Sandbox · " + network + " · " + parentPage;
    }
    show();
    fetch("https://example.com/telemetry", { mode: "no-cors" }).then(
      function () {
        network = "Network access: allowed";
        show();
      },
      function () {
        network = "Network access: blocked";
        show();
      }
    );
  })();
</script>
</body>
</html>
`;
}

const PLAN_TOTALS = [
  "┌────────────┬───────┬───────┬───────┬───────┐",
  "│    plan    │ Q2_k  │ Q2_n  │ Q3_k  │ Q3_n  │",
  "│  varchar   │ int32 │ int64 │ int32 │ int64 │",
  "├────────────┼───────┼───────┼───────┼───────┤",
  "│ Starter    │   389 │  2071 │   412 │  2140 │",
  "│ Team       │  1102 │   951 │  1268 │  1024 │",
  "│ Enterprise │  1143 │    49 │  1406 │    56 │",
  "│ Business   │  1451 │   289 │  1734 │   318 │",
  "└────────────┴───────┴───────┴───────┴───────┘",
];

const REGION_TOTALS = [
  "┌──────────┬───────┬───────┬───────┬───────┐",
  "│  region  │ Q2_k  │ Q2_n  │ Q3_k  │ Q3_n  │",
  "│ varchar  │ int32 │ int64 │ int32 │ int64 │",
  "├──────────┼───────┼───────┼───────┼───────┤",
  "│ Americas │  2288 │  1846 │  2603 │  1912 │",
  "│ EMEA     │  1266 │  1088 │  1494 │  1140 │",
  "│ APAC     │   531 │   426 │   723 │   486 │",
  "└──────────┴───────┴───────┴───────┴───────┘",
];

const pivot = (by: string, order: string) =>
  `cd ~/finance && duckdb -c "PIVOT read_csv(['q2-revenue.csv', 'q3-revenue.csv']) ON quarter USING (sum(amount_usd) // 1000)::INT AS k, count(DISTINCT customer) AS n GROUP BY ${by} ORDER BY ${order}"`;

// ── the table ──

const NOTES_1: PresentedDoc = { title: "Migration notes", kind: "markdown", version: 1, source: "docs/migration-notes.md", text: NOTES, assets: { "architecture.svg": ARCHITECTURE_SVG } };
const NOTES_2: PresentedDoc = { ...NOTES_1, version: 2, text: NOTES + ROLLBACK, assets: { ...NOTES_1.assets, "data-folder.png": DATA_FOLDER_BYTES } };
const REPORT_1: PresentedDoc = {
  title: "Q3 revenue report",
  kind: "html",
  version: 1,
  source: "~/finance/q3-report/index.html",
  text: reportPage(false),
  assets: { "report.css": REPORT_CSS, "logo.svg": LOGO_SVG, "grid.svg": GRID_SVG },
};
const REPORT_2: PresentedDoc = { ...REPORT_1, version: 2, text: reportPage(true) };
const PRESENTED = [NOTES_1, NOTES_2, REPORT_1, REPORT_2];

/** Where the bridge snapshots `doc`: `presented/<slug>-v<n>.<ext>`, the slug its `presentSlug` of these ASCII titles. */
function snapshotOf(doc: PresentedDoc): { slug: string; name: string } {
  const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return { slug, name: `presented/${slug}-v${doc.version}.${doc.kind === "html" ? "html" : "md"}` };
}

const utf8 = new TextEncoder();

/** A finished `present` call as hostd's replica types it: the bridge's result text and `details`. */
function presentStep(doc: PresentedDoc): Step {
  const { slug, name } = snapshotOf(doc);
  const assets = Object.values(doc.assets);
  const assetBytes = assets.reduce((n, body) => n + (typeof body === "string" ? utf8.encode(body).length : body.length), 0);
  const artifact: PresentedArtifact = { title: doc.title, kind: doc.kind, name, url: `local://${name}`, slug, version: doc.version, size: utf8.encode(doc.text).length, source: doc.source, assets: assets.length };
  const output = [`Presented "${doc.title}" (${doc.kind}, version ${doc.version}) to the user: ${artifact.url}`];
  if (assets.length) output.push(`Included ${assets.length} referenced file${assets.length === 1 ? "" : "s"} (${Math.ceil(assetBytes / 1024)} KB).`);
  return { t: "tool", spec: { tool: "present", title: doc.title, args: { title: doc.title, path: doc.source }, ms: 240, output, artifact } };
}

/** The files the snapshot `name` stands for in the session's `local://` root: itself, then the files it references. */
export function presentedFiles(name: string): { name: string; body: string | Uint8Array }[] {
  const report = /^presented\/board-test-report-v(\d+)\.md$/.exec(name);
  if (report) return [{ name, body: boardReport(Number(report[1])) }];
  const doc = PRESENTED.find((d) => snapshotOf(d).name === name);
  if (!doc) return [];
  const dir = `${name.slice(0, name.lastIndexOf("."))}.files`;
  return [{ name, body: doc.text }, ...Object.entries(doc.assets).map(([path, body]) => ({ name: `${dir}/${path}`, body }))];
}

/** How a notification names a presented document's kind (tf-hostd's `presented_notification`). */
export const PRESENT_KIND_WORD: Record<PresentKind, string> = {
  html: "HTML page",
  markdown: "Markdown",
  svg: "SVG",
  image: "Image",
  code: "Code",
  csv: "Table",
  json: "JSON",
  text: "Text",
};

// ── board test report: presented live, now and then ──

/** Version `version` of the board's test report: each run a little longer and still green. */
function boardReport(version: number): string {
  const tests = 40 + 3 * (version - 1);
  const rows = ["Keyboard moves", "Card flights", "a11y announcements", "Reduced motion", "Persistence"].map((area, i) => `| ${area} | ${8 + ((i + version) % 3)} | ✓ |`);
  return `# Board test report\n\n**Run ${version}:** ${tests} tests, all passing, in ${(6.1 + version * 0.2).toFixed(1)} s.\n\n| Area | Tests | Status |\n|---|---|---|\n${rows.join("\n")}\n\n${version > 1 ? `Since run ${version - 1}: three more keyboard edge cases (Shift+J at a lane's end, an empty lane, a collapsed lane).\n` : "Every lane change animates; reduced motion cross-fades instead.\n"}`;
}

/** A running agent writes the board's test results up and presents them (`present`, version `version`): the live call the demo notifies about. */
export function boardReportSteps(version: number): Step[] {
  const doc: PresentedDoc = { title: "Board test report", kind: "markdown", version, source: "docs/board-test-report.md", text: boardReport(version), assets: {} };
  return [
    written(doc.source, doc.text, "markdown"),
    presentStep(doc),
    say(version > 1 ? `Version ${version} of the test report is in the card above, with the latest run.` : "The test report is in the card above: every area, all green."),
  ];
}

/** An edit call that adds `added` at the end of `path` (`before`: the file so far), as omp's replica shows it. */
function appended(path: string, before: string, added: string, lang: string): Step {
  const after = before.replace(/\n$/, "").split("\n").length;
  const lines = added.replace(/\n$/, "").split("\n");
  const patch = `--- a/${path}\n+++ b/${path}\n@@ -${after},0 +${after + 1},${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
  return { t: "tool", spec: { tool: "edit", title: path, args: { path }, ms: 600, view: { type: "diff", files: [{ path, patch, added: lines.length, removed: 0, status: "modified", lang }] } } };
}

/** The docs session writes migration notes and presents them, then again with a rollback section. */
export function migrationNotesSteps(): Step[] {
  return [
    { t: "user", text: "Before the PR goes up, write migration notes for the session cache change and show them to me here." },
    think("Migration notes: what changes, the field mapping, how to run it, and the read path as a flowchart so the version check is obvious. The architecture drawing goes next to the notes so it travels with them.", 4200),
    written(NOTES_1.source, NOTES_1.text, "markdown"),
    written("docs/architecture.svg", ARCHITECTURE_SVG, "xml"),
    presentStep(NOTES_1),
    say("The migration notes are in the card above: what changes, the field mapping, how to run the migration, and the read path as a diagram."),
    { t: "user", text: "Add a rollback section: what do I do if the new build misbehaves?" },
    {
      t: "tool",
      spec: {
        tool: "browser",
        title: "screenshot http://localhost:1420/settings/about",
        args: { action: "screenshot", url: "http://localhost:1420/settings/about", path: "docs/data-folder.png" },
        ms: 2600,
        view: { type: "image", image: { mime: "image/png", data: DATA_FOLDER_PNG, width: 440, height: 200 }, alt: "Settings → About with the data folder", url: "http://localhost:1420/settings/about" },
      },
    },
    appended(NOTES_2.source, NOTES, ROLLBACK, "markdown"),
    presentStep(NOTES_2),
    say("Version 2 adds **Rollback**, with a screenshot of where Settings shows the data folder: quit TeleFlock everywhere, install the previous build, then put `cache.v1.json` back. Anything written since the upgrade comes back from the hosts on the next connection."),
  ];
}

/** The docs session turns the finance export into a one-page report, then breaks it down by region. */
export function q3ReportSteps(): Step[] {
  return [
    { t: "user", text: "Unrelated: finance put the Q3 export in ~/finance/q3-revenue.csv, next to Q2's. Turn it into a one-page report I can show on Thursday." },
    bash(
      "cd ~/finance && head -3 q3-revenue.csv && wc -l q3-revenue.csv",
      ["invoice_id,customer,plan,region,quarter,amount_usd", "INV-26-07-0001,northwind,Business,EMEA,Q3,1240.00", "INV-26-07-0002,globex,Enterprise,Americas,Q3,18500.00", "4218 q3-revenue.csv"],
      400,
    ),
    bash(pivot("plan", "Q3_k"), PLAN_TOTALS, 1900),
    think("One self-contained page: KPI tiles, the plans as a bar chart the page draws on a canvas itself, and the table. The report kit has the stylesheet and the logo; copied next to the page, they are presented with it.", 5200),
    written(REPORT_1.source, REPORT_1.text, "html"),
    bash("cp ~/finance/report-kit/{report.css,logo.svg,grid.svg} ~/finance/q3-report/", [], 300),
    presentStep(REPORT_1),
    say("The report is in the card above: $4.82M in Q3, up 18.0% on Q2. Business is the largest plan and Enterprise grew fastest (+23.0%). The page draws its chart itself, so it needs no network."),
    { t: "user", text: "Can you break it down by region? And put Q2 next to Q3 in the chart." },
    bash(pivot("region", "Q3_k DESC"), REGION_TOTALS, 1700),
    written(REPORT_2.source, REPORT_2.text, "html"),
    presentStep(REPORT_2),
    say("Version 2 adds the regional breakdown and puts Q2 next to Q3 in the chart. APAC grew fastest (+36.2%) since the Singapore region opened in July; the Americas are still 54% of revenue."),
  ];
}
