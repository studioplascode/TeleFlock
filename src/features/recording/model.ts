import type { BrowserEvent, ElementInfo, Measured, ObservedOwner, PointerButton, UiAction } from "@/features/browser/observe";
import type { Mask, Rect } from "./compose";

/*
 * The event log of a session recording, built while the user records (`EventLog`): what they did
 * in their own tabs (navigations, clicks, typing, scrolls, keys, tabs) and what failed there
 * (console errors, uncaught exceptions, failed requests), each at its recording time `t` (ms since
 * Record, pauses left out). Sensitive input never enters the log: typing into password, card and
 * one-time-code fields (and fields named like them, and frames of another origin) is logged as
 * hidden and their keys never make a line, secret-looking text is hidden, and URLs lose
 * credential-like parameters and tokens in their path. The log also keeps which fields the video
 * covers (`covers`). Agents' tabs are not recorded: switching to one logs "watching".
 * The log is stored as JSON lines by the app core (`recording.append`), which never reads it.
 */

/** An element as the log names it: what it is and how to find it, never its value. */
export interface RecElement {
  tag: string;
  role?: string;
  label?: string;
  type?: string;
  name?: string;
  id?: string;
  href?: string;
  selector: string;
  sensitive?: boolean;
}

export type ShotReason = "start" | "click" | "page" | "error" | "end";

export type RecEvent = { t: number; tab?: string } & (
  | { kind: "navigate"; url: string; title?: string; transition?: string; sameDocument?: boolean; redirects?: string[] }
  | { kind: "click"; x: number; y: number; button: PointerButton; count: number; element?: RecElement; to?: { x: number; y: number } }
  | { kind: "type"; text: string; hidden?: boolean; pasted?: boolean; submitted?: boolean; element?: RecElement }
  | { kind: "key"; combo: string; repeat?: number; element?: RecElement }
  | { kind: "scroll"; dx: number; dy: number; x: number; y: number }
  | { kind: "tab"; change: "opened" | "closed" | "activated"; url: string; title?: string }
  | { kind: "watch"; agent: string; hostId: string; agentId: string; url: string; title?: string }
  | { kind: "console"; level: "error" | "warning"; text: string; source?: string; stack?: string[]; repeat?: number }
  | { kind: "exception"; text: string; source?: string; stack?: string[]; repeat?: number }
  | { kind: "request"; method: string; url: string; status?: number; statusText?: string; error?: string; resourceType?: string; body?: string; repeat?: number }
  | { kind: "dialog"; dialog: string; message: string }
  | { kind: "ui"; action: UiAction; url?: string }
  | { kind: "shot"; name: string; reason: ShotReason }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "note"; text: string }
);

export type RecEventKind = RecEvent["kind"];

/** Typing stops being one entry after this pause. */
export const TYPING_GAP_MS = 2500;
/** Wheel events closer than this are one scroll. */
export const SCROLL_GAP_MS = 1000;
/** A navigation this soon after the previous one, with no input between, is a redirect of it. */
export const REDIRECT_MS = 1500;
/** The same error again within this long counts as a repeat of the logged one. */
export const REPEAT_MS = 2000;
/** Errors logged per recording at most (console, exceptions, requests); the rest are counted. */
export const MAX_ERRORS = 300;
/** Entries stay changeable this long before `take` hands them over. */
export const HOLD_MS = 4000;
/** A pointer moving further than this between down and up is a drag. */
const DRAG_PX = 8;
/** A click again on the same spot this soon is the same (double) click. */
const MULTI_CLICK_MS = 600;

const CDP_ALT = 1;
const CDP_CTRL = 2;
const CDP_META = 4;
const CDP_SHIFT = 8;
/** Fields covered per tab at most (the oldest go first). */
const MAX_COVERS = 50;

const SENSITIVE_AUTOCOMPLETE = /\b(?:current-password|new-password|one-time-code|cc-[a-z-]+)\b/i;
const SENSITIVE_WORDS =
  /pass(?:word|wd|phrase|code)?|pwd|secret|token|api[-_ ]?key|\botp\b|totp|\bmfa\b|\b2fa\b|\bpin\b|pin[-_ ]?code|\bcvv|\bcvc|\bcsc\b|card[-_ ]?(?:number|no\b)|cc[-_ ]?(?:num|number|exp|csc)|\biban\b|\bssn\b|social[-_ ]?security|security[-_ ]?code|verification[-_ ]?code/i;
