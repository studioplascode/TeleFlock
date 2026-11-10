/*
 * The bytes of the docs session's presented files that are no text (./presented): the Q3 report as
 * a two-page PDF, the data behind it as a ZIP, TeleFlock's notification chimes as a WAV (all three
 * made at load, deterministic) and a card flying across the board as a WebM clip (recorded once,
 * 3.5 KB). Real files of their types, so the viewer draws, plays and saves them as it would an
 * agent's.
 */

const ascii = new TextEncoder();

// ── PDF ──

/** `(text)` with `\`, `(` and `)` escaped: ASCII only, so characters are bytes. */
const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
/** `#4f46e5` → `0.31 0.275 0.898`. */
const pdfColor = (hex: string) => [1, 3, 5].map((i) => Number((Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3))).join(" ");
const fill = (hex: string) => `${pdfColor(hex)} rg`;
const rect = (x: number, y: number, w: number, h: number, hex: string) => `${fill(hex)} ${x} ${y} ${w} ${h} re f`;
const line = (x1: number, y: number, x2: number, hex: string) => `${pdfColor(hex)} RG 0.6 w ${x1} ${y} m ${x2} ${y} l S`;
/** Helvetica (`F1`) or Helvetica-Bold (`F2`), the standard fonts every viewer has. */
const text = (font: "F1" | "F2", size: number, x: number, y: number, hex: string, s: string) => `${fill(hex)} BT /${font} ${size} Tf ${x} ${y} Td ${pdfString(s)} Tj ET`;

