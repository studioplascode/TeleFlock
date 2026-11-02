import type { RecordingInfo } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { formatLength, formatTime, type RecordingDoc, type Spoken, type Timeline } from "./timeline";

/*
 * What a prompt carries of a recording sent to an agent: a reference block naming the files on
 * the agent's host (the timeline first, then the video and the screenshots), the timeline itself
 * inline when it is short, and the task text taken from what was said.
 */

/** The timeline goes inline in the prompt up to this many lines… */
export const INLINE_MAX_LINES = 60;
/** …and this many characters; longer ones are only referenced (the agent reads the file). */
export const INLINE_MAX_CHARS = 6000;
/** Screenshots attached to the prompt as images (the rest go as files the timeline names). */
export const INLINE_SHOTS = 4;
/** Screenshots uploaded with a recording at most. */
export const MAX_SHOT_FILES = 24;

/** The task text when nothing was said. */
export const SILENT_TASK = "The attached recording shows the problem: find the cause and fix it.";

/** The review's document of a recording (`RecordingInfo.doc`), or an empty one. */
export function docOf(info: Pick<RecordingInfo, "doc">): RecordingDoc {
  const d = info.doc as Partial<RecordingDoc> | null | undefined;
  return d && typeof d === "object" && d.v === 1 ? (d as RecordingDoc) : { v: 1 };
}

/** What was said, as kept in review (removed parts and dropped lines left out). */
export function spokenText(spoken: readonly Spoken[], tl: Pick<Timeline, "speech">): string {
  return tl.speech
    .map((e) => spoken[e.index]?.text.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

/** Why a recording has no transcript (or none yet), for the agent and the review sheet; undefined when it has one. */
export function voiceNote(info: Pick<RecordingInfo, "voice" | "transcript">): string | undefined {
  const v = info.voice;
  if (v.state === "off") return "recorded without the microphone";
  if (v.state === "unavailable") return v.message ?? "this device records no voice";
  if (v.state === "failed") return `the microphone didn't work${v.message ? `: ${v.message}` : ""}`;
  const t = info.transcript;
  switch (t.state) {
    case "noModel":
      return "no speech model on the recording device (Settings → Dictation)";
    case "unavailable":
      return t.message ?? "this build has no speech recognition";
    case "failed":
      return `the transcription failed${t.message ? `: ${t.message}` : ""}`;
    case "waiting":
    case "running":
      return "the transcript was not ready yet";
    case "done":
      return t.segments.some((s) => s.text.trim()) ? undefined : "nothing was said";
    default:
      return "nothing was said";
  }
}

/** The task text: as edited in review, else Rambler's rewrite when chosen, else what was said, else `SILENT_TASK`. */
export function taskText(doc: RecordingDoc, spoken: string): string {
  if (doc.task?.trim()) return doc.task.trim();
  if (doc.useCleaned && doc.cleaned?.trim()) return doc.cleaned.trim();
  return spoken.trim() || SILENT_TASK;
}

/** `checkout-total-1a2b`: a recording's files on the host start with this. */
export function fileStem(title: string, id: string): string {
  const words = title
    .replace(/·.*$/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${words || "recording"}-${id.replace(/^rec_/, "").slice(0, 4)}`;
}

/** The timeline as plain lines for the prompt, or null when it is too long to go inline. */
export function inlineTimeline(tl: Timeline, shotRef: (name: string) => string): string | null {
  const lines = tl.entries.map((e) => `${formatTime(e.at)} ${e.kind === "shot" && e.shot ? `screenshot: ${shotRef(e.shot)}` : e.text}`);
  if (lines.length > INLINE_MAX_LINES) return null;
  const text = lines.join("\n");
  return text.length > INLINE_MAX_CHARS ? null : text;
}

/**
 * The screenshots worth sending, at most `max`: the ones taken at errors first, then the start, the
 * clicks right before an error, the pages and the end, then the rest in time order.
 */
export function pickShots(tl: Timeline, max: number): string[] {
  if (max <= 0 || !tl.shots.length) return [];
  const errorTimes = tl.errors.filter((e) => e.level === "error").map((e) => e.at);
  const nearError = (at: number) => errorTimes.some((t) => t >= at && t - at <= 3000);
  const rank = (s: Timeline["shots"][number]): number => {
    if (s.reason === "error") return 0;
    if (s.reason === "click" && nearError(s.at)) return 1;
    if (s.reason === "start") return 2;
    if (s.reason === "end") return 3;
    if (s.reason === "page") return 4;
    return 5;
  };
  const chosen = [...tl.shots]
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.s.at - b.s.at);
  return chosen.map((c) => c.s.name);
}

export interface RecordingRefInput {
  title: string;
  /** The video's length as sent, ms. */
  duration: number;
  timeline: string;
  json?: string;
  video?: { path: string; bytes: number };
  /** Screenshot files uploaded, and how many of them are attached as images too. */
  shotFiles: number;
  shotImages: number;
  /** The timeline lines when short enough to go inline (`inlineTimeline`). */
  inline?: string | null;
  /** Why there is no transcript (no voice, no speech model), when there is none. */
  voiceNote?: string;
}

/** The prompt's block for one recording, after the task text. */
export function recordingRef(r: RecordingRefInput): string {
  const lines = [`Attached recording "${r.title}" (${formatLength(r.duration)}, made in the TeleFlock Browser): what I did and said, and what failed, in order, with times into the video.`];
  lines.push(`- Timeline: ${r.timeline} (read it first${r.json ? `; the same as data: ${r.json}` : ""})`);
  if (r.video) lines.push(`- Video: ${r.video.path} (${formatBytes(r.video.bytes)}, 10 fps; read it to see it, or read ${r.video.path}:00:14.0 for the frame at a time in the timeline)`);
  if (r.shotFiles) {
    const images = r.shotImages ? `; ${r.shotImages === r.shotFiles ? "all" : `${r.shotImages} of them`} attached as images too` : "";
    lines.push(`- Screenshots: ${r.shotFiles} ${r.shotFiles === 1 ? "file" : "files"}, named in the timeline at the moment each was taken${images}`);
  }
  if (r.voiceNote) lines.push(`- No transcript: ${r.voiceNote}`);
  if (r.inline) lines.push("", "Timeline:", r.inline);
  return lines.join("\n");
}
