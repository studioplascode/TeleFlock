import type { RecElement, RecEvent, RecEventKind, ShotReason } from "./model";

/*
 * A recording's timeline: its event log and what was said, merged in time order, with the parts
 * the user removed in review (trim, cuts, hidden lines) left out and every time moved to where it
 * is in the video sent (`at`). Rendered as `timeline.md` for people and agents ("00:14.0 clicked
 * button "Save" …") and `timeline.json` for programs.
 */

/** A transcript line in recording time (the app core's `TranscriptSegment`). */
export interface Spoken {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Cut {
  start: number;
  end: number;
}

/** What the review sheet keeps per recording (`RecordingInfo.doc`, stored by the app core as given). */
export interface RecordingDoc {
  v: 1;
  /** The part kept, ms (`end` absent: to the end). */
  trim?: { start: number; end?: number };
  /** Parts removed from the middle (something sensitive on screen or said), ms. */
  cuts?: Cut[];
  /** Event log lines the user dropped (indexes into the log). */
  hidden?: number[];
  /** Transcript lines the user dropped (indexes). */
  hiddenSpeech?: number[];
  /** The task text as edited in review. */
  task?: string;
  /** Rambler's rewrite of the transcript. */
  cleaned?: string;
  /** The task starts from the rewrite (else the transcript as said). */
  useCleaned?: boolean;
}

export type EntryKind = RecEventKind | "speech";

export interface TimelineEntry {
  /** Time in the video sent (removed parts left out), ms. */
  at: number;
  /** Time in the recording, ms. */
  t: number;
  kind: EntryKind;
  /** One line for people and agents. */
  text: string;
  level?: "error" | "warning";
  /** Index into the event log (`kind` ≠ speech) or the transcript (speech). */
  index: number;
  /** The screenshot's file name (`kind` = shot). */
  shot?: string;
}

export interface Timeline {
  /** Length of the video sent, ms. */
  duration: number;
  entries: TimelineEntry[];
  /** Console errors and warnings, exceptions and failed requests among `entries`. */
  errors: TimelineEntry[];
  speech: TimelineEntry[];
  shots: { name: string; at: number; reason: ShotReason }[];
  /** The page the recording starts on. */
  start?: { url: string; title?: string };
  removed: Cut[];
}

/** `00:12.3`, `1:02:03.4`: also how omp's `read` seeks in a video (`clip.mov:00:12.3`). */
export function formatTime(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const h = Math.floor(tenths / 36_000);
  const m = Math.floor((tenths % 36_000) / 600);
  const s = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  const mm = String(m).padStart(2, "0");
  const ss = `${String(s).padStart(2, "0")}.${d}`;
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `1:42`, `12:05`, `1:02:03`: a length. */
export function formatLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The parts left out of the video: before the trim start, after its end, the cuts; merged and sorted. */
export function removedRanges(doc: RecordingDoc | undefined, duration: number): Cut[] {
  const parts: Cut[] = [];
  if (doc?.trim?.start) parts.push({ start: 0, end: doc.trim.start });
  if (doc?.trim?.end !== undefined && doc.trim.end < duration) parts.push({ start: doc.trim.end, end: duration });
  for (const c of doc?.cuts ?? []) parts.push({ start: Math.min(c.start, c.end), end: Math.max(c.start, c.end) });
  const sorted = parts
    .map((c) => ({ start: Math.max(0, Math.min(duration, c.start)), end: Math.max(0, Math.min(duration, c.end)) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const merged: Cut[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  return merged;
}

/** Where recording time `t` is in the video sent; null inside a removed part. */
export function mapTime(t: number, removed: readonly Cut[]): number | null {
  let shift = 0;
  for (const c of removed) {
    if (t < c.start) break;
    if (t < c.end) return null;
    shift += c.end - c.start;
  }
  return t - shift;
}

/** The video's length once `removed` is left out. */
export function keptLength(duration: number, removed: readonly Cut[]): number {
  return Math.max(0, duration - removed.reduce((n, c) => n + (c.end - c.start), 0));
}

/** `button "Save" (button#save)`, `link "Docs" (a.nav)`, `password field "Password" (input#pw)`. */
export function describeElement(el: RecElement | undefined): string {
  if (!el) return "the page";
  let what = el.role && el.role !== "generic" && el.role !== "none" ? el.role : el.tag === "a" ? "link" : el.tag;
  if (el.tag === "input" && (!el.role || el.role === "textbox")) {
    what = el.type === "password" ? "password field" : !el.type || el.type === "text" ? "text field" : `${el.type} field`;
  }
  const label = el.label ? ` "${el.label}"` : "";
  return `${what}${label} (${el.selector})`;
}

/** A URL shown relative to the page it was requested from when it is on the same origin. */
function shortUrl(url: string, page: string | undefined): string {
  if (!page) return url;
  try {
    const u = new URL(url);
    const p = new URL(page);
    return u.origin === p.origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

const quote = (s: string) => `"${s.replaceAll("\n", " ")}"`;
const times = (n: number | undefined) => (n && n > 1 ? ` ×${n}` : "");

/** One line for an event; `page` is the URL the tab showed then (requests to it are shown short). */
export function describeEvent(e: RecEvent, page?: string): string {
  switch (e.kind) {
    case "navigate": {
      const title = e.title ? ` ${quote(e.title)}` : "";
      const from = e.redirects?.length ? ` (redirected from ${e.redirects.join(", ")})` : "";
      if (e.sameDocument) return `page address changed to ${e.url}${title}`;
      if (e.transition === "reload") return `reloaded ${e.url}${title}`;
      if (e.transition === "back_forward") return `went back/forward to ${e.url}${title}`;
      return `page ${e.url}${title} loaded${from}`;
    }
    case "click": {
      const how = e.button === "right" ? "right-clicked" : e.button === "middle" ? "middle-clicked" : e.count === 2 ? "double-clicked" : e.count > 2 ? `clicked ${e.count} times on` : "clicked";
      if (e.to) return `dragged from ${e.x},${e.y} to ${e.to.x},${e.to.y} on ${describeElement(e.element)}`;
      return `${how} ${describeElement(e.element)} at ${e.x},${e.y}`;
    }
    case "type": {
      const into = `into ${describeElement(e.element)}`;
      const enter = e.submitted ? " and pressed Enter" : "";
      if (e.hidden) return `${e.pasted ? "pasted" : "typed"} something ${into} (hidden: sensitive)${enter}`;
      return `${e.pasted ? "pasted" : "typed"} ${quote(e.text)} ${into}${enter}`;
    }
    case "key":
      return `pressed ${e.combo}${times(e.repeat)}${e.element ? ` in ${describeElement(e.element)}` : ""}`;
    case "scroll": {
      const dir = Math.abs(e.dy) >= Math.abs(e.dx) ? (e.dy > 0 ? "down" : "up") : e.dx > 0 ? "right" : "left";
      return `scrolled ${dir} ${Math.round(Math.max(Math.abs(e.dx), Math.abs(e.dy)))} px`;
    }
    case "tab": {
      const title = e.title ? ` ${quote(e.title)}` : "";
      if (e.change === "opened") return `opened a tab: ${e.url}${title}`;
      if (e.change === "closed") return `closed the tab ${e.url}`;
      return `switched to the tab ${e.url}${title}`;
    }
    case "watch":
      return `watching the tab of ${e.agent} (an agent's tab: not recorded): ${e.url}`;
    case "console":
      return `console ${e.level}${times(e.repeat)}: ${e.text}${e.source ? ` (${e.source})` : ""}`;
    case "exception":
      return `uncaught exception${times(e.repeat)}: ${e.text}${e.source ? ` (${e.source})` : ""}`;
    case "request": {
      const url = shortUrl(e.url, page);
      const outcome = e.status !== undefined ? `→ ${e.status}${e.statusText ? ` ${e.statusText}` : ""}` : `failed: ${e.error ?? "no response"}`;
      return `${e.method} ${url} ${outcome}${times(e.repeat)}${e.body ? `: ${e.body}` : ""}`;
    }
    case "dialog":
      return `the page showed ${e.dialog === "alert" ? "an alert" : `a ${e.dialog} dialog`}: ${quote(e.message)}`;
    case "ui":
      switch (e.action) {
        case "navigate":
          return `entered the address ${e.url ?? ""}`.trimEnd();
        case "back":
          return "pressed Back";
        case "forward":
          return "pressed Forward";
        case "reload":
          return "pressed Reload";
        case "stop":
          return "pressed Stop";
        case "newTab":
          return "opened a new tab";
        case "closeTab":
          return "closed the tab";
        default:
          return e.action;
      }
    case "shot":
      return `screenshot ${e.name}`;
    case "pause":
      return "paused the recording";
    case "resume":
      return "resumed the recording";
    case "note":
      return e.text;
  }
}

function levelOf(e: RecEvent): "error" | "warning" | undefined {
  if (e.kind === "exception") return "error";
  if (e.kind === "console") return e.level;
  if (e.kind === "request") return e.status !== undefined && e.status < 500 ? "warning" : "error";
  return undefined;
}

export interface TimelineInput {
  events: readonly RecEvent[];
  spoken: readonly Spoken[];
  /** Recording length, ms. */
  duration: number;
  doc?: RecordingDoc;
}

/**
 * Merges the log and the transcript in time order (at the same moment speech first: what the user
 * said usually explains what they then did), leaving out removed parts and hidden lines. A
 * transcript line counts as removed when its middle is; one starting in a removed part starts
 * where that part ends.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const removed = removedRanges(input.doc, input.duration);
  const hidden = new Set(input.doc?.hidden ?? []);
  const hiddenSpeech = new Set(input.doc?.hiddenSpeech ?? []);
  const order = input.events.map((e, index) => ({ e, index })).sort((a, b) => a.e.t - b.e.t || a.index - b.index);
  const entries: (TimelineEntry & { seq: number })[] = [];
  const pages = new Map<string, string>();
  const shots: Timeline["shots"] = [];
  let start: Timeline["start"];
  let seq = 0;
  for (const { e, index } of order) {
    const tab = e.tab ?? "";
    if (e.kind === "navigate" && !e.sameDocument) {
      pages.set(tab, e.url);
      start ??= { url: e.url, ...(e.title ? { title: e.title } : {}) };
    } else if (e.kind === "tab" && e.change !== "closed") {
      pages.set(tab, e.url);
      start ??= { url: e.url, ...(e.title ? { title: e.title } : {}) };
    }
    if (hidden.has(index)) continue;
    const at = mapTime(e.t, removed);
    if (at === null) continue;
    const level = levelOf(e);
    entries.push({ at, t: e.t, kind: e.kind, text: describeEvent(e, pages.get(tab)), index, seq: seq++, ...(level ? { level } : {}), ...(e.kind === "shot" ? { shot: e.name } : {}) });
    if (e.kind === "shot") shots.push({ name: e.name, at, reason: e.reason });
  }
  input.spoken.forEach((s, index) => {
    if (hiddenSpeech.has(index) || !s.text.trim()) return;
    const mid = (s.startMs + s.endMs) / 2;
    if (mapTime(mid, removed) === null) return;
    const inside = removed.find((c) => s.startMs >= c.start && s.startMs < c.end);
    const at = mapTime(inside ? inside.end : s.startMs, removed) ?? 0;
    entries.push({ at, t: s.startMs, kind: "speech", text: `said: ${quote(s.text.trim())}`, index, seq: -1 });
  });
  entries.sort((a, b) => a.at - b.at || (a.kind === "speech" ? 0 : 1) - (b.kind === "speech" ? 0 : 1) || a.seq - b.seq);
  const out = entries.map(({ seq: _, ...e }) => e);
  return {
    duration: keptLength(input.duration, removed),
    entries: out,
    errors: out.filter((e) => e.level),
    speech: out.filter((e) => e.kind === "speech"),
    shots,
    ...(start ? { start } : {}),
    removed,
  };
}

export interface RenderMeta {
  title: string;
  /** When it was recorded (epoch ms). */
  createdAt: number;
  /** Why there is no transcript, when there is none (no voice recorded, no speech model, …). */
  voiceNote?: string;
  /** The video file as the reader opens it (a path on the agent's host, or the bundle's file name). */
  video?: { ref: string; bytes?: number; width?: number; height?: number };
  /** A screenshot file as the reader opens it. */
  shotRef(name: string): string;
  /** The JSON twin, as the reader opens it (mentioned in timeline.md). */
  jsonRef?: string;
}

function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `timeline.md`: everything that happened, then the errors and the transcript on their own. */
export function timelineMarkdown(tl: Timeline, meta: RenderMeta): string {
  const lines: string[] = [`# Recording: ${meta.title}`, ""];
  lines.push(`Recorded in the TeleFlock Browser on ${localStamp(meta.createdAt)} (the recorder's local time); ${formatLength(tl.duration)} long. Times below are into the video.`);
  if (tl.start) lines.push(`Starts on ${tl.start.url}${tl.start.title ? ` ${quote(tl.start.title)}` : ""}.`);
  if (meta.video) {
    const size = [meta.video.width && meta.video.height ? `${meta.video.width}×${meta.video.height}` : "", "10 fps"].filter(Boolean).join(", ");
    lines.push(`Video: ${meta.video.ref} (${size}). Read it to see it, or read \`${meta.video.ref}:00:14.0\` for the frame at a time below.`);
  }
  lines.push(tl.speech.length ? "What the user said is in the lines starting with \"said:\" (transcribed on their device; names may be misheard)." : `No transcript: ${meta.voiceNote ?? "nothing was said"}.`);
  if (meta.jsonRef) lines.push(`The same as data: ${meta.jsonRef}.`);
  lines.push("Typing into password, card and one-time-code fields is hidden, and so are values that look like keys or tokens.", "", "## Timeline", "");
  for (const e of tl.entries) {
    const text = e.kind === "shot" && e.shot ? `screenshot: ${meta.shotRef(e.shot)}` : e.text;
    lines.push(`- \`${formatTime(e.at)}\` ${text}`);
  }
  if (tl.errors.length) {
    lines.push("", "## Errors and failed requests", "");
    for (const e of tl.errors) lines.push(`- \`${formatTime(e.at)}\` ${e.text}`);
  }
  if (tl.speech.length) {
    lines.push("", "## Transcript", "");
    lines.push(tl.speech.map((e) => e.text.replace(/^said: "(.*)"$/, "$1")).join(" "));
  }
  return `${lines.join("\n")}\n`;
}

/** `timeline.json`: the same as data. */
export function timelineJson(tl: Timeline, meta: RenderMeta, events: readonly RecEvent[], spoken: readonly Spoken[]): string {
  const removed = tl.removed;
  const data = {
    format: "teleflock-recording/1",
    title: meta.title,
    recordedAt: new Date(meta.createdAt).toISOString(),
    durationMs: tl.duration,
    video: meta.video ? { file: meta.video.ref, fps: 10, ...(meta.video.width ? { width: meta.video.width, height: meta.video.height } : {}), ...(meta.video.bytes ? { bytes: meta.video.bytes } : {}) } : null,
    start: tl.start ?? null,
    entries: tl.entries.map((e) => {
      const ev = e.kind === "speech" ? undefined : events[e.index];
      const { t: _t, tab: _tab, kind: _kind, ...fields } = (ev ?? {}) as Record<string, unknown>;
      return { atMs: e.at, time: formatTime(e.at), kind: e.kind, text: e.text, ...(e.level ? { level: e.level } : {}), ...(e.kind === "shot" && e.shot ? { file: meta.shotRef(e.shot) } : {}), ...(e.kind === "speech" ? { said: spoken[e.index]?.text.trim() } : fields) };
    }),
    transcript: spoken.flatMap((s, i) => {
      const at = mapTime(s.startMs, removed);
      return at === null || !tl.speech.some((e) => e.index === i) ? [] : [{ atMs: at, endMs: mapTime(s.endMs, removed) ?? at, text: s.text.trim() }];
    }),
    shots: tl.shots.map((s) => ({ atMs: s.at, time: formatTime(s.at), reason: s.reason, file: meta.shotRef(s.name) })),
    removed: removed.map((c) => ({ startMs: c.start, endMs: c.end })),
    noTranscript: tl.speech.length ? undefined : (meta.voiceNote ?? "nothing was said"),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}
