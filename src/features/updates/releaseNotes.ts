import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * "What's new" after an update: the GitHub release notes of every version since the last one this
 * device showed. Pure helpers (semver, the skipped-versions range, the idle gate) first, then the
 * persisted per-device record and the one-request-per-launch loader. The modal and the hook that
 * starts the check are in `WhatsNew.tsx`.
 */

declare const __APP_VERSION__: string | undefined;

/** The running build's version (Vite injects it from package.json); "dev" under bun test. */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** `owner/repo` of the releases (the same public repo `src-tauri/src/update/release.rs` reads). */
export const REPO = "studioplascode/TeleFlock";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/** Failed starts after which a short "read it on GitHub" modal replaces the notes. */
export const MAX_FAILED_STARTS = 3;
/** How long the user must have stopped typing before the modal may appear. */
export const TYPING_IDLE_MS = 3000;
/** The fetched release list is reused for this long (manual reopen, a later launch's retry). */
const CACHE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// ---- semver -------------------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers (`rc.1` → ["rc", "1"]); empty for a release. */
  pre: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses `1.2.3`, `v1.2.3-rc.1`, `1.2.3+build`; null for anything else (including "dev"). */
export function parseVersion(raw: string): Semver | null {
  const m = SEMVER.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] };
}

/** Semver 2.0 precedence: negative when a < b. A pre-release sorts below its release. */
export function compareVersions(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]!;
    const y = b.pre[i]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

// ---- releases -----------------------------------------------------------------------------------

/** One GitHub release, reduced to what the modal shows. */
export interface ReleaseNote {
  /** Version without the leading `v`. */
  version: string;
  tag: string;
  name: string;
  /** Markdown release notes; empty when the release has none. */
  body: string;
  url: string;
  /** ISO timestamp, when published. */
  date?: string;
  prerelease: boolean;
}

/** Reads `GET /repos/{REPO}/releases` JSON; drafts and tags that aren't versions are dropped. */
export function parseReleases(json: unknown): ReleaseNote[] {
  if (!Array.isArray(json)) return [];
  const out: ReleaseNote[] = [];
  for (const r of json as unknown[]) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const tag = typeof o.tag_name === "string" ? o.tag_name : "";
    const v = parseVersion(tag);
    if (!v || o.draft === true) continue;
    out.push({
      version: tag.replace(/^v/, ""),
      tag,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : tag,
      body: typeof o.body === "string" ? o.body.trim() : "",
      url: typeof o.html_url === "string" && o.html_url.startsWith("https://") ? o.html_url : `${RELEASES_PAGE}/tag/${tag}`,
      date: typeof o.published_at === "string" ? o.published_at : undefined,
      prerelease: o.prerelease === true || v.pre.length > 0,
    });
  }
  return out;
}

/**
 * The releases an update from `from` to `to` brought, newest first: every version above `from` up
 * to and including `to` (0.7.0 → 0.9.0 yields 0.9.0 and 0.8.x). Pre-releases only count when `to`
 * is one itself, so a stable user never reads release-candidate notes.
 */
export function releasesBetween(releases: ReleaseNote[], from: string, to: string): ReleaseNote[] {
  const lo = parseVersion(from);
  const hi = parseVersion(to);
  if (!lo || !hi) return [];
  const seen = new Set<string>();
  return releases
    .filter((r) => {
      const v = parseVersion(r.version);
      if (!v || seen.has(r.version)) return false;
      if (r.prerelease && hi.pre.length === 0) return false;
      if (compareVersions(v, lo) <= 0 || compareVersions(v, hi) > 0) return false;
      seen.add(r.version);
      return true;
    })
    .sort((a, b) => compareVersions(parseVersion(b.version)!, parseVersion(a.version)!));
}

/** The release page of a version (also the fallback link when the notes can't be loaded). */
export function releasePageUrl(version: string): string {
  return parseVersion(version) ? `${RELEASES_PAGE}/tag/v${version.replace(/^v/, "")}` : RELEASES_PAGE;
}

// ---- when it may appear -------------------------------------------------------------------------

export interface Idle {
  /** A dialog, sheet or the palette is open. */
  overlayOpen: boolean;
  /** When the user last pressed a key in a text field (composer, terminal), if ever. */
  lastTypedAt: number | undefined;
  now: number;
}

/** The modal never covers an open dialog or interrupts typing: it waits for both to clear. */
export function canShowNow({ overlayOpen, lastTypedAt, now }: Idle): boolean {
  if (overlayOpen) return false;
  return lastTypedAt === undefined || now - lastTypedAt >= TYPING_IDLE_MS;
}

// ---- the per-device record ----------------------------------------------------------------------

/**
 * What the start-up check decided for this launch. `fetch` with `from: null` is an install that
 * predates this record (see {@link planStart}): only the running version's notes are due.
 */
export type StartPlan = { kind: "record" } | { kind: "skip" } | { kind: "fetch"; from: string | null };

/**
 * `existing`: this device already holds TeleFlock state from before this start (a real host
 * configured in the app core), the one thing that tells an update from 0.8.x or earlier, which
 * never wrote a record, from a fresh install.
 *
 * No record: a fresh install (or one that never configured a host) remembers this version and
 * shows nothing; an existing install is taken to have been updated from the release just before,
 * so the running version's notes are due. `skip`: same or older version than the last one seen (a
 * downgrade keeps the higher mark, so the next upgrade doesn't repeat notes). `fetch`: a newer
 * version than the last seen.
 */
