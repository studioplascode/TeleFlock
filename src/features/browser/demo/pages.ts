/**
 * The demo browser's canned web pages (`?demo`): one block model per page, one layout for a
 * viewport, one Canvas 2D painter and hit testing. Pure apart from the painter; `fakeBrowser.ts`
 * keeps each tab's state and speaks CDP.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- sites

export interface Site {
  host: string;
  name: string;
  color: string;
  letter: string;
}

export const SITES: readonly Site[] = [
  { host: "start.teleflock.demo", name: "TeleFlock", color: "#4f46e5", letter: "T" },
  { host: "search.teleflock.demo", name: "TeleFlock Search", color: "#4f46e5", letter: "S" },
  { host: "mail.example.com", name: "Example Mail", color: "#dc2626", letter: "M" },
  { host: "dashboard.example.com", name: "Example Cloud", color: "#0284c7", letter: "C" },
  { host: "ci.example.com", name: "Example CI", color: "#16a34a", letter: "CI" },
  { host: "docs.example.com", name: "Example Docs", color: "#7c3aed", letter: "D" },
  { host: "shop.example.com", name: "Example Shop", color: "#ea580c", letter: "S" },
];

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function siteOf(url: string): Site | undefined {
  const u = parseUrl(url);
  return u && u.protocol === "https:" ? SITES.find((s) => s.host === u.hostname) : undefined;
}

/** The page's icon address (`https://<host>/favicon.png`); undefined for error and blank pages. */
export function iconUrlOf(url: string): string | undefined {
  const site = siteOf(url);
  return site ? `https://${site.host}/favicon.png` : undefined;
}

/** The site an icon address belongs to. */
export function iconSite(url: string): Site | undefined {
  const u = parseUrl(url);
  return u && u.pathname === "/favicon.png" ? siteOf(url) : undefined;
}

// ---------------------------------------------------------------- model

export type Tone = "info" | "success" | "warning" | "danger";
export interface Banner {
  text: string;
  tone: Tone;
}

export interface Download {
  filename: string;
  bytes: number;
}

export type Action =
  | { kind: "submit" }
  | { kind: "reload" }
  | { kind: "upload"; field: string }
  /** A JS dialog; the banner the page shows afterwards (`{input}`: the prompt's answer). */
  | { kind: "dialog"; type: "alert" | "confirm" | "prompt"; message: string; defaultPrompt?: string; accepted: Banner; dismissed?: Banner };

export type FieldType = "text" | "email" | "password" | "search";

interface Control {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger" | "link";
  action?: Action;
  href?: string;
  target?: "_blank";
  download?: Download;
  /** A leading glyph (↓, ↻, ←). */
  icon?: string;
  /** Fills the column (sign-in). */
  full?: boolean;
}

interface Row {
  id: string;
  href: string;
  title: string;
  /** Second line: a lead in dark text, then the snippet muted. */
  lead?: string;
  snippet?: string;
  meta?: string;
  bold?: boolean;
  dot?: string;
  avatar?: { letter: string; color: string };
  badge?: { text: string; tone: Tone };
}

interface Column {
  label: string;
  weight: number;
  align?: "right";
  /** Dropped when the table is narrow. */
  optional?: boolean;
  pill?: boolean;
}

interface Result {
  id: string;
  href: string;
  title: string;
  site: Site;
  snippet: string;
}

export type Block =
  | { t: "h"; text: string; level: 1 | 2 | 3; sub?: string; anchor?: string }
  | { t: "p"; text: string; tone?: "muted" | "small" | "lead" }
  | { t: "field"; id: string; name: string; type: FieldType; label?: string; placeholder?: string; autocomplete?: string; big?: boolean }
  | { t: "check"; id: string; label: string }
  | { t: "actions"; items: Control[]; align?: "between" }
  | { t: "link"; id: string; label: string; href: string; target?: "_blank" }
  | { t: "list"; items: string[]; ordered?: boolean }
  | { t: "code"; lines: string[]; title?: string }
  | { t: "log"; lines: string[]; title: string; dot: string }
  | { t: "rows"; rows: Row[] }
  | { t: "table"; columns: Column[]; rows: string[][]; filter?: string; empty?: string }
  | { t: "cards"; cards: { label: string; value: string; note: string; tone?: "up" | "down" }[] }
  | { t: "tiles"; tiles: { id: string; label: string; href: string; site: Site }[] }
  | { t: "results"; items: Result[]; stats: string }
  | { t: "file"; id: string; name: string; label: string; multiple: boolean; backendNodeId: number; hint: string }
  | { t: "panel"; blocks: Block[] }
  | { t: "brand"; text: string }
  | { t: "glyph"; kind: "error" }
  | { t: "divider" }
  | { t: "space"; h: number }
  /** Where the page's banner (a dialog's outcome, an upload) shows; else at the top of the column. */
  | { t: "slot" };

export type Frame = "start" | "auth" | "app" | "doc" | "error" | "blank";

/** What submitting the page's form does: the next address, and what the site remembers (a sign-in). */
export interface Submit {
  url: string;
  remember?: Partial<Memory>;
}

export interface Page {
  url: string;
  title: string;
  site?: Site;
  frame: Frame;
  nav?: { links: { label: string; href: string; active?: boolean }[]; account?: string };
  sidebar?: { label: string; href: string; active?: boolean; count?: string }[];
  maxWidth: number;
  background: string;
  blocks: Block[];
  form?: (values: Record<string, string>, checked: Record<string, boolean>) => Submit | null;
  initial?: Record<string, string>;
  /** The status the server answered the document with when it was an error (a missing page: 404); absent: 200. */
  status?: number;
  /** Chrome's error page for a document that never loaded (the fake adds the `net::` prefix). */
  netError?: "ERR_NAME_NOT_RESOLVED" | "ERR_CONNECTION_REFUSED";
}

/** What the sites remember across pages of the browser (cookies, roughly). */
export interface Memory {
  email: string;
}

export function defaultMemory(): Memory {
  return { email: "ada@example.com" };
}

export interface PageState {
  values: Record<string, string>;
  checked: Record<string, boolean>;
  files: Record<string, string[]>;
  focus: string | null;
  /** Keyboard focus (Tab): buttons and links show the focus ring. */
  focusRing: boolean;
  /** Caret and selection anchor in the focused field (UTF-16 offsets). */
  caret: number;
  anchor: number;
  composition: string;
  hover: string | null;
  pressed: string | null;
  scrollY: number;
  banner: Banner | null;
}

export function freshState(page: Page): PageState {
  return {
    values: { ...page.initial },
    checked: {},
    files: {},
    focus: null,
    focusRing: false,
    caret: 0,
    anchor: 0,
    composition: "",
    hover: null,
    pressed: null,
    scrollY: 0,
    banner: null,
  };
}

// ---------------------------------------------------------------- pages

const START = SITES[0] as Site;
const SEARCH = SITES[1] as Site;
const MAIL = SITES[2] as Site;
const CLOUD = SITES[3] as Site;
const CI = SITES[4] as Site;
const DOCS = SITES[5] as Site;
const SHOP = SITES[6] as Site;

interface Message {
  from: string;
  address: string;
  subject: string;
  snippet: string;
  time: string;
  unread: boolean;
  color: string;
  body: string[];
}

const MESSAGES: readonly Message[] = [
  {
    from: "Grace Hopper",
    address: "grace@example.com",
    subject: "Q4 planning doc: comments due Friday",
    snippet: "I left a few notes on the roadmap section; can you look at the staffing table before we send it round?",
    time: "9:41 AM",
    unread: true,
    color: "#2563eb",
    body: [
      "Hi Ada,",
      "I left a few notes on the roadmap section of the Q4 planning doc. The staffing table still assumes the old hiring plan, so the platform numbers look a little optimistic.",
      "Could you take a look before Friday? Once your comments are in I'll send it round to the leads and book a review for next week.",
      "Thanks, Grace",
    ],
  },
  {
    from: "GitHub",
    address: "notifications@github.com",
    subject: "[acme/api] Retry idempotent requests (#482)",
    snippet: "linus requested your review on this pull request. 4 files changed, +212 −38.",
    time: "8:15 AM",
    unread: true,
    color: "#111827",
    body: [
      "@linus requested your review on acme/api#482: Retry idempotent requests.",
      "Adds a retry budget to the HTTP client: GET, PUT and DELETE are retried up to three times with jittered backoff; POST only with an idempotency key.",
      "4 files changed, 212 additions, 38 deletions. Reply to this email directly or view it on GitHub.",
    ],
  },
  {
    from: "Margaret Hamilton",
    address: "margaret@example.com",
    subject: "Flight checklist v3",
    snippet: "Attached the updated checklist with the abort criteria we discussed on Tuesday.",
    time: "Yesterday",
    unread: true,
    color: "#059669",
    body: [
      "Ada,",
      "attached is version 3 of the checklist with the abort criteria we discussed on Tuesday. The priority display section is new; everything else only moved.",
      "Let me know if the wording of step 14 works for you.",
      "Margaret",
    ],
  },
  {
    from: "Example Cloud Billing",
    address: "billing@example.com",
    subject: "Your October invoice is ready",
    snippet: "Invoice INV-2026-1043 for $4,182.40 is available. Payment is due on November 15.",
    time: "Oct 30",
    unread: false,
    color: "#0284c7",
    body: [
      "Your invoice INV-2026-1043 for October 2026 is ready: $4,182.40.",
      "The amount will be charged to the card ending in 4242 on November 15. You can download the invoice and a usage export from the billing page.",
    ],
  },
  {
    from: "Alan Turing",
    address: "alan@example.com",
    subject: "Re: lunch on Thursday?",
    snippet: "Sounds good. The place on 5th at 12:30? I'll book a table for three.",
    time: "Oct 29",
    unread: false,
    color: "#d97706",
    body: ["Sounds good. The place on 5th at 12:30? I'll book a table for three.", "Alan"],
  },
  {
    from: "Calendar",
    address: "calendar@example.com",
    subject: "Reminder: Design review at 3pm",
    snippet: "Design review · Thu Oct 29 · 3:00 – 4:00pm · Room Lovelace · 6 guests",
    time: "Oct 28",
    unread: false,
    color: "#7c3aed",
    body: ["Design review", "Thursday, October 29 · 3:00 – 4:00pm", "Room Lovelace · 6 guests · Video call link in the invite"],
  },
];

interface Run {
  n: number;
  name: string;
  status: "success" | "failure" | "running";
  branch: string;
  commit: string;
  actor: string;
  duration: string;
  ago: string;
}

const RUNS: readonly Run[] = [
  { n: 1842, name: "Build & test", status: "running", branch: "main", commit: "9f3c2ab", actor: "ada", duration: "3m 05s", ago: "just now" },
  { n: 1841, name: "Build & test", status: "failure", branch: "feat/retry-budget", commit: "e41d07c", actor: "linus", duration: "6m 48s", ago: "14 min ago" },
  { n: 1840, name: "Deploy to staging", status: "success", branch: "main", commit: "77ab910", actor: "grace", duration: "2m 31s", ago: "42 min ago" },
  { n: 1839, name: "Build & test", status: "success", branch: "main", commit: "77ab910", actor: "grace", duration: "5m 57s", ago: "48 min ago" },
  { n: 1838, name: "Lint", status: "success", branch: "fix/flaky-auth-test", commit: "c0de5e1", actor: "margaret", duration: "48s", ago: "1 hr ago" },
  { n: 1837, name: "Nightly e2e", status: "failure", branch: "main", commit: "5a7e2f0", actor: "schedule", duration: "18m 12s", ago: "9 hr ago" },
  { n: 1836, name: "Build & test", status: "success", branch: "dependabot/npm/vite-8.3.4", commit: "1b2c3d4", actor: "dependabot", duration: "5m 21s", ago: "11 hr ago" },
  { n: 1835, name: "Deploy to production", status: "success", branch: "main", commit: "0ff1ce5", actor: "ada", duration: "4m 02s", ago: "yesterday" },
  { n: 1834, name: "Build & test", status: "success", branch: "main", commit: "0ff1ce5", actor: "ada", duration: "6m 10s", ago: "yesterday" },
  { n: 1833, name: "Lint", status: "success", branch: "main", commit: "be11e5a", actor: "alan", duration: "52s", ago: "2 days ago" },
];