const SENSITIVE_PARAM = /token|secret|passw|pwd|key|signature|\bsig\b|auth|session|\bsid\b|^code$|otp|ticket|jwt|credential|nonce/i;
const SECRET_PATTERNS: RegExp[] = [
  /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, // JWT
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, // provider keys
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];
export const MASK = "•••";
/** In URLs (stays readable unescaped). */
const URL_MASK = "***";

/** A password, card or one-time-code field, by the browser's word or by its name, id, label or autocomplete. */
export function isSensitiveElement(el: Pick<ElementInfo, "sensitive" | "type" | "name" | "id" | "label" | "autocomplete"> | undefined): boolean {
  if (!el) return false;
  if (el.sensitive || el.type?.toLowerCase() === "password") return true;
  if (el.autocomplete && SENSITIVE_AUTOCOMPLETE.test(el.autocomplete)) return true;
  return SENSITIVE_WORDS.test([el.name, el.id, el.label].filter(Boolean).join(" "));
}

/** Text that looks like a credential (a token, key or JWT) as a whole. */
export function looksSecret(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (SECRET_PATTERNS.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(s))) return true;
  // One long run of mixed letters and digits with no spaces: a generated key or password.
  return s.length >= 24 && !/\s/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !/^https?:\/\//i.test(s);
}

/** `text` with anything credential-shaped inside replaced by `•••`. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => (m.toLowerCase().startsWith("bearer") ? `Bearer ${MASK}` : MASK));
  return out;
}

/** A URL's path, fragment or query segment (percent-encoded) that is a credential or holds one. */
function secretSegment(segment: string): boolean {
  let plain = segment;
  try {
    plain = decodeURIComponent(segment);
  } catch {
    // not percent-encoded text: as it is
  }
  return looksSecret(plain) || scrubSecrets(plain) !== plain;
}

/**
 * A URL as the log keeps it: no user or password in it, `***` for the values of credential-like
 * query parameters (and of an OAuth fragment's), and for a path segment, fragment segment or bare
 * query that is a credential itself (magic, reset and webhook links); at most 400 characters.
 */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return clip(scrubSecrets(raw), 400);
  }
  url.username = "";
  url.password = "";
  const masked = (params: URLSearchParams) => {
    let changed = false;
    for (const [k, v] of [...params]) {
      if (v && (SENSITIVE_PARAM.test(k) || looksSecret(v))) {
        params.set(k, URL_MASK);
        changed = true;
      }
    }
    return changed;
  };
  const segments = (path: string) => path.split("/").map((s) => (secretSegment(s) ? URL_MASK : s)).join("/");
  url.pathname = segments(url.pathname);
  if (url.search.length > 1 && !url.search.includes("=")) url.search = segments(url.search.slice(1));
  else {
    const search = new URLSearchParams(url.search);
    if (masked(search)) url.search = search.toString();
  }
  if (url.hash.includes("=")) {
    const hash = new URLSearchParams(url.hash.slice(1));
    if (masked(hash)) url.hash = hash.toString();
  } else if (url.hash.length > 1) url.hash = segments(url.hash.slice(1));
  return clip(url.toString(), 400);
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function element(el: ElementInfo | undefined): RecElement | undefined {
  if (!el) return undefined;
  const out: RecElement = { tag: el.tag.toLowerCase(), selector: clip(el.selector, 120) };
  if (el.role) out.role = el.role;
  if (el.type) out.type = el.type;
  if (el.name) out.name = clip(el.name, 60);
  if (el.id) out.id = clip(el.id, 60);
  if (el.href) out.href = maskUrl(el.href);
  const sensitive = isSensitiveElement(el);
  if (sensitive) out.sensitive = true;
  // A label can be the element's own text: never for a sensitive element, never when it looks like a secret.
  if (el.label && !(sensitive && el.textLabel) && !looksSecret(el.label)) out.label = clip(el.label.replace(/\s+/g, " ").trim(), 80);
  return out;
}

function sameElement(a: RecElement | undefined, b: RecElement | undefined): boolean {
  return (a?.selector ?? "") === (b?.selector ?? "");
}