/** A PDF of US Letter pages, each its content stream (fonts `F1` and `F2`), with a correct cross-reference table. */
function pdfOf(pages: readonly string[]): Uint8Array {
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  const kids: string[] = [];
  for (const content of pages) {
    const id = objects.length;
    kids.push(`${id} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets.push(out.length);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return ascii.encode(out);
}

const INK = "#111827";
const MUTE = "#6b7280";
const LINE = "#e5e7eb";
const ACCENT = "#4f46e5";
const GOOD = "#047857";

const PLANS: Array<[string, string, number, number, string, string]> = [
  ["Starter", "2,140", 389, 412, "+5.9%", "8.5%"],
  ["Team", "1,024", 1102, 1268, "+15.1%", "26.3%"],
  ["Business", "318", 1451, 1734, "+19.5%", "36.0%"],
  ["Enterprise", "56", 1143, 1406, "+23.0%", "29.2%"],
];
const REGIONS: Array<[string, string, number, number, string, string]> = [
  ["Americas", "1,912", 2288, 2603, "+13.8%", "54.0%"],
  ["EMEA", "1,140", 1266, 1494, "+18.0%", "31.0%"],
  ["APAC", "486", 531, 723, "+36.2%", "15.0%"],
];

/** `$1,268k`. */
const thousands = (k: number) => `$${k.toLocaleString("en-US")}k`;

function summaryPage(): string {
  const ops = [rect(0, 700, 612, 92, ACCENT), text("F2", 26, 48, 746, "#ffffff", "Q3 revenue report"), text("F1", 11, 48, 722, "#e0e7ff", "Acme Cloud - Finance - July to September 2026 - recognised revenue in USD")];
  const kpis: Array<[string, string, string]> = [
    ["REVENUE", "$4.82M", "+18.0% vs Q2"],
    ["EXIT ARR", "$20.4M", "+20.9% vs June"],
    ["NET RETENTION", "116%", "+3 pts"],
    ["LOGO CHURN", "1.7%", "-0.4 pts"],
  ];
  kpis.forEach(([label, value, delta], i) => {
    const x = 48 + i * 132;
    ops.push(rect(x, 596, 120, 78, "#f5f6fa"), text("F1", 8, x + 12, 656, MUTE, label), text("F2", 20, x + 12, 626, INK, value), text("F1", 9, x + 12, 608, GOOD, delta));
  });
  ops.push(text("F2", 14, 48, 556, INK, "Revenue by plan, Q2 and Q3"), rect(400, 556, 9, 9, "#c7d2fe"), text("F1", 9, 414, 557, INK, "Q2"), rect(446, 556, 9, 9, ACCENT), text("F1", 9, 460, 557, INK, "Q3"));
  // The chart: $0-2.0M on 220 pt, the plans in four slots.
  const [x0, y0, w, h, max] = [88, 292, 476, 220, 2000];
  for (let v = 0; v <= max; v += 500) {
    const y = y0 + (v / max) * h;
    ops.push(line(x0, y, x0 + w, v === 0 ? "#cbd5e1" : "#eef0f4"), text("F1", 8, 48, y - 3, MUTE, v === 0 ? "$0" : `$${(v / 1000).toFixed(1)}M`));
  }
  const slot = w / PLANS.length;
  PLANS.forEach(([plan, , q2, q3], i) => {
    const bx = x0 + slot * i + (slot - 66) / 2;
    ops.push(rect(bx, y0, 30, (q2 / max) * h, "#c7d2fe"), rect(bx + 36, y0, 30, (q3 / max) * h, ACCENT));
    ops.push(text("F1", 8, bx + 33, y0 + (q3 / max) * h + 6, INK, thousands(q3)), text("F1", 9, bx + 10, y0 - 16, INK, plan));
  });
  ops.push(
    text("F1", 10, 48, 236, INK, "Business is the largest plan; Enterprise grew fastest (+23.0%)."),
    text("F1", 9, 48, 218, MUTE, "Source: q3-revenue.csv (4,217 invoice lines) and q2-revenue.csv."),
    text("F1", 8, 540, 36, MUTE, "1 / 2"),
  );
  return ops.join("\n");
}

function table(title: string, head: string, rows: typeof PLANS, top: number): string[] {
  const cols = [48, 168, 268, 348, 428, 508];
  const ops = [text("F2", 15, 48, top, INK, title)];
  [head, "Customers", "Q2", "Q3", "Change", "Share of Q3"].forEach((h, i) => ops.push(text("F2", 8, cols[i]!, top - 28, MUTE, h.toUpperCase())));
  ops.push(line(48, top - 36, 564, LINE));
  rows.forEach(([name, customers, q2, q3, change, share], r) => {
    const y = top - 54 - r * 24;
    [name, customers, thousands(q2), thousands(q3), change, share].forEach((cell, i) => ops.push(text("F1", 10, cols[i]!, y, i === 4 ? GOOD : INK, cell)));
    ops.push(line(48, y - 9, 564, LINE));
  });
  const y = top - 54 - rows.length * 24;
  const sum = (i: 2 | 3) => rows.reduce((n, row) => n + row[i], 0);
  ["Total", "3,538", thousands(sum(2)), thousands(sum(3)), "+18.0%", "100%"].forEach((cell, i) => ops.push(text("F2", 10, cols[i]!, y, i === 4 ? GOOD : INK, cell)));
  return ops;
}

function breakdownPage(): string {
  return [
    ...table("By plan", "Plan", PLANS, 736),
    ...table("By region", "Region", REGIONS, 520),
    text("F1", 10, 48, 360, INK, "APAC grew fastest after the Singapore region opened in July; the Americas are"),
    text("F1", 10, 48, 346, INK, "still more than half of revenue."),
    text("F1", 8, 540, 36, MUTE, "2 / 2"),
  ].join("\n");
}

/** The Q3 report as the docs session printed it for the board pack: a summary with the chart, then the tables. */
export const Q3_REPORT_PDF = pdfOf([summaryPage(), breakdownPage()]);

// ── ZIP ──

/** CRC-32 (IEEE 802.3), what a ZIP entry records of its bytes. */
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A ZIP of `files` stored as they are (`zip -0`), every entry dated `when` (UTC). */
function zipOf(files: Record<string, string>, when: Date): Uint8Array {
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const date = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const entries = Object.entries(files).map(([name, text]) => {
    const body = ascii.encode(text);
    return { name: ascii.encode(name), body, crc: crc32(body) };
  });
  const local = entries.reduce((n, e) => n + 30 + e.name.length + e.body.length, 0);
  const central = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(local + central + 22);
  const view = new DataView(out.buffer);
  let pos = 0;
  // Little-endian fields, written in order.
  const u16 = (x: number) => {
    view.setUint16(pos, x, true);
    pos += 2;
  };
  const u32 = (x: number) => {
    view.setUint32(pos, x, true);
    pos += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, pos);
    pos += b.length;
  };
  const heads = entries.map((e) => {
    const head = pos;
    u32(0x04034b50); // local file header
    [20, 0, 0, time, date].forEach(u16); // version, flags, stored, time, date
    [e.crc, e.body.length, e.body.length].forEach(u32);
    [e.name.length, 0].forEach(u16);
    bytes(e.name);
    bytes(e.body);
    return head;
  });
  entries.forEach((e, i) => {
    u32(0x02014b50); // central directory entry
    [20, 20, 0, 0, time, date].forEach(u16);
    [e.crc, e.body.length, e.body.length].forEach(u32);
    [e.name.length, 0, 0, 0, 0].forEach(u16); // name, extra, comment, disk, internal attributes
    [0, heads[i] ?? 0].forEach(u32); // external attributes, where its local header is
    bytes(e.name);
  });
  u32(0x06054b50); // end of central directory
  [0, 0, entries.length, entries.length].forEach(u16);
  [central, local].forEach(u32);
  u16(0);
  return out;
}

/** A table's rows as CSV (thousands without their separators). */
const csv = (head: string, rows: typeof PLANS) =>
  `${head},customers,q2_usd_k,q3_usd_k,change,share_of_q3\n${rows.map(([name, customers, ...rest]) => [name, customers.replace(/,/g, ""), ...rest].join(",")).join("\n")}\n`;

/** The numbers behind the report, for finance to check: what the docs session zipped next to it. */
export const Q3_BOARD_PACK_ZIP = zipOf(
  {
    "q3-revenue-by-plan.csv": csv("plan", PLANS),
    "q3-revenue-by-region.csv": csv("region", REGIONS),
    "README.txt": "Q3 2026 board pack: recognised revenue in USD thousands, from q3-revenue.csv (4,217 invoice lines) and q2-revenue.csv.\nThe report itself is q3-report.pdf.\n",
  },
  new Date(Date.UTC(2026, 9, 29, 10, 14, 0)),
);

// ── WAV ──

/** TeleFlock's chimes as `features/notify/chime.ts` plays them: two sine notes 120 ms apart, per kind. */
const CHIMES: ReadonlyArray<readonly [number, number]> = [
  [659.25, 987.77], // needs you: rising
  [783.99, 587.33], // finished: a soft fall
  [587.33, 783.99], // a presented document: a soft rise
  [329.63, 261.63], // an error: low
];
const RATE = 16_000;
/** One chime after another. */
const SPACING = 0.85;

/** The four chimes in a row, 16 kHz 16-bit mono PCM: each note ramps up in 15 ms and fades out by 350 ms, as the app's do. */
function chimesWav(): Uint8Array {
  const n = Math.round(RATE * (SPACING * (CHIMES.length - 1) + 0.12 + 0.4 + 0.3));
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  out.set(ascii.encode("RIFF"), 0);
  v.setUint32(4, 36 + n * 2, true);
  out.set(ascii.encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  out.set(ascii.encode("data"), 36);
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let s = 0;
    CHIMES.forEach((notes, c) =>
      notes.forEach((freq, k) => {
        const u = t - c * SPACING - k * 0.12;
        if (u < 0 || u > 0.4) return;
        // chime.ts: up to 0.12 in 15 ms, then exponentially to 0.0001 at 350 ms; 3× louder (a file has no system volume behind it).
        const gain = u < 0.015 ? (u / 0.015) * 0.12 : 0.12 * (0.0001 / 0.12) ** ((u - 0.015) / 0.335);
        s += Math.sin(2 * Math.PI * freq * u) * gain * 3;
      }),
    );
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true);
  }
  return out;
}

/** The chimes the docs session rendered for the notifications docs. */
export const CHIMES_WAV = chimesWav();

// ── WebM ──

/**
 * A card flying from the first lane to the last: 2.5 s of 256 × 144 VP8 at 12 fps, made with
 * ffmpeg from lavfi colour sources (`drawbox` lanes and cards, an eased `overlay` for the card
 * that moves; libvpx, 40 kbps). sha256 6d360d63186d45ead15785f3b84490223ccb294936d1753e59c6eb16d4386df7.
 */
export const CARD_FLIGHT_WEBM = Uint8Array.from(
  atob(
    "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",
  ),
  (c) => c.charCodeAt(0),
);