const STATUS_COLOR: Record<Run["status"], string> = { success: "#16a34a", failure: "#dc2626", running: "#d97706" };
const STATUS_TEXT: Record<Run["status"], string> = { success: "Succeeded", failure: "Failed", running: "In progress" };

/** The newest runs first: the agent clicks them in this order. */
export const CI_RUN_IDS: readonly string[] = RUNS.map((r) => `run-${r.n}`);

const TENANTS: readonly string[][] = [
  ["acme-prod", "Enterprise", "18.4M", "642.0", "1.21 TB", "$1,486.20"],
  ["globex-eu", "Enterprise", "9.7M", "388.5", "840 GB", "$912.75"],
  ["hooli-prod", "Business", "6.2M", "251.2", "512 GB", "$604.10"],
  ["initech", "Business", "4.1M", "160.8", "260 GB", "$341.95"],
  ["umbrella-research", "Business", "3.3M", "142.6", "198 GB", "$286.40"],
  ["acme-staging", "Team", "2.2M", "88.1", "96 GB", "$151.30"],
  ["stark-industries", "Team", "1.4M", "61.7", "71 GB", "$104.85"],
  ["wayne-enterprises", "Team", "1.1M", "54.0", "58 GB", "$88.60"],
  ["wonka-labs", "Team", "640K", "39.2", "33 GB", "$61.25"],
  ["tyrell-core", "Starter", "410K", "28.4", "21 GB", "$42.10"],
  ["cyberdyne", "Starter", "305K", "21.9", "18 GB", "$33.80"],
  ["soylent-eu", "Starter", "188K", "14.3", "9.2 GB", "$21.45"],
  ["aperture-science", "Starter", "121K", "11.6", "6.8 GB", "$17.90"],
  ["massive-dynamic", "Starter", "64K", "7.8", "3.1 GB", "$11.75"],
];

const CLOUD_SIDEBAR = (active: string) =>
  [
    { label: "Overview", href: "https://dashboard.example.com/" },
    { label: "Projects", href: "https://dashboard.example.com/projects" },
    { label: "Billing", href: "https://dashboard.example.com/billing" },
    { label: "Invoices", href: "https://dashboard.example.com/invoices" },
    { label: "API keys", href: "https://dashboard.example.com/keys" },
    { label: "Settings", href: "https://dashboard.example.com/settings" },
  ].map((x) => ({ ...x, active: x.label === active }));

const DOCS_SIDEBAR = (active: string) =>
  [
    { label: "Introduction", href: "https://docs.example.com/" },
    { label: "Getting started", href: "https://docs.example.com/guide" },
    { label: "Configuration", href: "https://docs.example.com/guide#configure" },
    { label: "Deploying", href: "https://docs.example.com/guide#deploy" },
    { label: "API reference", href: "https://docs.example.com/api" },
    { label: "Changelog", href: "https://docs.example.com/changelog" },
  ].map((x) => ({ ...x, active: x.label === active }));

function app(site: Site, url: string, title: string, blocks: Block[], extra: Partial<Page> = {}): Page {
  return { url, title, site, frame: "app", maxWidth: 1080, background: "#f8fafc", blocks, ...extra };
}

function startPage(url: string): Page {
  const tiles = [
    { id: "tile-mail", label: "Mail", href: "https://mail.example.com/", site: MAIL },
    { id: "tile-billing", label: "Billing", href: "https://dashboard.example.com/billing", site: CLOUD },
    { id: "tile-ci", label: "CI", href: "https://ci.example.com/runs", site: CI },
    { id: "tile-docs", label: "Docs", href: "https://docs.example.com/guide", site: DOCS },
    { id: "tile-upload", label: "Upload", href: "https://shop.example.com/upload", site: SHOP },
  ];
  return {
    url,
    title: "New Tab",
    site: START,
    frame: "start",
    maxWidth: 584,
    background: "#ffffff",
    nav: { links: [{ label: "Mail", href: "https://mail.example.com/inbox" }, { label: "Docs", href: "https://docs.example.com/guide" }], account: "A" },
    blocks: [
      { t: "brand", text: "TeleFlock" },
      { t: "space", h: 28 },
      { t: "field", id: "q", name: "q", type: "search", placeholder: "Search the web or type a URL", big: true, autocomplete: "off" },
      { t: "space", h: 36 },
      { t: "tiles", tiles },
    ],
    form: (v) => searchSubmit(v.q),
  };
}

function searchSubmit(q: string | undefined): Submit | null {
  const text = (q ?? "").trim();
  return text ? { url: `https://search.teleflock.demo/?q=${encodeURIComponent(text)}` } : null;
}

function searchPage(url: string, q: string): Page {
  const items: Result[] = [
    { id: "result-1", href: "https://docs.example.com/guide", title: "Getting started · Example Docs", site: DOCS, snippet: `Everything about ${q}: install the CLI, configure a project and deploy your first service in under ten minutes.` },
    { id: "result-2", href: "https://ci.example.com/runs", title: "Runs · Example CI", site: CI, snippet: "Workflow runs for acme/api: builds, tests and deployments with live logs, re-runs and branch filters." },
    { id: "result-3", href: "https://mail.example.com/", title: "Sign in – Example Mail", site: MAIL, snippet: "Fast, private email with a focused inbox. Sign in to read and send mail from any device." },
    { id: "result-4", href: "https://dashboard.example.com/billing", title: "Billing · Example Cloud", site: CLOUD, snippet: "Usage-based pricing for compute, requests and egress. Export usage per tenant as CSV and download invoices." },
    { id: "result-5", href: "https://shop.example.com/upload", title: "Upload invoices · Example Shop", site: SHOP, snippet: "Upload supplier invoices as PDF or images; they are matched to your orders automatically." },
  ];
  return {
    url,
    title: q ? `${q} - TeleFlock Search` : "TeleFlock Search",
    site: SEARCH,
    frame: "app",
    maxWidth: 680,
    background: "#ffffff",
    nav: { links: [{ label: "All", href: url, active: true }, { label: "Images", href: url }, { label: "News", href: url }], account: "A" },
    blocks: [
      { t: "field", id: "q", name: "q", type: "search", placeholder: "Search the web", autocomplete: "off" },
      { t: "space", h: 4 },
      { t: "results", items, stats: "About 1,240,000 results (0.42 seconds)" },
    ],
    initial: { q },
    form: (v) => searchSubmit(v.q),
  };
}

function mailSignIn(url: string): Page {
  return {
    url,
    title: "Sign in – Example Mail",
    site: MAIL,
    frame: "auth",
    maxWidth: 420,
    background: "#f1f5f9",
    blocks: [
      {
        t: "panel",
        blocks: [
          { t: "brand", text: "Example Mail" },
          { t: "h", text: "Sign in", level: 1, sub: "to continue to Example Mail" },
          { t: "field", id: "email", name: "email", type: "email", label: "Email", placeholder: "you@example.com", autocomplete: "username" },
          { t: "field", id: "password", name: "password", type: "password", label: "Password", placeholder: "Password", autocomplete: "current-password" },
          { t: "check", id: "keep", label: "Keep me signed in" },
          { t: "actions", items: [{ id: "sign-in", label: "Sign in", variant: "primary", action: { kind: "submit" }, full: true }] },
          { t: "actions", align: "between", items: [{ id: "forgot", label: "Forgot password?", variant: "link", href: "https://mail.example.com/recover" }, { id: "create", label: "Create account", variant: "link", href: "https://mail.example.com/signup" }] },
        ],
      },
      { t: "p", text: "Example Mail · Privacy · Terms · Help", tone: "small" },
    ],
    form: (v) => ({ url: "https://mail.example.com/inbox", remember: { email: (v.email ?? "").trim() || "ada@example.com" } }),
  };
}

/** Mail's frame: folders on the left, the account at the top right. */
function mailChrome(memory: Memory, active: string): Partial<Page> {
  const folder = (label: string, path: string, count?: string) => ({ label, href: `https://mail.example.com/${path}`, active: label === active, count });
  return {
    nav: { links: [], account: memory.email },
    sidebar: [folder("Inbox", "inbox", "3"), folder("Starred", "starred"), folder("Snoozed", "snoozed"), folder("Sent", "sent"), folder("Drafts", "drafts", "1"), folder("Spam", "spam")],
  };
}

function inbox(url: string, memory: Memory): Page {
  const unread = MESSAGES.filter((m) => m.unread).length;
  const rows: Row[] = MESSAGES.map((m, i) => ({
    id: `message-${i + 1}`,
    href: `https://mail.example.com/message/${i + 1}`,
    title: m.from,
    lead: m.subject,
    snippet: m.snippet,
    meta: m.time,
    bold: m.unread,
    avatar: { letter: m.from.charAt(0), color: m.color },
  }));
  return app(MAIL, url, `Inbox (${unread}) – Example Mail`, [
    { t: "h", text: "Inbox", level: 1, sub: `${unread} unread · Signed in as ${memory.email}` },
    { t: "rows", rows },
    { t: "p", text: "Using 2.1 GB of 15 GB · Last account activity: 3 minutes ago", tone: "small" },
  ], { ...mailChrome(memory, "Inbox"), maxWidth: 880 });
}

function message(url: string, n: number, memory: Memory): Page | undefined {
  const m = MESSAGES[n - 1];
  if (!m) return undefined;
  return app(MAIL, url, `${m.subject} – Example Mail`, [
    { t: "link", id: "back", label: "← Back to Inbox", href: "https://mail.example.com/inbox" },
    {
      t: "panel",
      blocks: [
        { t: "h", text: m.subject, level: 2, sub: `${m.from} <${m.address}> · to ${memory.email} · ${m.time}` },
        { t: "divider" },
        ...m.body.map((text): Block => ({ t: "p", text })),
        { t: "actions", items: [{ id: "reply", label: "Reply", variant: "secondary", icon: "↩", href: `https://mail.example.com/message/${n}#reply` }, { id: "forward", label: "Forward", variant: "secondary", icon: "↪", href: `https://mail.example.com/message/${n}#forward` }] },
      ],
    },
  ], { ...mailChrome(memory, "Inbox"), maxWidth: 760 });
}

const CLOUD_NAV = (active: string): Page["nav"] => ({
  links: ["Overview", "Projects", "Billing", "Settings"].map((label) => ({ label, href: `https://dashboard.example.com/${label === "Overview" ? "" : label.toLowerCase()}`, active: label === active })),
  account: "ada@acme.dev",
});