/** `Ctrl+Shift+S`, `Enter`, `Alt+ArrowLeft`. */
export function keyCombo(key: string, modifiers: number): string {
  const parts: string[] = [];
  if (modifiers & CDP_CTRL) parts.push("Ctrl");
  if (modifiers & CDP_ALT) parts.push("Alt");
  if (modifiers & CDP_SHIFT && key.length > 1) parts.push("Shift");
  if (modifiers & CDP_META) parts.push("Meta");
  parts.push(key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key);
  return parts.join("+");
}

/** Keys that are worth a line of their own (others only move the caret or focus). */
const LOGGED_KEYS: Record<string, true> = { Enter: true, Escape: true, Delete: true, PageUp: true, PageDown: true, Home: true, End: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, F5: true, F12: true };
/** Keys that only change what the next key means, or move focus: never a line. */
const SILENT_KEYS: Record<string, true> = { Shift: true, Control: true, Alt: true, Meta: true, CapsLock: true, Tab: true };

/** A key that types its text: one with text but no Ctrl or Meta (Option on a Mac types characters, AltGr comes without Ctrl and Alt). */
function typesText(e: BrowserEvent & { type: "key" }): boolean {
  return !!e.text && e.key !== "Enter" && e.key !== "Tab" && (e.modifiers & (CDP_CTRL | CDP_META)) === 0;
}

interface Typing {
  t: number;
  last: number;
  tab: string;
  element?: RecElement;
  /** The field as looked up (covered once the run turns out to be a secret). */
  info?: ElementInfo;
  text: string;
  hidden: boolean;
}

interface Scrolling {
  t: number;
  last: number;
  tab: string;
  dx: number;
  dy: number;
  x: number;
  y: number;
}

interface Down {
  t: number;
  tab: string;
  x: number;
  y: number;
  button: PointerButton;
  count: number;
  element?: RecElement;
}

export interface LogOptions {
  /** Recording time (ms) of an epoch timestamp: since Record, pauses left out. */
  clock(at: number): number;
  /** Tabs logged as opened this early were open before Record (the observer's snapshot): left out. */
  startGraceMs?: number;
}

/** A field the video covers, where it was last measured; `ref` measures it again (`measureElements`). */
export interface Cover extends Mask {
  ref?: string;
}

/** A field as the log keeps it to cover it: `rect` null while it is not on the page. */
interface Field {
  key: string;
  ref?: string;
  rect: Rect | null;
  scroll?: { x: number; y: number };
}

function fieldOf(el: ElementInfo): Field {
  return { key: el.ref ?? el.selector, ...(el.ref ? { ref: el.ref } : {}), rect: el.rect ?? null, ...(el.scroll ? { scroll: el.scroll } : {}) };
}

/**
 * Turns the browser's events into log entries as they happen: one entry per typed run (Backspace
 * edits it, Enter ends it as submitted), per scroll, per click (a double click stays one, a drag
 * says where to), redirects folded into the navigation that caused them, error bursts counted.
 * `take` hands over what is final; `tick` and `flush` close typing and scrolls that ended.
 */
export class EventLog {
  /** Final entries not taken yet, each with the recording time it became final at. */
  private ready: { e: RecEvent; at: number }[] = [];
  /** The latest recording time seen. */
  private now = 0;
  private typing: Typing | null = null;
  private scrolling: Scrolling | null = null;
  private down: Down | null = null;
  private lastClick: (RecEvent & { kind: "click" }) | null = null;
  private lastKey: (RecEvent & { kind: "key" }) | null = null;
  private readonly owners = new Map<string, ObservedOwner>();
  private readonly pages = new Map<string, { url: string; title?: string }>();
  private readonly lastNav = new Map<string, RecEvent & { kind: "navigate" }>();
  private lastInputT = -Infinity;
  private shown: string | null = null;
  private watching: string | null = null;
  private errors = 0;
  private droppedErrors = 0;
  private lastError: { key: string; ev: RecEvent & { kind: "console" | "exception" | "request" }; t: number } | null = null;
  /** The focused field (the last one clicked, typed or pasted into). */
  private focused: { tab: string; sensitive: boolean; field: Field } | null = null;
  /** Per tab: the sensitive fields typed or pasted into (and the ones a hidden secret went into), by ref. */
  private readonly typedInto = new Map<string, Map<string, Field>>();
  private clickMark: { t: number; tab: string; x: number; y: number } | null = null;

