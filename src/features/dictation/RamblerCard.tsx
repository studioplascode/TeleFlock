import { Sparkles, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { RambleState } from "@/core";
import { Button, IconButton, Spinner, cn } from "@/design";

const shell = "mb-2 rounded-lg bg-accent/10 text-xs font-semibold text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]";
/** On the sunset ask card: translucent dark panel, light text (the accent would vanish on that pink). */
const sunShell = "mb-2 rounded-lg bg-black/20 text-xs font-semibold text-on-sun shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)] [&_.kicker]:text-on-sun [&_button]:text-on-sun [&_svg]:text-on-sun";

/** What Settings → Dictation calls the model role, for the strip. */
function roleLabel(role: string): string {
  return role === "default" ? "default" : role;
}

export interface RamblerCardProps {
  state: RambleState;
  /** Recognised words that may still change. */
  interim: string;
  listening: boolean;
  mobile: boolean;
  /** `sun`: on the ask card's sunset background. */
  tone?: "sun";
}

/**
 * Above the box while dictating with Rambler: the transcript as it is recognised, what is being heard right now in
 * italics (nothing is sent while the person speaks); after the stop, "Tidying…" while the one rewrite runs. A
 * transcript too long to tidy says it stays as dictated.
 */
export function RamblerCard({ state, interim, listening, mobile, tone }: RamblerCardProps) {
  const heard = interim.trim();
  const sun = tone === "sun";
  // The newest words stay in view as they come, unless the person scrolled up to read.
  const words = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = words.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.raw, heard]);
  return (
    <div className={cn(sun ? sunShell : shell, "px-3 py-2", mobile && "text-[13px]")} role="status" aria-live="polite" aria-label="Rambler">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 shrink-0 text-accent-hi" aria-hidden />
        <span className="kicker">Rambler</span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-2xs font-bold text-mute">
          {state.error ? (
            <span className={sun ? "text-on-sun" : "text-warn"}>{state.error}</span>
          ) : state.thinking ? (
            <>
              <Spinner size={12} />
              <span>Tidying…</span>
            </>
          ) : listening ? (
            <>
              <span className="tf-loop size-1.5 shrink-0 animate-breathe rounded-full bg-accent-hi [--tf-breath:1.1s]" aria-hidden />
              <span>Listening · tidies when you stop</span>
            </>
          ) : null}
        </span>
      </div>
      <div
        ref={words}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
        className={cn(
          "mt-1.5 overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] leading-snug font-medium",
          sun ? "text-on-sun" : "text-ink",
          mobile ? "max-h-28" : "max-h-40",
          state.thinking && (sun ? "opacity-80" : "text-mute"),
        )}
        data-testid="rambler-live"
      >
        {state.raw || (!heard && <span className={sun ? "opacity-80" : "text-mute"}>Say what you want done…</span>)}
        {heard && <span className="text-mute-2 italic">{`${state.raw ? " " : ""}${heard}`}</span>}
      </div>
    </div>
  );
}

export interface RamblerResultProps {
  /** The model's rewrite was used (else the raw words stay after a failure). */
  cleaned: boolean;
  /** The raw transcript is in the box now. */
  usingRaw: boolean;
  /** There is another version to switch to. */
  canSwap: boolean;
  error: string | null;
  role: string;
  onSwap(): void;
  onUndo(): void;
  onDismiss(): void;
  mobile: boolean;
  tone?: "sun";
}

/** After the fill: what went into the box, "Use raw transcript" (and back), Undo. */
export function RamblerResult({ cleaned, usingRaw, canSwap, error, role, onSwap, onUndo, onDismiss, mobile, tone }: RamblerResultProps) {
  return (
    <div className={cn(tone === "sun" ? sunShell : shell, "flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5", mobile && "text-[13px]")} role="status" aria-label="Rambler">
      <Sparkles className="size-3.5 shrink-0 text-accent-hi" aria-hidden />
      <span className="min-w-0 flex-1 basis-40">
        {cleaned ? (usingRaw ? "Raw transcript in the box" : <>Tidied by the {roleLabel(role)} model</>) : <>Kept as dictated{error ? <span className="font-medium text-mute"> · {error}</span> : null}</>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {canSwap && (
          <Button size="sm" variant="ghost" onClick={onSwap}>
            {usingRaw ? "Use tidied prompt" : "Use raw transcript"}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onUndo}>
          Undo
        </Button>
        <IconButton label="Hide" size="sm" onClick={onDismiss}>
          <X />
        </IconButton>
      </span>
    </div>
  );
}