function billing(url: string): Page {
  return app(CLOUD, url, "Billing · Example Cloud", [
    { t: "h", text: "Billing", level: 1, sub: "Acme Inc. · Usage for October 2026 · resets on November 1" },
    { t: "slot" },
    {
      t: "cards",
      cards: [
        { label: "Month to date", value: "$4,182.40", note: "+12.4% vs September", tone: "up" },
        { label: "Requests", value: "48.2M", note: "+8.1% vs September", tone: "up" },
        { label: "Compute", value: "1,912 vCPU·h", note: "−3.2% vs September", tone: "down" },
        { label: "Egress", value: "3.4 TB", note: "62% of committed", tone: undefined },
      ],
    },
    {
      t: "actions",
      items: [
        { id: "export-csv", label: "Export usage CSV", variant: "secondary", icon: "↓", href: "https://dashboard.example.com/billing/usage-2026-10.csv", download: { filename: "usage-2026-10.csv", bytes: 188_416 } },
        { id: "restart-gateway", label: "Restart api-gateway", variant: "danger", icon: "↻", action: { kind: "dialog", type: "confirm", message: "Restart api-gateway now? Requests in flight will be retried.", accepted: { text: "api-gateway is restarting. Requests in flight are retried; it is back in about 30 seconds.", tone: "success" }, dismissed: { text: "Restart cancelled: api-gateway keeps running.", tone: "info" } } },
        { id: "view-invoices", label: "View invoices →", variant: "link", href: "https://dashboard.example.com/invoices" },
      ],
    },
    { t: "h", text: "Usage by tenant", level: 2, sub: "14 tenants · billed hourly, updated 5 minutes ago" },
    { t: "field", id: "tenant-filter", name: "tenant", type: "search", placeholder: "Filter tenants", autocomplete: "off" },
    {
      t: "table",
      filter: "tenant-filter",
      empty: "No tenant matches the filter.",
      columns: [
        { label: "Tenant", weight: 2.2 },
        { label: "Plan", weight: 1.2, optional: true, pill: true },
        { label: "Requests", weight: 1, align: "right" },
        { label: "vCPU·h", weight: 1, align: "right", optional: true },
        { label: "Egress", weight: 1, align: "right", optional: true },
        { label: "Cost", weight: 1.1, align: "right" },
      ],
      rows: TENANTS.map((r) => [...r]),
    },
    { t: "p", text: "Prices exclude VAT. Usage of the current day is estimated until 02:00 UTC.", tone: "small" },
  ], { nav: CLOUD_NAV("Billing"), sidebar: CLOUD_SIDEBAR("Billing") });
}

function invoices(url: string): Page {
  const rows = [
    ["INV-2026-1043", "October 2026", "$4,182.40", "Due Nov 15"],
    ["INV-2026-0987", "September 2026", "$3,721.15", "Paid"],
    ["INV-2026-0931", "August 2026", "$3,588.90", "Paid"],
    ["INV-2026-0874", "July 2026", "$3,402.35", "Paid"],
    ["INV-2026-0818", "June 2026", "$3,118.00", "Paid"],
    ["INV-2026-0760", "May 2026", "$2,964.75", "Paid"],
    ["INV-2026-0702", "April 2026", "$2,830.20", "Paid"],
    ["INV-2026-0649", "March 2026", "$2,611.45", "Paid"],
  ];
  return app(CLOUD, url, "Invoices · Example Cloud", [
    { t: "link", id: "back-billing", label: "← Billing", href: "https://dashboard.example.com/billing" },
    { t: "h", text: "Invoices", level: 1, sub: "Charged to Visa ending in 4242 on the 15th of each month" },
    {
      t: "table",
      columns: [
        { label: "Invoice", weight: 1.6 },
        { label: "Period", weight: 1.6, optional: true },
        { label: "Amount", weight: 1.1, align: "right" },
        { label: "Status", weight: 1.2, pill: true },
      ],
      rows,
    },
    { t: "p", text: "Need a copy for your records? Invoices are kept for ten years and can be downloaded as PDF.", tone: "small" },
  ], { nav: CLOUD_NAV("Billing"), sidebar: CLOUD_SIDEBAR("Invoices") });
}

const CI_NAV: Page["nav"] = {
  links: [
    { label: "Runs", href: "https://ci.example.com/runs", active: true },
    { label: "Workflows", href: "https://ci.example.com/workflows" },
    { label: "Caches", href: "https://ci.example.com/caches" },
    { label: "Settings", href: "https://ci.example.com/settings" },
  ],
  account: "ada",
};

function runsPage(url: string): Page {
  const rows: Row[] = RUNS.map((r) => ({
    id: `run-${r.n}`,
    href: `https://ci.example.com/runs/${r.n}`,
    title: `${r.name} #${r.n}`,
    lead: r.branch,
    snippet: ` · ${r.commit} · ${r.actor === "schedule" ? "Scheduled" : `pushed by ${r.actor}`}`,
    meta: `${r.duration} · ${r.ago}`,
    dot: STATUS_COLOR[r.status],
    badge: r.status === "running" ? { text: "Running", tone: "warning" } : undefined,
  }));
  return app(CI, url, "Runs · Example CI", [
    { t: "h", text: "Workflow runs", level: 1, sub: "acme/api · 1,842 runs · main is passing" },
    { t: "rows", rows },
    { t: "p", text: "Showing the 10 most recent runs. Runs are kept for 90 days.", tone: "small" },
  ], { nav: CI_NAV, maxWidth: 960 });
}

function runLog(r: Run): string[] {
  const out: string[] = [
    "##[group]Set up job",
    "Current runner version: '2.329.0'",
    "Runner name: 'example-runner-07'",
    "Operating System: Ubuntu 24.04.3 LTS",
    "Image: ubuntu-24.04 (20261026.1)",
    "##[endgroup]",
    "##[group]Run actions/checkout@v5",
    `Syncing repository: acme/api`,
    `Fetching the repository (ref ${r.branch}, depth 1)`,
    `HEAD is now at ${r.commit} ${r.name === "Lint" ? "chore: tighten eslint rules" : "feat: retry idempotent requests"}`,
    "##[endgroup]",
    "##[group]Run actions/setup-node@v5 (node 24.11.0)",
    "Found in cache @ /opt/hostedtoolcache/node/24.11.0/x64",
    "Restoring pnpm store from cache (key node-pnpm-7d1f4e)",
    "Cache restored successfully: 412 MB in 6.1 s",
    "##[endgroup]",
    "##[group]Run pnpm install --frozen-lockfile",
    "Lockfile is up to date, resolution step is skipped",
    "Packages: +1284",
    "Progress: resolved 1284, reused 1284, downloaded 0, added 1284, done",
    "dependencies:",
    "+ fastify 5.6.1",
    "+ pg 8.16.3",
    "+ zod 4.1.12",
    "devDependencies:",
    "+ typescript 7.0.2",
    "+ vitest 4.0.6",
    "Done in 9.8s",
    "##[endgroup]",
    "##[group]Run pnpm build",
    "> api@3.14.0 build /home/runner/work/api",
    "> tsc -p tsconfig.build.json",
    "Compiled 286 files in 7.4 s",
    "##[endgroup]",
    "##[group]Run pnpm test --reporter=dot",
  ];
  const suites = ["auth/session", "auth/tokens", "billing/usage", "billing/invoices", "http/client", "http/retry", "http/router", "db/migrations", "db/pool", "jobs/queue", "jobs/scheduler", "tenants/limits", "tenants/export", "webhooks/deliver", "webhooks/sign"];
  suites.forEach((s, i) => {
    const failing = r.status === "failure" && s === "http/retry";
    out.push(`${failing ? "✗" : "✓"} src/${s}.test.ts (${8 + ((i * 7) % 23)} tests) ${120 + ((i * 97) % 900)}ms`);
    if (failing) {
      out.push("  ✗ retries a PUT after a 503 at most three times");
      out.push("    AssertionError: expected 4 calls to equal 3");
      out.push("      at src/http/retry.test.ts:88:31");
    }
    for (let j = 0; j < 4; j++) out.push(`    ✓ ${["handles the happy path", "rejects malformed input", "keeps tenants apart", "survives a restart", "reports metrics"][(i + j) % 5]} (${3 + ((i + j * 5) % 40)}ms)`);
  });
  if (r.status === "running") {
    out.push("Running integration tests against postgres:17 …");
    for (let i = 1; i <= 12; i++) out.push(`  [integration] ${String(i).padStart(2, "0")}/24 ${["tenants", "billing", "exports", "webhooks"][i % 4]} … ok`);
    out.push("  [integration] 13/24 retry budget under load …");
    return out;
  }
  out.push(r.status === "failure" ? " Test Files  1 failed | 14 passed (15)" : " Test Files  15 passed (15)");
  out.push(r.status === "failure" ? "      Tests  1 failed | 251 passed (252)" : "      Tests  252 passed (252)");
  out.push("   Duration  41.27s (transform 2.1s, collect 6.8s, tests 31.9s)");
  out.push("##[endgroup]");
  if (r.status === "failure") {
    out.push("Error: Process completed with exit code 1.");
  } else {
    out.push("##[group]Upload coverage");
    out.push("Coverage: statements 91.4% · branches 84.2% · functions 89.9% · lines 91.1%");
    out.push("##[endgroup]");
    out.push("##[group]Post job cleanup");
    out.push("Saving pnpm store to cache (key node-pnpm-7d1f4e): already up to date");
    out.push("Cleaning up orphan processes");
    out.push("##[endgroup]");
    out.push("✓ Job succeeded");
  }
  return out;
}

function runPage(url: string, n: number): Page | undefined {
  const r = RUNS.find((x) => x.n === n);
  if (!r) return undefined;
  return app(CI, url, `${r.name} #${r.n} · Example CI`, [
    { t: "link", id: "back-runs", label: "← All runs", href: "https://ci.example.com/runs" },
    { t: "h", text: `${r.name} #${r.n}`, level: 1, sub: `${STATUS_TEXT[r.status]} · ${r.branch} · ${r.commit} · ${r.duration} · triggered ${r.ago}` },
    { t: "slot" },
    { t: "actions", items: [{ id: "rerun", label: "Re-run jobs", variant: "secondary", icon: "↻", action: { kind: "dialog", type: "alert", message: "Re-run queued", accepted: { text: `Re-run of #${r.n} queued: the jobs start on the next free runner.`, tone: "info" } } }, { id: "raw-log", label: "View raw log", variant: "link", href: `https://ci.example.com/runs/${r.n}/raw` }] },
    { t: "log", title: `build · ${r.status === "running" ? "running" : STATUS_TEXT[r.status].toLowerCase()}`, dot: STATUS_COLOR[r.status], lines: runLog(r) },
  ], { nav: CI_NAV, maxWidth: 1040 });
}

const DOCS_NAV = (active: string): Page["nav"] => ({
  links: [
    { label: "Guide", href: "https://docs.example.com/guide", active: active === "Guide" },
    { label: "API", href: "https://docs.example.com/api", active: active === "API" },
    { label: "Changelog", href: "https://docs.example.com/changelog" },
  ],
});