  constructor(private readonly opts: LogOptions) {}

  /** The tab shown now, its page and whether it is recorded (the user's own). */
  get current(): { tab: string; url: string; title?: string; recorded: boolean; agent?: string } | null {
    if (!this.shown) return null;
    const page = this.pages.get(this.shown) ?? { url: "" };
    const owner = this.owners.get(this.shown);
    return { tab: this.shown, ...page, recorded: owner?.kind !== "agent", ...(owner?.kind === "agent" ? { agent: owner.agentName } : {}) };
  }

  /**
   * The fields to cover in pictures of `tab` (the compositor's masks): the focused field when it
   * is sensitive, and every field there that sensitive input went into (typing or a paste the log
   * hid), also once the focus moved on, where they were last measured; none that is not on the
   * page now.
   */
  covers(tab: string): Cover[] {
    return this.coveredFields(tab).flatMap(({ ref, rect, scroll }) => (rect ? [{ ...(ref ? { ref } : {}), rect, ...(scroll ? { scroll } : {}) }] : []));
  }

  /** What to measure for the next picture of `tab` (`measured`): the refs of its covered fields, the ones not on the page now too (they may come back). */
  coverRefs(tab: string): string[] {
    return this.coveredFields(tab).flatMap((f) => (f.ref ? [f.ref] : []));
  }

  private coveredFields(tab: string): Field[] {
    const fields = [...(this.typedInto.get(tab)?.values() ?? [])];
    const f = this.focused;
    if (f?.tab === tab && f.sensitive && !fields.some((x) => x.key === f.field.key)) fields.push(f.field);
    return fields;
  }

  /** Where the fields `refs` of `tab` are now (measured for a picture): moved, or gone (null) until they show again. */
  measured(tab: string, refs: readonly string[], m: Measured): void {
    const now = new Map(refs.map((ref, i) => [ref, m.rects[i] ?? null]));
    const update = (f: Field) => {
      if (!f.ref || !now.has(f.ref)) return;
      f.rect = now.get(f.ref) ?? null;
      f.scroll = m.scroll;
    };
    for (const f of this.typedInto.get(tab)?.values() ?? []) update(f);
    if (this.focused?.tab === tab) update(this.focused.field);
  }

  /**
   * Input while paused: not logged, but the field it focuses, and a sensitive field (or a secret)
   * it types or pastes into, is covered once recording goes on as if it had been.
   */
  notePaused(e: BrowserEvent): void {
    if (this.isAgentTab(e.tabId)) return;
    if (e.type === "pointer" && e.action === "down") this.focused = e.element ? { tab: e.tabId, sensitive: isSensitiveElement(e.element), field: fieldOf(e.element) } : null;
    if (e.type !== "key" && e.type !== "text") return;
    this.focus(e.tabId, e.element);
    const sensitive = isSensitiveElement(e.element);
    if (e.type === "key" ? sensitive && typesText(e) : sensitive || looksSecret(e.text)) this.keep(e.tabId, e.element);
  }

  /** The latest click, for the marker drawn into frames. */
  get lastClickMark(): { t: number; tab: string; x: number; y: number } | null {
    return this.clickMark;
  }

  /** Is `tab` an agent's (never recorded)? */
  isAgentTab(tab: string): boolean {
    return this.owners.get(tab)?.kind === "agent";
  }

  /** A frame or event said who owns `tab`. */
  noteOwner(tab: string, owner: ObservedOwner | undefined): void {
    this.owners.set(tab, owner ?? { kind: "user" });
  }

  add(e: BrowserEvent): void {
    const t = Math.max(0, Math.round(this.opts.clock(e.at)));
    this.now = Math.max(this.now, t);
    switch (e.type) {
      case "tab":
        return this.onTab(e, t);
      case "navigation":
        return this.onNavigation(e, t);
      case "pointer":
        return this.onPointer(e, t);
      case "wheel":
        return this.onWheel(e, t);
      case "key":
        return this.onKey(e, t);
      case "text":
        return this.onText(e, t);
      case "console":
        return this.onError({ t, tab: e.tabId, kind: "console", level: e.level, text: clip(scrubSecrets(e.text), 2000), ...src(e.source, e.stack) }, `c${e.level}:${e.text}`);
      case "exception":
        return this.onError({ t, tab: e.tabId, kind: "exception", text: clip(scrubSecrets(e.text), 2000), ...src(e.source, e.stack) }, `x:${e.text}`);
      case "requestFailed":
        return this.onRequest(e, t);
      case "dialog":
        if (this.isAgentTab(e.tabId)) return;
        this.closeInput();
        this.log({ t, tab: e.tabId, kind: "dialog", dialog: e.dialog, message: clip(scrubSecrets(e.message), 500) });
        return;
      case "ui":
        return this.onUi(e, t);
    }
  }

