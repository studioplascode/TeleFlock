import { Pause, Play } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { core } from "@/core";
import type { RecordingFrameRef, RecordingInfo } from "@/core/gen";
import { cn, IconButton } from "@/design";
import { type Cut, formatTime } from "./timeline";

/*
 * The review sheet's player: the recording's pictures (fetched from the app core frame by frame,
 * a few ahead while playing) with its voice in step, and a scrubber showing what happened when
 * (errors, clicks, pages, speech) and the parts removed, which playback skips.
 */

export interface Mark {
  t: number;
  end?: number;
  kind: "error" | "warning" | "click" | "page" | "speech" | "shot";
}

/** The last frame shown at recording time `t` (its index), or -1 before the first. */
export function frameAt(frames: readonly RecordingFrameRef[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((frames[mid]?.t ?? Infinity) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The picture to show at recording time `t`: the last frame at or before it, else the first (a
 * recording's first picture comes a moment after it starts; showing none at 00:00 read as a
 * player stuck on "Loading…"). -1 without frames.
 */
export function shownFrame(frames: readonly RecordingFrameRef[], t: number): number {
  return frames.length ? Math.max(0, frameAt(frames, t)) : -1;
}

/** Where playback goes from `t`: past a removed part it is in. */
export function skipRemoved(t: number, removed: readonly Cut[]): number {
  for (const c of removed) if (t >= c.start && t < c.end) return c.end;
  return t;
}

const CACHE = 90;

/** The recording's voice as an object URL (read once per open sheet), or null without one. */
function useVoice(info: RecordingInfo): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const has = info.voice.state === "on" && (info.voice.durationMs ?? 0) > 0 && info.state === "ready";
  useEffect(() => {
    if (!has) return;
    let gone = false;
    let made: string | null = null;
    void (async () => {
      const parts: BlobPart[] = [];
      let offset = 0;
      let size = Infinity;
      while (offset < size) {
        const r = await core.app("recording.read", { id: info.id, file: "voice.wav", offset, length: 1024 * 1024 });
        size = r.size;
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (!bytes.length) break;
        parts.push(bytes);
        offset += bytes.length;
      }
      if (gone) return;
      made = URL.createObjectURL(new Blob(parts, { type: "audio/wav" }));
      setUrl(made);
    })().catch((e: unknown) => console.warn("[recording] voice", e));
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [has, info.id]);
  return url;
}

export interface PlayerProps {
  info: RecordingInfo;
  frames: readonly RecordingFrameRef[];
  removed: readonly Cut[];
  marks: readonly Mark[];
  /** Recording time shown, ms. */
  pos: number;
  onPos(t: number): void;
  /** The start of a part being marked for removal. */
  markIn: number | null;
  className?: string;
}

export function Player({ info, frames, removed, marks, pos, onPos, markIn, className }: PlayerProps) {
  const duration = Math.max(1, info.durationMs);
  const [playing, setPlaying] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const cache = useRef(new Map<number, string>());
  const loading = useRef(new Set<number>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const voice = useVoice(info);
  const posRef = useRef(pos);
  posRef.current = pos;
  const index = shownFrame(frames, pos);

  const load = (i: number): Promise<string | undefined> => {
    const hit = cache.current.get(i);
    if (hit || i < 0 || i >= frames.length || loading.current.has(i)) return Promise.resolve(hit);
    loading.current.add(i);
    return core
      .app("recording.frame", { id: info.id, index: i })
      .then((r) => {
        const url = `data:image/jpeg;base64,${r.data}`;
        cache.current.set(i, url);
        if (cache.current.size > CACHE) cache.current.delete(cache.current.keys().next().value as number);
        return url;
      })
      .catch(() => undefined)
      .finally(() => loading.current.delete(i));
  };

  // The picture for the position (the nearest loaded one stays until it arrives), and a few ahead while playing.
  useEffect(() => {
    if (index < 0) return;
    let live = true;
    void load(index).then((url) => live && url && setSrc(url));
    if (playing) for (let i = index + 1; i <= index + 6; i++) void load(i);
    return () => {
      live = false;
    };
    // `load` reads refs only.
  }, [index, playing, info.id, frames.length]);

  // Playback: real time, removed parts skipped, the voice in step.
  useEffect(() => {
    if (!playing) {
      audio.current?.pause();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const offset = info.voice.offsetMs ?? 0;
    const syncAudio = (t: number) => {
      const a = audio.current;
      if (!a || !voice) return;
      const at = (t - offset) / 1000;
      if (at < 0 || at > (info.voice.durationMs ?? 0) / 1000) {
        a.pause();
        return;
      }
      if (Math.abs(a.currentTime - at) > 0.25) a.currentTime = at;
      if (a.paused) void a.play().catch(() => undefined);
    };
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      let t = skipRemoved(posRef.current + dt, removed);
      if (t >= duration) {
        t = duration;
        setPlaying(false);
      }
      onPos(t);
      syncAudio(t);
      raf = requestAnimationFrame(step);
    };
    syncAudio(posRef.current);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, removed, duration, voice, info.voice.offsetMs, info.voice.durationMs, onPos]);

  const track = useRef<HTMLDivElement | null>(null);
  const seekTo = (e: PointerEvent<HTMLDivElement>) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    onPos(Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") onPos(Math.max(0, pos - (e.shiftKey ? 5000 : 1000)));
    else if (e.key === "ArrowRight") onPos(Math.min(duration, pos + (e.shiftKey ? 5000 : 1000)));
    else if (e.key === " ") setPlaying((p) => !p);
    else return;
    e.preventDefault();
  };
  const pct = (t: number) => `${(Math.max(0, Math.min(duration, t)) / duration) * 100}%`;
  const ratio = info.width && info.height ? `${info.width} / ${info.height}` : "16 / 10";

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="relative w-full overflow-hidden rounded-[12px] bg-[#101216] shadow-hairline" style={{ aspectRatio: ratio }}>
        {src ? <img src={src} alt={`The recording at ${formatTime(pos)}`} className="absolute inset-0 size-full object-contain" draggable={false} /> : <div className="absolute inset-0 grid place-items-center text-sm text-mute">{frames.length ? "Loading…" : "No pictures in this recording"}</div>}
      </div>
      {voice && <audio ref={audio} src={voice} preload="auto" className="hidden" />}
      <div className="flex items-center gap-2">
        <IconButton label={playing ? "Pause" : "Play"} size="sm" variant="secondary" onClick={() => setPlaying((p) => !p)} disabled={!frames.length}>
          {playing ? <Pause /> : <Play />}
        </IconButton>
        <span className="w-[106px] shrink-0 text-[11.5px] font-bold text-ink-2 tabular-nums">
          {formatTime(pos)} / {formatTime(duration)}
        </span>
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Position in the recording"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={formatTime(pos)}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekTo(e);
          }}
          onPointerMove={(e) => e.buttons === 1 && seekTo(e)}
          className="focus-ring relative h-9 min-w-0 flex-1 cursor-pointer rounded-md"
        >
          <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-ink/10" />
          {marks
            .filter((m) => m.kind === "speech")
            .map((m) => (
              <div key={`s${m.t}`} className="absolute top-[22px] h-1.5 rounded-full bg-accent/45" style={{ left: pct(m.t), width: `calc(${pct(m.end ?? m.t)} - ${pct(m.t)})` }} />
            ))}
          {removed.map((c) => (
            <div key={`r${c.start}`} className="absolute top-2 h-4 rounded-[3px] bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--color-error)_45%,transparent)_0_3px,transparent_3px_6px)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-error)_50%,transparent)]" style={{ left: pct(c.start), width: `calc(${pct(c.end)} - ${pct(c.start)})` }} title={`Removed ${formatTime(c.start)}–${formatTime(c.end)}`} />
          ))}
          {marks
            .filter((m) => m.kind !== "speech")
            .map((m, i) => (
              <div
                key={`${m.kind}${m.t}-${i}`}
                className={cn("absolute top-1.5 w-[2px] -translate-x-1/2 rounded-full", m.kind === "error" ? "h-5 bg-error" : m.kind === "warning" ? "h-4 bg-review" : m.kind === "page" ? "h-4 bg-accent-hi" : m.kind === "click" ? "top-2.5 h-3 bg-ink-2" : "h-2 bg-mute")}
                style={{ left: pct(m.t) }}
              />
            ))}
          {markIn !== null && <div className="absolute top-1 h-6 w-[3px] -translate-x-1/2 rounded-full bg-review" style={{ left: pct(markIn) }} title={`Marked ${formatTime(markIn)}`} />}
          <div className="absolute top-0.5 h-7 w-[3px] -translate-x-1/2 rounded-full bg-ink shadow-[0_0_0_2px_var(--color-sheet-1)]" style={{ left: pct(pos) }} />
        </div>
      </div>
    </div>
  );
}