function guide(url: string): Page {
  return {
    url,
    title: "Guide · Example Docs",
    site: DOCS,
    frame: "doc",
    maxWidth: 720,
    background: "#ffffff",
    nav: DOCS_NAV("Guide"),
    sidebar: DOCS_SIDEBAR("Getting started"),
    blocks: [
      { t: "p", text: "Docs › Guide › Getting started", tone: "small" },
      { t: "h", text: "Getting started with Example", level: 1, sub: "Updated October 28, 2026 · 6 min read" },
      { t: "p", tone: "lead", text: "Example runs your services close to your users. This guide takes you from an empty folder to a deployed service with a database, logs and a custom domain." },
      { t: "p", text: "You need a terminal, Node.js 22 or newer, and an Example account. The free plan is enough for everything in this guide; nothing here creates billable resources unless you add a paid database at the end." },
      { t: "h", text: "Install the CLI", level: 2 },
      { t: "p", text: "The command line tool talks to the Example API on your behalf. Install it globally and sign in once; the token is stored in your system keychain." },
      { t: "code", title: "Terminal", lines: ["$ npm install --global @example/cli", "$ example login", "Opening https://example.com/cli-login …", "✓ Signed in as ada@example.com"] },
      { t: "p", text: "On CI machines, set EXAMPLE_TOKEN instead of signing in. Tokens can be scoped to a single project and expire after 90 days by default." },
      { t: "h", text: "Create a project", level: 2 },
      { t: "p", text: "A project groups services, databases and domains that are deployed together. Run the init command in your repository; it detects the framework and writes example.toml." },
      { t: "code", title: "example.toml", lines: ['name = "acme-api"', 'region = "fra"', "", "[build]", 'command = "pnpm build"', 'output = "dist"', "", "[[services]]", 'name = "web"', "port = 8080", 'healthcheck = "/healthz"'] },
      { t: "h", text: "Configure", level: 2, anchor: "configure" },
      { t: "p", text: "Most settings have sensible defaults. The ones you will touch first:" },
      { t: "list", items: ["region: where the service runs; pick the one closest to your users.", "build.command: how the project is built. Leave it empty for prebuilt images.", "services[].port: the port your server listens on inside the container.", "services[].healthcheck: a path that answers 200 once the service is ready.", "env: plain variables; secrets go through example secrets set."] },
      { t: "p", text: "Every key and its default is listed in the reference, together with the limits of each plan." },
      { t: "link", id: "api-reference", label: "API reference", href: "https://docs.example.com/api", target: "_blank" },
      { t: "h", text: "Deploy", level: 2, anchor: "deploy" },
      { t: "p", text: "Deploying builds the project, uploads the image and rolls the new version out one instance at a time. Traffic moves only after the health check passes, so a broken build never takes the old version down." },
      { t: "code", title: "Terminal", lines: ["$ example deploy", "Building acme-api (pnpm build) … done in 21s", "Uploading image (84 MB) … done", "Rolling out web: 3/3 healthy", "✓ https://acme-api.example.app is live"] },
      { t: "p", text: "Each deployment gets its own immutable URL, which makes previews and rollbacks cheap: example rollback points the production domain at an earlier deployment within seconds." },
      { t: "h", text: "Add a database", level: 3 },
      { t: "p", text: "Managed Postgres is one command away. The connection string is injected as DATABASE_URL into every service of the project, and backups run every night." },
      { t: "code", lines: ["$ example db create --plan starter", "✓ Created postgres-acme (17.2, 10 GB)", "DATABASE_URL added to acme-api"] },
      { t: "h", text: "Next steps", level: 2 },
      { t: "list", ordered: true, items: ["Point your own domain at the project with example domains add.", "Stream logs with example logs --follow.", "Invite your team from the dashboard; roles are per project."] },
      { t: "divider" },
      { t: "p", text: "Was this page helpful? Questions go straight to the docs team." },
      { t: "actions", items: [{ id: "ask", label: "Ask a question", variant: "secondary", icon: "?", action: { kind: "dialog", type: "prompt", message: "Your question", defaultPrompt: "", accepted: { text: "Thanks, we got: {input}", tone: "success" }, dismissed: { text: "No question sent.", tone: "info" } } }, { id: "edit-page", label: "Edit this page", variant: "link", href: "https://docs.example.com/guide#edit" }] },
      { t: "slot" },
      { t: "space", h: 24 },
    ],
  };
}

function apiPage(url: string): Page {
  return {
    url,
    title: "API reference · Example Docs",
    site: DOCS,
    frame: "doc",
    maxWidth: 760,
    background: "#ffffff",
    nav: DOCS_NAV("API"),
    sidebar: DOCS_SIDEBAR("API reference"),
    blocks: [
      { t: "p", text: "Docs › API reference", tone: "small" },
      { t: "h", text: "API reference", level: 1, sub: "REST API v2 · base URL https://api.example.com/v2" },
      { t: "p", text: "All endpoints take and return JSON. Authenticate with a bearer token from the dashboard or the CLI; requests without one answer 401." },
      { t: "code", title: "Request", lines: ["curl https://api.example.com/v2/projects \\", '  -H "Authorization: Bearer $EXAMPLE_TOKEN"'] },
      { t: "h", text: "Endpoints", level: 2 },
      {
        t: "table",
        columns: [
          { label: "Method", weight: 0.8 },
          { label: "Path", weight: 2.2 },
          { label: "Description", weight: 2.6, optional: true },
        ],
        rows: [
          ["GET", "/projects", "List the projects you can access"],
          ["POST", "/projects", "Create a project"],
          ["GET", "/projects/{id}/deployments", "List a project's deployments"],
          ["POST", "/projects/{id}/deployments", "Start a deployment"],
          ["GET", "/usage?month=2026-10", "Usage per tenant, as JSON or CSV"],
          ["DELETE", "/tokens/{id}", "Revoke a token"],
        ],
      },
      { t: "h", text: "Rate limits", level: 2 },
      { t: "p", text: "Each token may make 600 requests per minute. Responses carry RateLimit-Remaining and RateLimit-Reset headers; a 429 tells you when to try again." },
    ],
  };
}

function uploadPage(url: string): Page {
  return app(SHOP, url, "Upload invoices · Example Shop", [
    { t: "link", id: "back-orders", label: "← Orders", href: "https://shop.example.com/orders" },
    { t: "h", text: "Upload invoices", level: 1, sub: "Supplier invoices are matched to your purchase orders automatically." },
    {
      t: "panel",
      blocks: [
        { t: "file", id: "invoices", name: "invoices", label: "Choose files", multiple: true, backendNodeId: 42, hint: "PDF, PNG or JPG, up to 10 MB each" },
        { t: "slot" },
        { t: "actions", items: [{ id: "upload", label: "Upload", variant: "primary", action: { kind: "upload", field: "invoices" } }, { id: "show-alert", label: "Show alert", variant: "secondary", action: { kind: "dialog", type: "alert", message: "Hello from the demo page", accepted: { text: "The alert was closed.", tone: "info" } } }] },
      ],
    },
    { t: "p", text: "Uploaded invoices appear under Orders → Invoices within a minute. Duplicates are detected by invoice number.", tone: "small" },
  ], {
    nav: {
      links: [
        { label: "Products", href: "https://shop.example.com/products" },
        { label: "Orders", href: "https://shop.example.com/orders", active: true },
        { label: "Suppliers", href: "https://shop.example.com/suppliers" },
      ],
      account: "ada@acme.dev",
    },
    maxWidth: 720,
  });
}

function notFound(url: string, site: Site): Page {
  return app(site, url, `Page not found · ${site.name}`, [
    { t: "space", h: 40 },
    { t: "h", text: "404 · Page not found", level: 1, sub: "The page you are looking for does not exist or has moved." },
    { t: "link", id: "home", label: `← Back to ${site.name}`, href: homeOf(site) },
  ], { maxWidth: 640, status: 404 });
}

function homeOf(site: Site): string {
  const home: Record<string, string> = {
    "mail.example.com": "https://mail.example.com/inbox",
    "dashboard.example.com": "https://dashboard.example.com/billing",
    "ci.example.com": "https://ci.example.com/runs",
    "docs.example.com": "https://docs.example.com/guide",
    "shop.example.com": "https://shop.example.com/upload",
  };
  return home[site.host] ?? `https://${site.host}/`;
}

/** Chrome's network error page: an unknown host (DNS), or a local address nothing listens on (refused). */
function errorPage(url: string): Page {
  const host = parseUrl(url)?.hostname || url;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(host);
  return {
    url,
    title: host,
    frame: "error",
    maxWidth: 600,
    background: "#ffffff",
    netError: local ? "ERR_CONNECTION_REFUSED" : "ERR_NAME_NOT_RESOLVED",
    blocks: [
      { t: "glyph", kind: "error" },
      { t: "space", h: 8 },
      { t: "h", text: "This site can’t be reached", level: 1 },
      ...(local
        ? ([
            { t: "p", text: `${host} refused to connect.` },
            { t: "p", text: "Try:" },
            { t: "list", items: ["Checking the connection", "Checking that a server is running on this port", "Checking the proxy and the firewall"] },
            { t: "p", text: "ERR_CONNECTION_REFUSED", tone: "small" },
          ] satisfies Block[])
        : ([
            { t: "p", text: `Check if there is a typo in ${host}.` },
            { t: "p", text: "If spelling is correct, try:" },
            { t: "list", items: ["Checking the connection", "Checking the proxy, firewall, and DNS configuration"] },
            { t: "p", text: "DNS_PROBE_FINISHED_NXDOMAIN", tone: "small" },
          ] satisfies Block[])),
      { t: "space", h: 12 },
      { t: "actions", items: [{ id: "reload", label: "Reload", variant: "primary", action: { kind: "reload" } }] },
    ],
  };
}

/** The page an address shows (hash ignored): a canned site, a 404 of one, a blank page or the network error page. */
export function pageFor(url: string, memory: Memory): Page {
  if (url === "about:blank" || url === "") return { url: "about:blank", title: "about:blank", frame: "blank", maxWidth: 0, background: "#ffffff", blocks: [] };
  const u = parseUrl(url);
  const site = siteOf(url);
  if (!u || !site) return errorPage(url);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  let m: RegExpExecArray | null;
  switch (site.host) {
    case "start.teleflock.demo":
      return path === "/" ? startPage(url) : notFound(url, site);
    case "search.teleflock.demo":
      return path === "/" ? searchPage(url, u.searchParams.get("q") ?? "") : notFound(url, site);
    case "mail.example.com":
      if (path === "/") return mailSignIn(url);
      if (path === "/inbox") return inbox(url, memory);
      if ((m = /^\/message\/(\d+)$/.exec(path))) return message(url, Number(m[1]), memory) ?? notFound(url, site);
      return notFound(url, site);
    case "dashboard.example.com":
      if (path === "/billing") return billing(url);
      if (path === "/invoices") return invoices(url);
      return notFound(url, site);
    case "ci.example.com":
      if (path === "/runs") return runsPage(url);
      if ((m = /^\/runs\/(\d+)$/.exec(path))) return runPage(url, Number(m[1])) ?? notFound(url, site);
      return notFound(url, site);
    case "docs.example.com":
      if (path === "/guide") return guide(url);
      if (path === "/api") return apiPage(url);
      return notFound(url, site);
    case "shop.example.com":
      return path === "/upload" ? uploadPage(url) : notFound(url, site);
  }
  return notFound(url, site);
}

// ---------------------------------------------------------------- layout

const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';

export interface Font {
  size: number;
  weight?: number;
  mono?: boolean;
}

export type Measure = (text: string, font: Font) => number;

function fontCss(f: Font): string {
  return `${f.weight ?? 400} ${f.size}px ${f.mono ? MONO : SANS}`;
}

/** Average glyph widths (em) for when no canvas measures (bun tests): wraps about like a browser. */
export const approxMeasure: Measure = (text, f) => {
  if (f.mono) return text.length * f.size * 0.6;
  let w = 0;
  for (const ch of text) {
    if (ch === " " || /[iljtf.,:;'|!()[\]]/.test(ch)) w += 0.3;
    else if (/[mwMW@]/.test(ch)) w += 0.84;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else if (/[0-9]/.test(ch)) w += 0.56;
    else w += 0.53;
  }
  return w * f.size * ((f.weight ?? 400) >= 600 ? 1.05 : 1);
};

interface Shadow {
  blur: number;
  y: number;
  color: string;
}

export type Item =
  | { k: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; lw?: number; r?: number; dash?: boolean; shadow?: Shadow }
  | { k: "text"; x: number; y: number; text: string; font: Font; color: string; align?: "left" | "center" | "right"; underline?: boolean }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; color: string; w?: number }
  | { k: "circle"; x: number; y: number; r: number; fill?: string; stroke?: string; lw?: number }
  | { k: "path"; points: [number, number][]; color: string; w: number }
  | { k: "clip"; x: number; y: number; w: number; h: number }
  | { k: "unclip" };

export type Role = "link" | "button" | "field" | "checkbox" | "file";

/** An element input can reach: its rectangle in page CSS px and what it does. */
export interface Hit {
  id: string;
  role: Role;
  rect: Rect;
  label: string;
  href?: string;
  target?: "_blank";
  download?: Download;
  action?: Action;
  input?: { type: FieldType | "file"; name: string; autocomplete?: string; placeholder?: string };
  multiple?: boolean;
  backendNodeId?: number;
}

/** A laid-out page: what to paint (page CSS px) and what input can hit. */
export interface Scene {
  width: number;
  /** Document height (≥ the viewport). */
  height: number;
  background: string;
  items: Item[];
  hits: Hit[];
  /** Fragment → top of its heading (page CSS px). */
  anchors: Record<string, number>;
}

function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(v * (1 - f));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

function wrap(text: string, font: Font, width: number, m: Measure): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (m(next, font) <= width) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    line = word;
    while (line.length > 1 && m(line, font) > width) {
      let n = line.length - 1;
      while (n > 1 && m(line.slice(0, n), font) > width) n--;
      out.push(line.slice(0, n));
      line = line.slice(n);
    }
  }
  out.push(line);
  return out;
}