  /** Time passed: typing and scrolling that went quiet become entries. */
  tick(at: number): void {
    const t = this.opts.clock(at);
    this.now = Math.max(this.now, t);
    if (this.typing && t - this.typing.last >= TYPING_GAP_MS) this.endTyping(false);
    if (this.scrolling && t - this.scrolling.last >= SCROLL_GAP_MS) this.endScroll();
    if (this.down && t - this.down.t >= 2000) this.endDown(null);
  }

  /** Everything still open becomes an entry (pause, stop). */
  flush(): void {
    this.closeInput();
  }

  /** A line of the recorder's own (pause, resume, a screenshot taken). */
  mark(e: RecEvent): void {
    if (e.kind === "pause") this.flush();
    this.log(e);
  }

  /**
   * The entries that became final at least `HOLD_MS` before `at` (all of them without `at`), in
   * the order they became final. Newer ones stay: a repeat, a double click, a redirect or the page
   * title can still change them.
   */
  take(at?: number): RecEvent[] {
    const cut = at === undefined ? Infinity : this.opts.clock(at) - HOLD_MS;
    let n = 0;
    while (n < this.ready.length && (this.ready[n]?.at ?? Infinity) <= cut) n++;
    return this.ready.splice(0, n).map((r) => r.e);
  }

  /** Errors left out over `MAX_ERRORS` (said once at the end). */
  get errorsDropped(): number {
    return this.droppedErrors;
  }

  private log(e: RecEvent): void {
    this.ready.push({ e, at: this.now });
  }

  /** `e` is not taken yet (still changeable). */
  private held(e: RecEvent): boolean {
    return this.ready.some((r) => r.e === e);
  }

  /** Open input (a click waiting for its release, typing, a scroll) becomes entries before something else is logged. */
  private closeInput(): void {
    this.endDown(null);
    this.endTyping(false);
    this.endScroll();
    this.lastKey = null;
  }

  private onTab(e: BrowserEvent & { type: "tab" }, t: number): void {
    if (e.change !== "closed") this.noteOwner(e.tabId, e.owner);
    const agent = e.owner?.kind === "agent" ? e.owner : null;
    if (e.url) this.pages.set(e.tabId, { url: maskUrl(e.url), ...(e.title ? { title: clip(e.title, 200) } : {}) });
    const page = this.pages.get(e.tabId) ?? { url: maskUrl(e.url) };
    switch (e.change) {
      case "opened":
        if (agent || t < (this.opts.startGraceMs ?? 400)) return;
        this.log({ t, tab: e.tabId, kind: "tab", change: "opened", ...page });
        return;
      case "activated":
      case "owner": {
        if (e.change === "owner" && e.tabId !== this.shown) return;
        const was = this.shown;
        this.shown = e.tabId;
        if (agent) {
          if (this.watching === e.tabId && e.change === "activated") return;
          this.closeInput();
          this.watching = e.tabId;
          this.log({ t, tab: e.tabId, kind: "watch", agent: agent.agentName, hostId: agent.hostId, agentId: agent.agentId, ...page });
          return;
        }
        const back = this.watching !== null;
        this.watching = null;
        if (was === e.tabId && !back && e.change === "activated") return;
        this.closeInput();
        this.log({ t, tab: e.tabId, kind: "tab", change: "activated", ...page });
        return;
      }
      case "updated": {
        if (agent) return;
        const nav = this.lastNav.get(e.tabId);
        if (nav && !nav.title && e.title && this.held(nav) && maskUrl(e.url) === nav.url) nav.title = clip(e.title, 200);
        return;
      }
      case "closed":
        this.owners.delete(e.tabId);
        this.pages.delete(e.tabId);
        this.typedInto.delete(e.tabId);
        if (this.focused?.tab === e.tabId) this.focused = null;
        if (agent || this.watching === e.tabId) return;
        this.closeInput();
        this.log({ t, tab: e.tabId, kind: "tab", change: "closed", ...page });
        return;
    }
  }