export function planStart(seen: string | undefined, current: string, existing: boolean): StartPlan {
  const cur = parseVersion(current);
  if (!cur) return { kind: "skip" };
  const last = seen === undefined ? null : parseVersion(seen);
  if (!last) return existing ? { kind: "fetch", from: null } : { kind: "record" };
  return compareVersions(cur, last) > 0 ? { kind: "fetch", from: seen! } : { kind: "skip" };
}

/** What the modal shows. */
export type WhatsNewView =
  | { kind: "loading"; version: string }
  | { kind: "notes"; version: string; releases: ReleaseNote[] }
  /** The notes couldn't be loaded: a link to the release page. */
  | { kind: "link"; version: string };

interface WhatsNewState {
  /** Last app version whose notes this device was shown (or that was installed fresh). */
  seen: string | undefined;
  /** Consecutive launches on which loading the notes failed. */
  failedStarts: number;
  /** Ready but waiting for an idle moment (not persisted). */
  waiting: (WhatsNewView & { kind: "notes" | "link" }) | null;
  /** The open modal (not persisted). */
  view: WhatsNewView | null;
  /** Whether `view` was opened by hand (Settings, palette): closing it records nothing. */
  manual: boolean;
}

export const useWhatsNew = create<WhatsNewState>()(
  persist(() => ({ seen: undefined, failedStarts: 0, waiting: null, view: null, manual: false }) as WhatsNewState, {
    name: "tf.whatsNew",
    partialize: ({ seen, failedStarts }) => ({ seen, failedStarts }),
  }),
);

/** Moves a view that waits for an idle moment onto the screen (called by the modal host). */
export function showWaiting(): void {
  useWhatsNew.setState((s) => (s.waiting && !s.view ? { view: s.waiting, waiting: null, manual: false } : s));
}

/** Closes the modal; an automatic one records its version as seen, so it shows once. */
export function dismissWhatsNew(): void {
  useWhatsNew.setState((s) => (s.view && !s.manual && s.view.kind !== "loading" ? { view: null, seen: s.view.version, failedStarts: 0 } : { view: null }));
}

// ---- loading ------------------------------------------------------------------------------------

export type ReleaseFetcher = () => Promise<ReleaseNote[]>;

/** One anonymous request (GitHub allows 60 per hour per IP), timing out after 10 s. */
export const fetchReleases: ReleaseFetcher = async () => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return parseReleases(await res.json());
  } finally {
    clearTimeout(timer);
  }
};

let cache: { at: number; releases: ReleaseNote[] } | undefined;
let inflight: Promise<ReleaseNote[]> | undefined;

/** The release list: the launch's cached copy while fresh, else one request shared by all callers. */
async function loadReleases(fetcher: ReleaseFetcher, now: number): Promise<ReleaseNote[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.releases;
  inflight ??= fetcher()
    .then((releases) => {
      cache = { at: now, releases };
      return releases;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

let checked = false;

/**
 * The start-up check, once per launch, run once the app core has loaded its hosts (`existing`: a real
 * host is configured, see {@link planStart}). A fresh install only records the version. After an update
 * it loads the notes in the background (never blocking the UI): found → they wait for an idle
 * moment (`showWaiting`); none published → the version is recorded silently; the request failed →
 * the start is counted, and the third failed start swaps the notes for a link to the release.
 */
export async function checkWhatsNew(existing: boolean, current = APP_VERSION, fetcher: ReleaseFetcher = fetchReleases, now = Date.now()): Promise<void> {
  if (checked) return;
  checked = true;
  const plan = planStart(useWhatsNew.getState().seen, current, existing);
  if (plan.kind === "skip") return;
  if (plan.kind === "record") {
    useWhatsNew.setState({ seen: current, failedStarts: 0 });
    return;
  }
  try {
    const releases = await loadReleases(fetcher, now);
    const found = plan.from === null ? releases.filter((r) => r.version === current) : releasesBetween(releases, plan.from, current);
    if (found.length === 0) useWhatsNew.setState({ seen: current, failedStarts: 0 });
    else useWhatsNew.setState({ waiting: { kind: "notes", version: current, releases: found } });
  } catch {
    const failedStarts = useWhatsNew.getState().failedStarts + 1;
    useWhatsNew.setState(failedStarts >= MAX_FAILED_STARTS ? { failedStarts, waiting: { kind: "link", version: current } } : { failedStarts });
  }
}

/** Opens the notes of the running version by hand (Settings → Updates, the palette). */
export async function openWhatsNew(current = APP_VERSION, fetcher: ReleaseFetcher = fetchReleases, now = Date.now()): Promise<void> {
  useWhatsNew.setState({ view: { kind: "loading", version: current }, manual: true });
  let view: WhatsNewView = { kind: "link", version: current };
  try {
    const mine = (await loadReleases(fetcher, now)).filter((r) => r.version === current.replace(/^v/, ""));
    if (mine.length > 0) view = { kind: "notes", version: current, releases: mine };
  } catch {
    /* the link view says it */
  }
  // Closed while loading: stay closed.
  useWhatsNew.setState((s) => (s.view?.kind === "loading" && s.manual ? { view } : s));
}

/** Test seams: a new app launch (the persisted record survives it), and a factory-fresh device. */
export const whatsNewTesting = {
  launch(): void {
    checked = false;
    cache = undefined;
    inflight = undefined;
    useWhatsNew.setState({ waiting: null, view: null, manual: false });
  },
  reset(): void {
    whatsNewTesting.launch();
    useWhatsNew.setState({ seen: undefined, failedStarts: 0 });
  },
};