/** The text cut with an ellipsis to `width` (the longest prefix that fits, found by halving). */
function fit(text: string, font: Font, width: number, m: Measure): string {
  if (m(text, font) <= width) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (m(`${text.slice(0, mid)}…`, font) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : "";
}

const INK = "#0f172a";
const BODY = "#334155";
const MUTED = "#64748b";
const BORDER = "#e2e8f0";
const LINK = "#2563eb";
const TONES: Record<Tone, { bg: string; border: string; ink: string; glyph: string }> = {
  info: { bg: "#eff6ff", border: "#bfdbfe", ink: "#1e40af", glyph: "i" },
  success: { bg: "#ecfdf5", border: "#a7f3d0", ink: "#065f46", glyph: "✓" },
  warning: { bg: "#fffbeb", border: "#fde68a", ink: "#92400e", glyph: "!" },
  danger: { bg: "#fef2f2", border: "#fecaca", ink: "#991b1b", glyph: "×" },
};
const CARD_SHADOW: Shadow = { blur: 3, y: 1, color: "rgba(15, 23, 42, 0.06)" };

class Layout {
  readonly items: Item[] = [];
  readonly hits: Hit[] = [];
  readonly anchors: Record<string, number> = {};
  readonly accent: string;
  readonly narrow: boolean;
  private bannerShown = false;

  constructor(
    readonly page: Page,
    readonly s: PageState,
    readonly vw: number,
    readonly vh: number,
    readonly m: Measure,
  ) {
    this.accent = page.site?.color ?? "#1a73e8";
    this.narrow = vw < 640;
  }

  // ------------------------------------------------ primitives

  rect(x: number, y: number, w: number, h: number, o: Omit<Extract<Item, { k: "rect" }>, "k" | "x" | "y" | "w" | "h">): void {
    this.items.push({ k: "rect", x, y, w, h, ...o });
  }

  text(x: number, top: number, lh: number, text: string, font: Font, color: string, o: { align?: "left" | "center" | "right"; underline?: boolean } = {}): void {
    if (text) this.items.push({ k: "text", x, y: top + lh / 2 + font.size * 0.35, text, font, color, ...o });
  }

  line(x1: number, y1: number, x2: number, y2: number, color = BORDER, w = 1): void {
    this.items.push({ k: "line", x1, y1, x2, y2, color, w });
  }

  /** Wrapped text; returns the bottom. */
  para(x: number, y: number, w: number, text: string, font: Font, color: string, lh = Math.round(font.size * 1.6)): number {
    const lines = wrap(text, font, w, this.m);
    lines.forEach((l, i) => this.text(x, y + i * lh, lh, l, font, color));
    return y + lines.length * lh;
  }

  hit(h: Hit): void {
    this.hits.push(h);
  }

  hover(id: string): boolean {
    return this.s.hover === id;
  }

  ring(id: string, x: number, y: number, w: number, h: number, r: number): void {
    if (this.s.focus === id && this.s.focusRing) this.rect(x - 3, y - 3, w + 6, h + 6, { stroke: alpha(this.accent, 0.45), lw: 3, r: r + 3 });
  }

  // ------------------------------------------------ frame

  run(): Scene {
    const { page, vw } = this;
    let top = 0;
    let left = 0;
    const pad = this.narrow ? 16 : 32;
    if (page.frame === "start") top = this.startBar();
    else if (page.frame !== "auth" && page.frame !== "error" && (page.nav || page.site)) top = this.topBar();
    const sidebar = page.sidebar && vw >= 960 ? page.sidebar : undefined;
    const sideAt = this.items.length;
    if (sidebar) left = 248;
    const avail = vw - left;
    const colW = Math.max(120, Math.min(page.maxWidth, avail - 2 * pad));
    const colX = left + (sidebar && page.frame === "app" ? pad : Math.max(pad, (avail - colW) / 2));
    let y = top + (this.narrow ? 20 : 32);
    if (page.frame === "start") y = Math.max(top + 40, Math.round(this.vh * 0.2));
    if (page.frame === "auth") y = Math.max(32, Math.round(this.vh * 0.1));
    if (page.frame === "error") y = Math.max(48, Math.round(this.vh * 0.16));
    if (page.frame === "blank") return { width: vw, height: this.vh, background: page.background, items: [], hits: [], anchors: {} };
    if (!page.blocks.some((b) => b.t === "slot" || (b.t === "panel" && b.blocks.some((c) => c.t === "slot")))) y = this.banner(colX, y, colW);
    y = this.blocks(page.blocks, colX, y, colW);
    const height = Math.max(this.vh, Math.ceil(y + 48));
    if (sidebar) this.sidebar(sidebar, sideAt, top, height);
    return { width: vw, height, background: page.background, items: this.items, hits: this.hits, anchors: this.anchors };
  }

  startBar(): number {
    const { vw, page } = this;
    let x = vw - (this.narrow ? 16 : 24) - 32;
    this.items.push({ k: "circle", x: x + 16, y: 32, r: 16, fill: this.accent });
    this.text(x + 16, 16, 32, page.nav?.account ?? "A", { size: 14, weight: 600 }, "#fff", { align: "center" });
    for (const l of [...(page.nav?.links ?? [])].reverse()) {
      const f: Font = { size: 14, weight: 500 };
      const w = this.m(l.label, f);
      x -= w + 20;
      const id = `top-${l.label.toLowerCase()}`;
      this.text(x, 16, 32, l.label, f, this.hover(id) ? INK : BODY, { underline: this.hover(id) });
      this.hit({ id, role: "link", rect: { x: x - 4, y: 18, width: w + 8, height: 28 }, label: l.label, href: l.href });
    }
    return 64;
  }

  topBar(): number {
    const { vw, page } = this;
    const site = page.site;
    const h = 60;
    const pad = this.narrow ? 16 : 24;
    this.rect(0, 0, vw, h, { fill: "#ffffff" });
    this.line(0, h - 0.5, vw, h - 0.5);
    let x = pad;
    if (site) {
      this.logo(site, x, 16, 28);
      const f: Font = { size: 16, weight: 650 };
      this.text(x + 38, 16, 28, site.name, f, INK);
      x += 38 + this.m(site.name, f) + 32;
    }
    const account = page.nav?.account;
    let right = vw - pad;
    if (account) {
      this.items.push({ k: "circle", x: right - 16, y: h / 2, r: 16, fill: alpha(this.accent, 0.14) });
      this.text(right - 16, h / 2 - 16, 32, account.charAt(0).toUpperCase(), { size: 14, weight: 650 }, this.accent, { align: "center" });
      right -= 44;
      if (account.length > 1 && vw >= 900) {
        const f: Font = { size: 13 };
        right -= this.m(account, f);
        this.text(right, h / 2 - 10, 20, account, f, MUTED);
        right -= 16;
      }
    }
    if (page.nav && vw >= 720) {
      for (const l of page.nav.links) {
        const f: Font = { size: 14, weight: l.active ? 600 : 500 };
        const w = this.m(l.label, f);
        if (x + w > right - 8) break;
        const id = `nav-${l.label.toLowerCase().replace(/\W+/g, "-")}`;
        const hot = this.hover(id);
        this.text(x, 16, 28, l.label, f, l.active || hot ? INK : MUTED, { underline: hot && !l.active });
        if (l.active) this.rect(x, h - 3, w, 3, { fill: this.accent, r: 1.5 });
        this.hit({ id, role: "link", rect: { x: x - 6, y: 12, width: w + 12, height: h - 24 }, label: l.label, href: l.href });
        x += w + 28;
      }
    }
    return h;
  }

  logo(site: Site, x: number, y: number, size: number): void {
    this.rect(x, y, size, size, { fill: site.color, r: size * 0.25 });
    const f: Font = { size: site.letter.length > 1 ? size * 0.42 : size * 0.55, weight: 700 };
    this.text(x + size / 2, y, size, site.letter, f, "#ffffff", { align: "center" });
  }

  sidebar(items: NonNullable<Page["sidebar"]>, at: number, top: number, height: number): void {
    const drawn: Item[] = [];
    const push = (i: Item) => drawn.push(i);
    push({ k: "rect", x: 0, y: top, w: 248, h: height - top, fill: "#ffffff" });
    push({ k: "line", x1: 247.5, y1: top, x2: 247.5, y2: height, color: BORDER, w: 1 });
    let y = top + 20;
    for (const it of items) {
      const id = `side-${it.label.toLowerCase().replace(/\W+/g, "-")}`;
      const hot = this.hover(id);
      if (it.active || hot) push({ k: "rect", x: 12, y, w: 224, h: 36, fill: it.active ? alpha(this.accent, 0.1) : "#f1f5f9", r: 8 });
      const f: Font = { size: 14, weight: it.active ? 600 : 500 };
      push({ k: "text", x: 28, y: y + 18 + f.size * 0.35, text: it.label, font: f, color: it.active ? this.accent : BODY });
      if (it.count) push({ k: "text", x: 220, y: y + 18 + 13 * 0.35, text: it.count, font: { size: 13, weight: 600 }, color: it.active ? this.accent : MUTED, align: "right" });
      this.hit({ id, role: "link", rect: { x: 12, y, width: 224, height: 36 }, label: it.label, href: it.href });
      y += 40;
    }
    this.items.splice(at, 0, ...drawn);
  }

  // ------------------------------------------------ blocks

  blocks(blocks: Block[], x: number, y: number, w: number): number {
    blocks.forEach((b, i) => {
      if (i > 0 && b.t !== "space" && b.t !== "slot" && blocks[i - 1]?.t !== "space") y += this.gap(b);
      y = this.block(b, x, y, w);
    });
    return y;
  }

  gap(b: Block): number {
    if (b.t === "h") return b.level === 1 ? 8 : 28;
    if (b.t === "field" || b.t === "check") return 18;
    return 16;
  }

  block(b: Block, x: number, y: number, w: number): number {
    switch (b.t) {
      case "h": {
        if (b.anchor) this.anchors[b.anchor] = y;
        const size = b.level === 1 ? (this.narrow ? 24 : 30) : b.level === 2 ? 21 : 17;
        const chrome = this.page.frame === "error";
        const f: Font = { size: chrome ? 26 : size, weight: chrome ? 500 : b.level === 1 ? 700 : 650 };
        y = this.para(x, y, w, b.text, f, chrome ? "#202124" : INK, Math.round(f.size * 1.3));
        if (b.sub) y = this.para(x, y + 6, w, b.sub, { size: 15 }, MUTED, 22);
        return y;
      }
      case "p": {
        const f: Font = b.tone === "small" ? { size: 13 } : b.tone === "lead" ? { size: 18 } : { size: 15.5 };
        const color = b.tone === "small" ? MUTED : b.tone === "lead" ? "#475569" : this.page.frame === "error" ? "#5f6368" : BODY;
        return this.para(x, y, w, b.text, f, color);
      }
      case "brand":
        return this.brand(b.text, x, y, w);
      case "field":
        return this.field(b, x, y, w);
      case "check":
        return this.check(b, x, y);
      case "actions":
        return this.actions(b.items, x, y, w, b.align);
      case "link": {
        const f: Font = { size: 15, weight: 500 };
        const label = b.target === "_blank" ? `${b.label} ↗` : b.label;
        const tw = this.m(label, f);
        const hot = this.hover(b.id);
        this.text(x, y, 24, label, f, hot ? shade(LINK, 0.25) : LINK, { underline: hot });
        this.ring(b.id, x - 2, y, tw + 4, 24, 4);
        this.hit({ id: b.id, role: "link", rect: { x, y, width: tw, height: 24 }, label: b.label, href: b.href, target: b.target });
        return y + 24;
      }
      case "list": {
        const f: Font = { size: 15.5 };
        b.items.forEach((item, i) => {
          this.text(x + 4, y, 25, b.ordered ? `${i + 1}.` : "•", f, b.ordered ? MUTED : this.accent);
          y = this.para(x + 26, y, w - 26, item, f, BODY, 25) + 6;
        });
        return y - 6;
      }
      case "code":
        return this.code(b.lines, b.title, x, y, w);
      case "log":
        return this.log(b, x, y, w);
      case "rows":
        return this.rows(b.rows, x, y, w);
      case "table":
        return this.table(b, x, y, w);
      case "cards":
        return this.cards(b.cards, x, y, w);
      case "tiles":
        return this.tiles(b.tiles, x, y, w);
      case "results":
        return this.results(b, x, y, w);
      case "file":
        return this.file(b, x, y, w);
      case "panel": {
        const pad = this.narrow ? 20 : 36;
        const at = this.items.length;
        const bottom = this.blocks(b.blocks, x + pad, y + pad, w - 2 * pad) + pad;
        this.items.splice(at, 0, { k: "rect", x, y, w, h: bottom - y, fill: "#ffffff", stroke: BORDER, r: 16, shadow: { blur: 24, y: 8, color: "rgba(15, 23, 42, 0.08)" } });
        return bottom;
      }
      case "glyph": {
        this.rect(x + 4, y, 44, 54, { fill: "#f1f3f4", stroke: "#9aa0a6", lw: 2, r: 4 });
        this.line(x + 14, y + 18, x + 22, y + 26, "#5f6368", 2.5);
        this.line(x + 22, y + 18, x + 14, y + 26, "#5f6368", 2.5);
        this.line(x + 30, y + 18, x + 38, y + 26, "#5f6368", 2.5);
        this.line(x + 38, y + 18, x + 30, y + 26, "#5f6368", 2.5);
        this.line(x + 15, y + 40, x + 37, y + 40, "#5f6368", 2.5);
        return y + 58;
      }
      case "divider":
        this.line(x, y + 8.5, x + w, y + 8.5);
        return y + 17;
      case "space":
        return y + b.h;
      case "slot":
        return this.banner(x, y, w);
    }
  }

  banner(x: number, y: number, w: number): number {
    const b = this.s.banner;
    if (!b || this.bannerShown) return y;
    this.bannerShown = true;
    const t = TONES[b.tone];
    const f: Font = { size: 14.5, weight: 500 };
    const lines = wrap(b.text, f, w - 64, this.m);
    const h = Math.max(48, lines.length * 22 + 26);
    this.rect(x, y, w, h, { fill: t.bg, stroke: t.border, r: 10 });
    this.items.push({ k: "circle", x: x + 26, y: y + 24, r: 10, fill: t.ink });
    this.text(x + 26, y + 14, 20, t.glyph, { size: 13, weight: 700 }, "#ffffff", { align: "center" });
    lines.forEach((l, i) => this.text(x + 48, y + 13 + i * 22, 22, l, f, t.ink));
    return y + h + 16;
  }

  brand(text: string, x: number, y: number, w: number): number {
    const site = this.page.site;
    if (this.page.frame === "start" && site) {
      const f: Font = { size: this.narrow ? 44 : 60, weight: 700 };
      const tw = this.m(text, f);
      const colors = ["#4f46e5", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0284c7"];
      let cx = x + (w - tw) / 2;
      [...text].forEach((ch, i) => {
        this.text(cx, y, f.size * 1.2, ch, f, colors[i % colors.length] ?? INK);
        cx += this.m(ch, f);
      });
      return y + f.size * 1.2;
    }
    if (site) this.logo(site, x, y, 40);
    return y + 40;
  }

  field(b: Extract<Block, { t: "field" }>, x: number, y: number, w: number): number {
    const s = this.s;
    if (b.label) {
      this.text(x, y, 20, b.label, { size: 14, weight: 550 }, BODY);
      y += 26;
    }
    const big = !!b.big;
    const h = big ? 52 : 42;
    const r = big ? h / 2 : b.type === "search" ? h / 2 : 8;
    const focused = s.focus === b.id;
    const hot = this.hover(b.id);
    if (focused) this.rect(x - 3, y - 3, w + 6, h + 6, { fill: alpha(this.accent, 0.16), r: r + 3 });
    this.rect(x, y, w, h, { fill: "#ffffff", stroke: focused ? this.accent : hot ? "#94a3b8" : "#cbd5e1", lw: focused ? 1.5 : 1, r, shadow: big ? { blur: 14, y: 3, color: "rgba(15, 23, 42, 0.10)" } : undefined });
    let tx = x + 14;
    if (b.type === "search") {
      const cx = x + (big ? 26 : 20);
      const cy = y + h / 2 - 1;
      this.items.push({ k: "circle", x: cx, y: cy, r: big ? 7 : 6, stroke: MUTED, lw: 2 });
      this.line(cx + 5, cy + 5, cx + 10, cy + 10, MUTED, 2);
      tx = x + (big ? 48 : 40);
    }
    const innerW = w - (tx - x) - 14;
    const value = s.values[b.id] ?? "";
    const shown = b.type === "password" ? "•".repeat(value.length) : value;
    const comp = focused ? s.composition : "";
    const caret = Math.min(s.caret, shown.length);
    const display = focused && comp ? shown.slice(0, caret) + comp + shown.slice(caret) : shown;
    const f: Font = { size: big ? 17 : 15 };
    const caretPx = this.m(display.slice(0, caret + comp.length), f);
    const off = focused ? Math.max(0, caretPx - innerW + 2) : 0;
    const lh = 22;
    const top = y + (h - lh) / 2;
    this.items.push({ k: "clip", x: tx - 2, y: y + 1, w: innerW + 4, h: h - 2 });
    const [a, z] = s.anchor <= s.caret ? [s.anchor, s.caret] : [s.caret, s.anchor];
    if (focused && a !== z) {
      const sx = this.m(display.slice(0, a), f);
      const ex = this.m(display.slice(0, z), f);
      this.rect(tx - off + sx, top, ex - sx, lh, { fill: alpha(this.accent, 0.25) });
    }
    if (display) this.text(tx - off, top, lh, display, f, INK);
    else if (b.placeholder) this.text(tx, top, lh, b.placeholder, f, "#94a3b8");
    if (comp) {
      const cx = tx - off + this.m(display.slice(0, caret), f);
      this.line(cx, top + lh - 1, cx + this.m(comp, f), top + lh - 1, INK, 1.5);
    }
    if (focused && a === z) {
      const cx = Math.round(tx - off + caretPx) + 0.5;
      this.line(cx, top + 1, cx, top + lh - 1, INK, 1.5);
    }
    this.items.push({ k: "unclip" });
    this.hit({ id: b.id, role: "field", rect: { x, y, width: w, height: h }, label: b.label ?? b.placeholder ?? b.name, input: { type: b.type, name: b.name, autocomplete: b.autocomplete, placeholder: b.placeholder } });
    return y + h;
  }

  check(b: Extract<Block, { t: "check" }>, x: number, y: number): number {
    const on = !!this.s.checked[b.id];
    const hot = this.hover(b.id);
    const f: Font = { size: 14.5 };
    this.ring(b.id, x, y + 1, 18, 18, 4);
    this.rect(x, y + 1, 18, 18, { fill: on ? this.accent : "#ffffff", stroke: on ? this.accent : hot ? "#64748b" : "#94a3b8", lw: 1.5, r: 4 });
    if (on) this.items.push({ k: "path", points: [[x + 4.5, y + 10], [x + 8, y + 13.5], [x + 14, y + 6.5]], color: "#ffffff", w: 2 });
    this.text(x + 28, y, 20, b.label, f, BODY);
    this.hit({ id: b.id, role: "checkbox", rect: { x, y, width: 28 + this.m(b.label, f), height: 20 }, label: b.label });
    return y + 20;
  }

  actions(items: Control[], x: number, y: number, w: number, align?: "between"): number {
    let cx = x;
    let rowTop = y;
    const h = 40;
    const placed: { c: Control; x: number; y: number; w: number }[] = [];
    for (const c of items) {
      const f: Font = c.variant === "link" ? { size: 14.5, weight: 500 } : { size: 14.5, weight: 600 };
      const label = c.icon ? `${c.icon}  ${c.label}` : c.label;
      const bw = c.full ? w : this.m(label, f) + (c.variant === "link" ? 4 : 36);
      if (cx > x && cx + bw > x + w) {
        cx = x;
        rowTop += h + 12;
      }
      placed.push({ c, x: cx, y: rowTop, w: bw });
      cx += bw + 12;
    }
    if (align === "between" && placed.length === 2 && placed[0]?.y === placed[1]?.y && placed[1]) placed[1].x = x + w - placed[1].w;
    for (const p of placed) this.control(p.c, p.x, p.y, p.w, h);
    return rowTop + h;
  }

  control(c: Control, x: number, y: number, w: number, h: number): void {
    const hot = this.hover(c.id);
    const down = this.s.pressed === c.id;
    const label = c.icon ? `${c.icon}  ${c.label}` : c.label;
    const variant = c.variant ?? "secondary";
    if (variant === "link") {
      const f: Font = { size: 14.5, weight: 500 };
      this.text(x, y, h, label, f, hot ? shade(this.accent, 0.2) : this.accent, { underline: hot });
      this.ring(c.id, x - 2, y + 8, w, h - 16, 4);
    } else {
      const f: Font = { size: 14.5, weight: 600 };
      const fill =
        variant === "primary" ? (down ? shade(this.accent, 0.22) : hot ? shade(this.accent, 0.12) : this.accent) : variant === "danger" ? (down ? "#fee2e2" : hot ? "#fef2f2" : "#ffffff") : down ? "#e2e8f0" : hot ? "#f1f5f9" : "#ffffff";
      const stroke = variant === "primary" ? undefined : variant === "danger" ? "#fca5a5" : "#cbd5e1";
      this.ring(c.id, x, y, w, h, 8);
      this.rect(x, y, w, h, { fill, stroke, r: 8, shadow: variant === "primary" ? { blur: 2, y: 1, color: "rgba(15, 23, 42, 0.18)" } : CARD_SHADOW });
      const color = variant === "primary" ? "#ffffff" : variant === "danger" ? "#b91c1c" : INK;
      this.text(x + w / 2, y, h, label, f, color, { align: "center" });
    }
    const rect = { x, y, width: w, height: h };
    if (c.action) this.hit({ id: c.id, role: "button", rect, label: c.label, action: c.action });
    else if (c.href) this.hit({ id: c.id, role: "link", rect, label: c.label, href: c.href, target: c.target, download: c.download });
  }

  code(lines: string[], title: string | undefined, x: number, y: number, w: number): number {
    const lh = 21;
    const head = title ? 34 : 0;
    const h = head + 16 * 2 + lines.length * lh;
    this.rect(x, y, w, h, { fill: "#0f172a", r: 10 });
    if (title) {
      this.text(x + 16, y, head, title, { size: 12.5, weight: 600 }, "#94a3b8");
      this.line(x, y + head - 0.5, x + w, y + head - 0.5, "#1e293b");
    }
    this.items.push({ k: "clip", x, y, w, h });
    const f: Font = { size: 13.5, mono: true };
    lines.forEach((l, i) => {
      const color = l.startsWith("$") ? "#93c5fd" : l.startsWith("✓") ? "#86efac" : /^\s*(#|\/\/)/.test(l) ? "#64748b" : /^\[/.test(l) ? "#f9a8d4" : "#e2e8f0";
      this.text(x + 18, y + head + 16 + i * lh, lh, l, f, color);
    });
    this.items.push({ k: "unclip" });
    return y + h;
  }

  log({ lines, title, dot }: Extract<Block, { t: "log" }>, x: number, y: number, w: number): number {
    const lh = 20;
    const head = 40;
    const h = head + 12 * 2 + lines.length * lh;
    this.rect(x, y, w, h, { fill: "#0b1120", r: 12 });
    this.items.push({ k: "circle", x: x + 20, y: y + head / 2, r: 4.5, fill: dot });
    this.text(x + 34, y, head, title, { size: 13, weight: 600 }, "#e2e8f0");
    this.text(x + w - 16, y, head, `${lines.length} lines`, { size: 12.5 }, "#64748b", { align: "right" });
    this.line(x, y + head - 0.5, x + w, y + head - 0.5, "#1e293b");
    this.items.push({ k: "clip", x, y, w, h });
    const f: Font = { size: 12.5, mono: true };
    const gutter = 52;
    lines.forEach((l, i) => {
      const top = y + head + 12 + i * lh;
      this.text(x + gutter - 14, top, lh, String(i + 1), f, "#475569", { align: "right" });
      const group = l.startsWith("##[group]");
      const text = group ? `▾ ${l.slice(9)}` : l.startsWith("##[endgroup]") ? "" : l;
      const color = group ? "#f8fafc" : /✗|Error|AssertionError|failed/.test(l) ? "#f87171" : /^\s*✓|passed|succeeded/.test(l) ? "#4ade80" : /warning|…$/.test(l) ? "#fbbf24" : "#cbd5e1";
      this.text(x + gutter, top, lh, text, group ? { ...f, weight: 700 } : f, color);
    });
    this.items.push({ k: "unclip" });
    return y + h;
  }

  rows(rows: Row[], x: number, y: number, w: number): number {
    const h = 68;
    const total = rows.length * h;
    this.rect(x, y, w, total, { fill: "#ffffff", stroke: BORDER, r: 12, shadow: CARD_SHADOW });
    rows.forEach((r, i) => {
      const top = y + i * h;
      const hot = this.hover(r.id);
      if (hot) this.rect(x + 1, top + (i === 0 ? 1 : 0), w - 2, h - (i === 0 || i === rows.length - 1 ? 1 : 0), { fill: "#f8fafc", r: i === 0 || i === rows.length - 1 ? 11 : 0 });
      if (i > 0) this.line(x, top + 0.5, x + w, top + 0.5, "#eef2f6");
      let tx = x + 22;
      if (r.avatar) {
        this.items.push({ k: "circle", x: tx + 18, y: top + h / 2, r: 18, fill: r.avatar.color });
        this.text(tx + 18, top + h / 2 - 12, 24, r.avatar.letter, { size: 15, weight: 600 }, "#ffffff", { align: "center" });
        tx += 50;
      } else if (r.dot) {
        this.items.push({ k: "circle", x: tx + 6, y: top + 23, r: 6, fill: r.dot });
        if (r.dot === STATUS_COLOR.running) this.items.push({ k: "circle", x: tx + 6, y: top + 23, r: 9, stroke: alpha("#d97706", 0.35), lw: 2 });
        tx += 26;
      }
      if (r.bold) this.items.push({ k: "circle", x: x + 11, y: top + h / 2, r: 3.5, fill: this.accent });
      const metaF: Font = { size: 13, weight: r.bold ? 600 : 400 };
      const metaW = r.meta ? this.m(r.meta, metaF) : 0;
      const right = x + w - 18;
      if (r.meta) this.text(right, top + 12, 22, r.meta, metaF, r.bold ? INK : MUTED, { align: "right" });
      const titleF: Font = { size: 15, weight: r.bold ? 700 : 550 };
      const titleW = right - tx - metaW - 16;
      const title = fit(r.title, titleF, titleW, this.m);
      this.text(tx, top + 12, 22, title, titleF, INK, { underline: hot && !r.avatar });
      if (r.badge) {
        const bt = TONES[r.badge.tone];
        const bx = tx + this.m(title, titleF) + 10;
        const bf: Font = { size: 11.5, weight: 600 };
        const bw = this.m(r.badge.text, bf) + 14;
        if (bx + bw < right - metaW - 8) {
          this.rect(bx, top + 14, bw, 19, { fill: bt.bg, stroke: bt.border, r: 9.5 });
          this.text(bx + bw / 2, top + 14, 19, r.badge.text, bf, bt.ink, { align: "center" });
        }
      }
      const line2W = right - tx;
      const leadF: Font = { size: 14, weight: r.bold ? 600 : 400 };
      const lead = r.lead ? fit(r.lead, leadF, line2W, this.m) : "";
      const leadW = lead ? this.m(lead, leadF) : 0;
      if (lead) this.text(tx, top + 36, 20, lead, leadF, r.bold ? INK : BODY);
      if (r.snippet && leadW < line2W - 40) {
        const sep = r.lead && !r.snippet.startsWith(" ") ? " — " : "";
        const snip = fit(sep + r.snippet, { size: 14 }, line2W - leadW, this.m);
        this.text(tx + leadW, top + 36, 20, snip, { size: 14 }, MUTED);
      }
      this.hit({ id: r.id, role: "link", rect: { x, y: top, width: w, height: h }, label: r.lead ? `${r.title} ${r.lead}` : r.title, href: r.href });
    });
    return y + total;
  }

  table(b: Extract<Block, { t: "table" }>, x: number, y: number, w: number): number {
    const minWidth = (c: Column) => (c.optional ? 110 : 80) * c.weight;
    let cols = b.columns.map((c, i) => ({ c, i }));
    while (cols.reduce((n, k) => n + minWidth(k.c), 0) > w - 32 && cols.some((k) => k.c.optional)) {
      const drop = [...cols].reverse().find((k) => k.c.optional);
      cols = cols.filter((k) => k !== drop);
    }
    const weight = cols.reduce((n, k) => n + k.c.weight, 0);
    const inner = w - 32;
    const query = b.filter ? (this.s.values[b.filter] ?? "").trim().toLowerCase() : "";
    const rows = query ? b.rows.filter((r) => (r[0] ?? "").toLowerCase().includes(query)) : b.rows;
    const headH = 40;
    const rowH = 46;
    const h = headH + Math.max(1, rows.length) * rowH;
    this.rect(x, y, w, h, { fill: "#ffffff", stroke: BORDER, r: 12, shadow: CARD_SHADOW });
    this.rect(x + 1, y + 1, w - 2, headH - 1, { fill: "#f8fafc", r: 11 });
    this.rect(x + 1, y + headH - 12, w - 2, 12, { fill: "#f8fafc" });
    this.line(x, y + headH - 0.5, x + w, y + headH - 0.5);
    const xs: number[] = [];
    let cx = x + 16;
    for (const k of cols) {
      xs.push(cx);
      cx += (inner * k.c.weight) / weight;
    }
    cols.forEach((k, j) => {
      const cw = (inner * k.c.weight) / weight;
      const at = xs[j] ?? x;
      const right = k.c.align === "right";
      this.text(right ? at + cw - (j === cols.length - 1 ? 4 : 28) : at, y, headH, k.c.label.toUpperCase(), { size: 11.5, weight: 650 }, MUTED, { align: right ? "right" : "left" });
    });
    if (!rows.length) this.text(x + 16, y + headH, rowH, b.empty ?? "Nothing to show.", { size: 14 }, MUTED);
    rows.forEach((r, i) => {
      const top = y + headH + i * rowH;
      if (i > 0) this.line(x, top + 0.5, x + w, top + 0.5, "#eef2f6");
      cols.forEach((k, j) => {
        const cw = (inner * k.c.weight) / weight;
        const at = xs[j] ?? x;
        const value = r[k.i] ?? "";
        const right = k.c.align === "right";
        if (k.c.pill) {
          const tone: Tone = /^Paid$/.test(value) ? "success" : /^Due/.test(value) ? "warning" : "info";
          const pf: Font = { size: 12, weight: 600 };
          const text = fit(value, pf, cw - 24, this.m);
          const pw = this.m(text, pf) + 18;
          const t = k.c.label === "Plan" ? { bg: "#f1f5f9", border: BORDER, ink: BODY } : TONES[tone];
          this.rect(at, top + 12, pw, 22, { fill: t.bg, stroke: t.border, r: 11 });
          this.text(at + pw / 2, top + 12, 22, text, pf, t.ink, { align: "center" });
          return;
        }
        const f: Font = j === 0 ? { size: 14, weight: 600 } : { size: 14 };
        const text = fit(value, f, cw - 12, this.m);
        this.text(right ? at + cw - (j === cols.length - 1 ? 4 : 28) : at, top, rowH, text, f, j === 0 ? INK : BODY, { align: right ? "right" : "left" });
      });
    });
    return y + h;
  }

  cards(cards: Extract<Block, { t: "cards" }>["cards"], x: number, y: number, w: number): number {
    const gap = 16;
    const n = Math.max(1, Math.min(cards.length, Math.floor((w + gap) / (168 + gap))));
    const cw = (w - gap * (n - 1)) / n;
    const h = 116;
    cards.forEach((c, i) => {
      const cx = x + (i % n) * (cw + gap);
      const cy = y + Math.floor(i / n) * (h + gap);
      this.rect(cx, cy, cw, h, { fill: "#ffffff", stroke: BORDER, r: 12, shadow: CARD_SHADOW });
      this.text(cx + 20, cy + 16, 20, c.label, { size: 13.5, weight: 500 }, MUTED);
      // Figures shrink to their card (as `clamp()` type would) before they are cut.
      const vf: Font = { size: 26, weight: 700 };
      while (vf.size > 18 && this.m(c.value, vf) > cw - 40) vf.size--;
      this.text(cx + 20, cy + 42, 36, fit(c.value, vf, cw - 40, this.m), vf, INK);
      const color = c.tone === "up" ? "#047857" : c.tone === "down" ? "#b91c1c" : MUTED;
      this.text(cx + 20, cy + 82, 20, fit(c.note, { size: 13 }, cw - 40, this.m), { size: 13, weight: 500 }, color);
    });
    const rowsN = Math.ceil(cards.length / n);
    return y + rowsN * h + (rowsN - 1) * gap;
  }

  tiles(tiles: Extract<Block, { t: "tiles" }>["tiles"], x: number, y: number, w: number): number {
    const tw = 104;
    const th = 112;
    const n = Math.max(1, Math.min(tiles.length, Math.floor(w / tw)));
    const rowsN = Math.ceil(tiles.length / n);
    tiles.forEach((t, i) => {
      const row = Math.floor(i / n);
      const inRow = row === rowsN - 1 ? tiles.length - row * n : n;
      const left = x + (w - inRow * tw) / 2;
      const tx = left + (i % n) * tw;
      const ty = y + row * th;
      const hot = this.hover(t.id);
      if (hot) this.rect(tx + 4, ty, tw - 8, th - 4, { fill: "#f1f5f9", r: 12 });
      this.ring(t.id, tx + 4, ty, tw - 8, th - 4, 12);
      this.items.push({ k: "circle", x: tx + tw / 2, y: ty + 40, r: 26, fill: alpha(t.site.color, 0.12) });
      this.text(tx + tw / 2, ty + 26, 28, t.site.letter, { size: t.site.letter.length > 1 ? 15 : 20, weight: 700 }, t.site.color, { align: "center" });
      this.text(tx + tw / 2, ty + 74, 22, t.label, { size: 13.5, weight: 500 }, BODY, { align: "center" });
      this.hit({ id: t.id, role: "link", rect: { x: tx + 4, y: ty, width: tw - 8, height: th - 4 }, label: t.label, href: t.href });
    });
    return y + rowsN * th;
  }

  results(b: Extract<Block, { t: "results" }>, x: number, y: number, w: number): number {
    y = this.para(x, y, w, b.stats, { size: 13.5 }, "#70757a", 20) + 18;
    b.items.forEach((r) => {
      this.items.push({ k: "circle", x: x + 14, y: y + 16, r: 14, fill: alpha(r.site.color, 0.12) });
      this.text(x + 14, y + 6, 20, r.site.letter, { size: r.site.letter.length > 1 ? 9 : 12, weight: 700 }, r.site.color, { align: "center" });
      this.text(x + 38, y, 18, r.site.name, { size: 14, weight: 500 }, "#202124");
      const u = new URL(r.href);
      const crumbs = [u.origin, ...u.pathname.split("/").filter(Boolean)].join(" › ");
      this.text(x + 38, y + 17, 18, fit(crumbs, { size: 12.5 }, w - 40, this.m), { size: 12.5 }, "#4d5156");
      y += 42;
      const hot = this.hover(r.id);
      const tf: Font = { size: 20, weight: 400 };
      const title = fit(r.title, tf, w, this.m);
      this.text(x, y, 28, title, tf, "#1a0dab", { underline: hot });
      this.hit({ id: r.id, role: "link", rect: { x, y, width: Math.min(w, this.m(title, tf)), height: 28 }, label: r.title, href: r.href });
      y = this.para(x, y + 32, w, r.snippet, { size: 14 }, "#4d5156", 22) + 28;
    });
    return y;
  }

  file(b: Extract<Block, { t: "file" }>, x: number, y: number, w: number): number {
    const files = this.s.files[b.id] ?? [];
    const h = 168;
    const hot = this.hover(b.id);
    this.rect(x, y, w, h, { fill: hot ? alpha(this.accent, 0.05) : "#f8fafc", stroke: hot ? this.accent : "#cbd5e1", lw: 1.5, r: 12, dash: true });
    const cx = x + w / 2;
    this.items.push({ k: "circle", x: cx, y: y + 40, r: 22, fill: alpha(this.accent, 0.12) });
    this.items.push({ k: "path", points: [[cx - 7, y + 40], [cx, y + 33], [cx + 7, y + 40]], color: this.accent, w: 2.2 });
    this.line(cx, y + 34, cx, y + 49, this.accent, 2.2);
    this.text(cx, y + 70, 22, "Drag invoices here, or", { size: 14.5, weight: 500 }, BODY, { align: "center" });
    const f: Font = { size: 14, weight: 600 };
    const bw = this.m(b.label, f) + 32;
    const bx = cx - bw / 2;
    const by = y + 98;
    this.ring(b.id, bx, by, bw, 36, 8);
    this.rect(bx, by, bw, 36, { fill: hot ? "#f1f5f9" : "#ffffff", stroke: "#cbd5e1", r: 8, shadow: CARD_SHADOW });
    this.text(cx, by, 36, b.label, f, INK, { align: "center" });
    this.text(cx, y + 140, 22, b.hint, { size: 12.5 }, MUTED, { align: "center" });
    this.hit({ id: b.id, role: "file", rect: { x: bx, y: by, width: bw, height: 36 }, label: b.label, multiple: b.multiple, backendNodeId: b.backendNodeId, input: { type: "file", name: b.name } });
    y += h + 14;
    if (!files.length) return this.para(x, y, w, "No files chosen", { size: 14 }, MUTED, 22);
    files.forEach((name, i) => {
      const top = y + i * 44;
      this.rect(x, top, w, 38, { fill: "#ffffff", stroke: BORDER, r: 8 });
      this.rect(x + 12, top + 9, 16, 20, { fill: alpha(this.accent, 0.15), stroke: this.accent, lw: 1, r: 3 });
      this.text(x + 40, top, 38, fit(name, { size: 14, weight: 500 }, w - 140, this.m), { size: 14, weight: 500 }, INK);
      this.text(x + w - 14, top, 38, "Ready", { size: 12.5, weight: 500 }, "#047857", { align: "right" });
    });
    return y + files.length * 44 - 6;
  }
}

/** Lays a page out for a viewport (CSS px) with its current state. */
export function layoutPage(page: Page, state: PageState, viewport: { width: number; height: number }, measure: Measure): Scene {
  return new Layout(page, state, viewport.width, viewport.height, measure).run();
}

/** The topmost element at a point of the page (page CSS px). */
export function hitAt(scene: Scene, x: number, y: number): Hit | undefined {
  for (let i = scene.hits.length - 1; i >= 0; i--) {
    const h = scene.hits[i];
    if (h && x >= h.rect.x && x < h.rect.x + h.rect.width && y >= h.rect.y && y < h.rect.y + h.rect.height) return h;
  }
  return undefined;
}

export function findHit(scene: Scene, id: string): Hit | undefined {
  return scene.hits.find((h) => h.id === id);
}

/** What Tab moves through: fields, checkboxes, file fields and buttons, in document order. */
export function focusables(scene: Scene): Hit[] {
  return scene.hits
    .filter((h) => h.role !== "link")
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

// ---------------------------------------------------------------- paint

/** One screencast frame or screenshot to paint. */
export interface FrameRequest {
  scene: Scene;
  scrollY: number;
  /** Viewport in CSS px. */
  viewport: { width: number; height: number };
  /** Image size in pixels. */
  pixelWidth: number;
  pixelHeight: number;
  format: "jpeg" | "png";
  /** 0–100. */
  quality: number;
}

/** 1×1 white images for where no canvas exists. */
const BLANK_JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AQH//2Q==";
const BLANK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: Ctx2D } | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function encode(canvas: AnyCanvas, type: "image/jpeg" | "image/png", quality: number): Promise<string> {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type, quality });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  const url = (canvas as HTMLCanvasElement).toDataURL(type, quality);
  return url.slice(url.indexOf(",") + 1);
}

let measureCtx: Ctx2D | null | undefined;

/** Text widths from a canvas when there is one (the browser), else the approximation (bun tests). */
export function defaultMeasure(): Measure {
  if (measureCtx === undefined) measureCtx = makeCanvas(1, 1)?.ctx ?? null;
  const ctx = measureCtx;
  if (!ctx) return approxMeasure;
  // Every hover or keystroke lays the page out again: the same strings come back each time.
  const memo = new Map<string, number>();
  return (text, f) => {
    const css = fontCss(f);
    const key = `${css}\u0000${text}`;
    let w = memo.get(key);
    if (w === undefined) {
      if (memo.size > 20_000) memo.clear();
      ctx.font = css;
      w = ctx.measureText(text).width;
      memo.set(key, w);
    }
    return w;
  };
}

/** The vertical extent an item paints (page px); clip markers have none. */
function extent(it: Item): [number, number] | null {
  switch (it.k) {
    case "rect":
      return [it.y - (it.shadow ? it.shadow.blur + it.shadow.y : 0), it.y + it.h + (it.shadow ? it.shadow.blur + it.shadow.y : 0)];
    case "text":
      return [it.y - it.font.size * 1.2, it.y + it.font.size * 0.4];
    case "line":
      return [Math.min(it.y1, it.y2) - (it.w ?? 1), Math.max(it.y1, it.y2) + (it.w ?? 1)];
    case "circle":
      return [it.y - it.r - (it.lw ?? 0), it.y + it.r + (it.lw ?? 0)];
    case "path": {
      const ys = it.points.map((p) => p[1]);
      return [Math.min(...ys) - it.w, Math.max(...ys) + it.w];
    }
    default:
      return null;
  }
}

/** Paints items; with `view`, only those that reach into it (a long log page holds thousands). */
function drawItems(ctx: Ctx2D, items: Item[], view?: { top: number; bottom: number }): void {
  for (const it of items) {
    const span = view ? extent(it) : null;
    if (span && view && (span[1] < view.top || span[0] > view.bottom)) continue;
    switch (it.k) {
      case "rect": {
        ctx.save();
        if (it.shadow) {
          ctx.shadowColor = it.shadow.color;
          ctx.shadowBlur = it.shadow.blur;
          ctx.shadowOffsetY = it.shadow.y;
        }
        ctx.beginPath();
        if (it.r) ctx.roundRect(it.x, it.y, it.w, it.h, it.r);
        else ctx.rect(it.x, it.y, it.w, it.h);
        if (it.fill) {
          ctx.fillStyle = it.fill;
          ctx.fill();
        }
        ctx.shadowColor = "transparent";
        if (it.stroke) {
          ctx.strokeStyle = it.stroke;
          ctx.lineWidth = it.lw ?? 1;
          if (it.dash) ctx.setLineDash([6, 4]);
          ctx.stroke();
        }
        ctx.restore();
        break;
      }
      case "text": {
        ctx.font = fontCss(it.font);
        ctx.fillStyle = it.color;
        ctx.textAlign = it.align ?? "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(it.text, it.x, it.y);
        if (it.underline) {
          const w = ctx.measureText(it.text).width;
          const x0 = it.align === "center" ? it.x - w / 2 : it.align === "right" ? it.x - w : it.x;
          ctx.fillRect(x0, it.y + 2, w, Math.max(1, it.font.size / 14));
        }
        break;
      }
      case "line":
        ctx.beginPath();
        ctx.moveTo(it.x1, it.y1);
        ctx.lineTo(it.x2, it.y2);
        ctx.strokeStyle = it.color;
        ctx.lineWidth = it.w ?? 1;
        ctx.lineCap = "round";
        ctx.stroke();
        break;
      case "circle":
        ctx.beginPath();
        ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
        if (it.fill) {
          ctx.fillStyle = it.fill;
          ctx.fill();
        }
        if (it.stroke) {
          ctx.strokeStyle = it.stroke;
          ctx.lineWidth = it.lw ?? 1;
          ctx.stroke();
        }
        break;
      case "path": {
        ctx.beginPath();
        it.points.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
        ctx.strokeStyle = it.color;
        ctx.lineWidth = it.w;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        break;
      }
      case "clip":
        ctx.save();
        ctx.beginPath();
        ctx.rect(it.x, it.y, it.w, it.h);
        ctx.clip();
        break;
      case "unclip":
        ctx.restore();
        break;
    }
  }
}

/** Paints a frame with Canvas 2D: base64 JPEG/PNG without the `data:` prefix (a 1×1 image where no canvas exists). */
export async function paintFrame(req: FrameRequest): Promise<string> {
  const made = makeCanvas(Math.max(1, Math.round(req.pixelWidth)), Math.max(1, Math.round(req.pixelHeight)));
  if (!made) return req.format === "png" ? BLANK_PNG : BLANK_JPEG;
  const { canvas, ctx } = made;
  const k = req.pixelWidth / req.viewport.width;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = req.scene.background;
  ctx.fillRect(0, 0, req.viewport.width, req.viewport.height);
  ctx.translate(0, -req.scrollY);
  drawItems(ctx, req.scene.items, { top: req.scrollY, bottom: req.scrollY + req.viewport.height });
  return encode(canvas, req.format === "png" ? "image/png" : "image/jpeg", Math.min(1, Math.max(0, req.quality / 100)));
}

/** A site's icon: a 32×32 PNG, its letter on a rounded square in its colour (a 1×1 PNG where no canvas exists). */
export async function paintIcon(site: Site): Promise<string> {
  const made = makeCanvas(32, 32);
  if (!made) return BLANK_PNG;
  const { canvas, ctx } = made;
  drawItems(ctx, [
    { k: "rect", x: 0, y: 0, w: 32, h: 32, fill: site.color, r: 8 },
    { k: "text", x: 16, y: 16 + (site.letter.length > 1 ? 13 : 18) * 0.36, text: site.letter, font: { size: site.letter.length > 1 ? 13 : 18, weight: 700 }, color: "#ffffff", align: "center" },
  ]);
  return encode(canvas, "image/png", 1);
}