  private onNavigation(e: BrowserEvent & { type: "navigation" }, t: number): void {
    if (e.owner) this.noteOwner(e.tabId, e.owner);
    const url = maskUrl(e.url);
    const prevPage = this.pages.get(e.tabId);
    this.pages.set(e.tabId, { url, ...(e.title ? { title: clip(e.title, 200) } : prevPage?.url === url && prevPage.title ? { title: prevPage.title } : {}) });
    if (this.isAgentTab(e.tabId)) return;
    const last = this.lastNav.get(e.tabId);
    if (last && last.url === url && t - last.t < 1000) {
      if (e.title && !last.title && this.held(last)) last.title = clip(e.title, 200);
      return;
    }
    // Pending input belongs before the page it led to.
    this.closeInput();
    const pending = last && this.held(last);
    if (last && pending && !e.sameDocument && !last.sameDocument && t - last.t < REDIRECT_MS && this.lastInputT < last.t) {
      last.redirects = [...(last.redirects ?? []), last.url];
      last.url = url;
      if (e.title) last.title = clip(e.title, 200);
      else delete last.title;
      return;
    }
    const nav: RecEvent & { kind: "navigate" } = { t, tab: e.tabId, kind: "navigate", url };
    if (e.title) nav.title = clip(e.title, 200);
    if (e.transition) nav.transition = e.transition;
    if (e.sameDocument) nav.sameDocument = true;
    this.lastNav.set(e.tabId, nav);
    this.log(nav);
  }

  private onPointer(e: BrowserEvent & { type: "pointer" }, t: number): void {
    if (this.isAgentTab(e.tabId)) return;
    this.lastInputT = t;
    const el = element(e.element);
    if (e.action === "down") {
      this.closeInput();
      this.down = { t, tab: e.tabId, x: Math.round(e.x), y: Math.round(e.y), button: e.button, count: e.clickCount, ...(el ? { element: el } : {}) };
      this.clickMark = { t, tab: e.tabId, x: e.x, y: e.y };
      this.focused = e.element ? { tab: e.tabId, sensitive: isSensitiveElement(e.element), field: fieldOf(e.element) } : null;
      return;
    }
    this.endDown({ x: Math.round(e.x), y: Math.round(e.y) });
  }

  private endDown(up: { x: number; y: number } | null): void {
    const d = this.down;
    if (!d) return;
    this.down = null;
    const moved = up && Math.hypot(up.x - d.x, up.y - d.y) > DRAG_PX;
    const prev = this.lastClick;
    if (!moved && d.count > 1 && prev && this.held(prev) && prev.tab === d.tab && sameElement(prev.element, d.element) && d.t - prev.t < MULTI_CLICK_MS * d.count && Math.hypot(prev.x - d.x, prev.y - d.y) <= DRAG_PX) {
      prev.count = d.count;
      return;
    }
    const click: RecEvent & { kind: "click" } = { t: d.t, tab: d.tab, kind: "click", x: d.x, y: d.y, button: d.button, count: d.count };
    if (d.element) click.element = d.element;
    if (moved && up) click.to = up;
    this.lastClick = click;
    this.log(click);
  }

  private onWheel(e: BrowserEvent & { type: "wheel" }, t: number): void {
    if (this.isAgentTab(e.tabId)) return;
    this.lastInputT = t;
    const s = this.scrolling;
    if (s && s.tab === e.tabId && t - s.last < SCROLL_GAP_MS) {
      s.dx += e.deltaX;
      s.dy += e.deltaY;
      s.last = t;
      return;
    }
    this.closeInput();
    this.scrolling = { t, last: t, tab: e.tabId, dx: e.deltaX, dy: e.deltaY, x: Math.round(e.x), y: Math.round(e.y) };
  }

  private endScroll(): void {
    const s = this.scrolling;
    if (!s) return;
    this.scrolling = null;
    if (Math.abs(s.dx) < 1 && Math.abs(s.dy) < 1) return;
    this.log({ t: s.t, tab: s.tab, kind: "scroll", dx: Math.round(s.dx), dy: Math.round(s.dy), x: s.x, y: s.y });
  }

  private startTyping(t: number, tab: string, el: RecElement | undefined, hidden: boolean, info: ElementInfo | undefined): Typing {
    const cur = this.typing;
    if (cur && cur.tab === tab && sameElement(cur.element, el) && t - cur.last < TYPING_GAP_MS) {
      cur.last = t;
      if (hidden && !cur.hidden) {
        cur.hidden = true;
        cur.text = "";
      }
      return cur;
    }
    this.closeInput();
    const typing: Typing = { t, last: t, tab, text: "", hidden, ...(el ? { element: el } : {}), ...(info ? { info } : {}) };
    this.typing = typing;
    return typing;
  }

  /** The focus is on `info` (a key or text went there). */
  private focus(tab: string, info: ElementInfo | undefined): void {
    if (info) this.focused = { tab, sensitive: isSensitiveElement(info), field: fieldOf(info) };
  }

  /** Sensitive input went into `info`: covered in `tab`'s pictures from now on (where it was looked up, until measured again). */
  private keep(tab: string, info: ElementInfo | undefined): void {
    if (!info) return;
    let fields = this.typedInto.get(tab);
    if (!fields) this.typedInto.set(tab, (fields = new Map()));
    const f = fieldOf(info);
    const known = fields.get(f.key);
    if (!known) fields.set(f.key, f);
    else if (f.rect) Object.assign(known, f);
    if (fields.size > MAX_COVERS) fields.delete(fields.keys().next().value ?? "");
  }

  private endTyping(submitted: boolean): void {
    const ty = this.typing;
    if (!ty) return;
    this.typing = null;
    if (!ty.text && !ty.hidden) {
      if (submitted) this.log({ t: ty.t, tab: ty.tab, kind: "key", combo: "Enter", ...(ty.element ? { element: ty.element } : {}) });
      return;
    }
    const hidden = ty.hidden || looksSecret(ty.text);
    if (hidden && !ty.hidden) this.keep(ty.tab, ty.info);
    const ev: RecEvent & { kind: "type" } = { t: ty.t, tab: ty.tab, kind: "type", text: hidden ? "" : clip(ty.text, 1000) };
    if (hidden) ev.hidden = true;
    if (submitted) ev.submitted = true;
    if (ty.element) ev.element = ty.element;
    this.log(ev);
  }

  private onKey(e: BrowserEvent & { type: "key" }, t: number): void {
    if (this.isAgentTab(e.tabId)) return;
    this.lastInputT = t;
    const el = element(e.element);
    const sensitive = isSensitiveElement(e.element);
    this.focus(e.tabId, e.element);
    if (typesText(e)) {
      const ty = this.startTyping(t, e.tabId, el, sensitive, e.element);
      if (!ty.hidden) ty.text += e.text;
      else ty.text = "";
      if (sensitive) this.keep(e.tabId, e.element);
      return;
    }
    const chord = (e.modifiers & (CDP_CTRL | CDP_META | CDP_ALT)) !== 0;
    if (e.key === "Backspace" && !chord) {
      const ty = this.typing;
      if (ty && ty.tab === e.tabId && sameElement(ty.element, el)) {
        ty.last = t;
        if (!ty.hidden) ty.text = [...ty.text].slice(0, -1).join("");
        return;
      }
      return this.logKey(t, e.tabId, "Backspace", el);
    }
    if (e.key === "Enter" && !chord) {
      const ty = this.typing;
      if (ty && ty.tab === e.tabId && sameElement(ty.element, el)) {
        this.endTyping(true);
        return;
      }
      return this.logKey(t, e.tabId, "Enter", el);
    }
    if (SILENT_KEYS[e.key]) return;
    // Paste arrives as text too.
    if (chord && (e.key === "v" || e.key === "V") && !(e.modifiers & CDP_ALT)) return;
    // A sensitive field's printable keys can say what is in it (Ctrl+Alt is AltGr on Windows): never a line.
    if (sensitive && [...e.key].length === 1) return;
    if (!chord && !LOGGED_KEYS[e.key]) return;
    this.logKey(t, e.tabId, keyCombo(e.key, e.modifiers), el);
  }

  private logKey(t: number, tab: string, combo: string, el: RecElement | undefined): void {
    const prev = this.lastKey;
    if (prev && prev.tab === tab && prev.combo === combo && sameElement(prev.element, el) && t - prev.t < 3000 && this.held(prev)) {
      prev.repeat = (prev.repeat ?? 1) + 1;
      return;
    }
    this.closeInput();
    const ev: RecEvent & { kind: "key" } = { t, tab, kind: "key", combo };
    if (el) ev.element = el;
    this.lastKey = ev;
    this.log(ev);
  }

  private onText(e: BrowserEvent & { type: "text" }, t: number): void {
    if (this.isAgentTab(e.tabId)) return;
    this.lastInputT = t;
    const el = element(e.element);
    const sensitive = isSensitiveElement(e.element);
    this.focus(e.tabId, e.element);
    if (e.via === "paste") {
      this.closeInput();
      const hidden = sensitive || looksSecret(e.text);
      if (hidden) this.keep(e.tabId, e.element);
      const ev: RecEvent & { kind: "type" } = { t, tab: e.tabId, kind: "type", text: hidden ? "" : clip(scrubSecrets(e.text), 1000), pasted: true };
      if (hidden) ev.hidden = true;
      if (el) ev.element = el;
      this.log(ev);
      return;
    }
    const ty = this.startTyping(t, e.tabId, el, sensitive, e.element);
    if (!ty.hidden) ty.text += e.text;
    if (sensitive) this.keep(e.tabId, e.element);
  }

  private onError(ev: RecEvent & { kind: "console" | "exception" | "request" }, key: string): void {
    const t = ev.t;
    if (this.isAgentTab(ev.tab ?? "")) return;
    const last = this.lastError;
    if (last && last.key === key && t - last.t < REPEAT_MS && this.held(last.ev)) {
      last.ev.repeat = (last.ev.repeat ?? 1) + 1;
      last.t = t;
      return;
    }
    if (this.errors >= MAX_ERRORS) {
      this.droppedErrors++;
      return;
    }
    this.errors++;
    this.lastError = { key, ev, t };
    this.log(ev);
  }

  private onRequest(e: BrowserEvent & { type: "requestFailed" }, t: number): void {
    // Cancelled by a navigation or the page itself, and the browser's own favicon probes: noise.
    if (e.error && /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/i.test(e.error)) return;
    if (/\/favicon\.ico(?:$|\?)/i.test(e.url)) return;
    const url = maskUrl(e.url);
    const body: RecEvent & { kind: "request" } = { t, tab: e.tabId, kind: "request", method: e.method.toUpperCase(), url };
    if (e.status !== undefined) body.status = e.status;
    if (e.statusText) body.statusText = clip(e.statusText, 80);
    if (e.error) body.error = clip(e.error, 120);
    if (e.resourceType) body.resourceType = e.resourceType;
    if (e.body?.trim()) body.body = clip(scrubSecrets(e.body.replace(/\s+/g, " ").trim()), 300);
    this.onError(body, `r:${body.method} ${url} ${e.status ?? e.error ?? ""}`);
  }

  private onUi(e: BrowserEvent & { type: "ui" }, t: number): void {
    if (this.isAgentTab(e.tabId) && e.action !== "newTab") return;
    if (e.action === "zoom" || e.action === "switchTab") return;
    this.lastInputT = t;
    this.closeInput();
    const ev: RecEvent & { kind: "ui" } = { t, tab: e.tabId, kind: "ui", action: e.action };
    if (e.url) ev.url = maskUrl(e.url);
    this.log(ev);
  }
}

function src(source: string | undefined, stack: string[] | undefined): { source?: string; stack?: string[] } {
  const out: { source?: string; stack?: string[] } = {};
  if (source) out.source = clip(maskUrl(source), 300);
  if (stack?.length) out.stack = stack.slice(0, 5).map((s) => clip(scrubSecrets(s), 300));
  return out;
}

/**
 * Recording time from epoch time, pauses left out: `start` is when Record took effect, `pauses`
 * the closed pauses `[from, to)` and `pausedAt` an open one. Times inside a pause map to its start.
 */
export function recordingTime(at: number, start: number, pauses: readonly (readonly [number, number])[], pausedAt: number | null): number {
  let paused = 0;
  for (const [from, to] of pauses) {
    if (at >= to) paused += to - from;
    else if (at > from) return Math.max(0, from - start - paused);
  }
  if (pausedAt !== null && at > pausedAt) return Math.max(0, pausedAt - start - paused);
  return Math.max(0, at - start - paused);
}
