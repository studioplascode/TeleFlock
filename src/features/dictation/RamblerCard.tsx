import { ChevronDown, Sparkles, X } from "lucide-react";
import { useState } from "react";
import type { RambleState } from "@/core";
import { Button, IconButton, Spinner, cn } from "@/design";

const shell = "mb-2 rounded-lg bg-accent/10 text-xs font-semibold text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]";
/** On the sunset ask card: translucent dark panel, light text (the accent would vanish on that pink). */
const sunShell = "mb-2 rounded-lg bg-black/20 text-xs font-semibold text-on-sun shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)] [&_.kicker]:text-on-sun [&_button]:text-on-sun [&_svg]:text-on-sun";

/** What Settings → Dictation calls the model role, for the status line. */
function roleLabel(role: string): string {
  return role === "default" ? "default" : role;
}

export interface RamblerCardProps {
  state: RambleState;
  /** Recognised words that may still change. */
  interim: string;
  listening: boolean;
  /** Stopped; the final rewrite is on its way. */
  finishing: boolean;
  role: string;
  mobile: boolean;
  /** `sun`: on the ask card's sunset background. */
  tone?: "sun";
}

/**
 * Above the composer while dictating with Rambler: the live cleaned prompt (the raw words until the first rewrite
 * arrives), what is being heard right now, a "tidying" state while a call runs, and the raw transcript behind a
 * disclosure. A failure keeps the raw words and says why.
 */
export function RamblerCard({ state, interim, listening, finishing, role, mobile, tone }: RamblerCardProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const heard = interim.trim();
  const body = state.clean || state.raw;
  const rewriting = state.thinking || finishing;
  return (
    <div className={cn(tone === "sun" ? sunShell : shell, "px-3 py-2", mobile && "text-[13px]")} role="status" aria-live="polite" aria-label="Rambler">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 shrink-0 text-accent-hi" aria-hidden />
        <span className="kicker">Rambler</span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-2xs font-bold text-mute">
          {state.error ? (
            <span className={cn("truncate", tone === "sun" ? "text-on-sun" : "text-warn")} title={state.error}>
              Keeping your words · {state.error}
            </span>
          ) : rewriting ? (
            <>
              <Spinner size={12} />
              <span>{finishing ? "Finishing…" : "Tidying…"}</span>
            </>
          ) : listening ? (
            <>
              <span className="tf-loop size-1.5 animate-breathe rounded-full bg-accent-hi [--tf-breath:1.1s]" aria-hidden />
              <span>Listening · {roleLabel(role)} model</span>
            </>
          ) : null}
        </span>
      </div>
      <div className={cn("mt-1.5 overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] leading-snug font-medium", tone === "sun" ? "text-on-sun" : "text-ink", mobile ? "max-h-28" : "max-h-40", !state.clean && (tone === "sun" ? "opacity-80" : "text-mute"))} data-testid="rambler-live">
        {body || (heard ? "" : "Say what you want done…")}
        {heard && <span className="text-mute-2 italic">{`${body ? " " : ""}${heard}`}</span>}
      </div>
      {state.clean && state.raw !== state.clean && (
        <div className="mt-1.5">
          <button
            type="button"
            aria-expanded={rawOpen}
            onClick={() => setRawOpen((o) => !o)}
            className="relative inline-flex items-center gap-1 rounded-xs text-2xs font-extrabold text-accent-hi touch-hit focus-ring hover:underline"
          >
            <ChevronDown className={cn("size-3 transition-transform", rawOpen && "rotate-180")} aria-hidden />
            Raw transcript
          </button>
          {rawOpen && <div className={cn("mt-1 overflow-y-auto rounded-sm bg-ink/5 px-2 py-1.5 text-xs font-medium whitespace-pre-wrap break-words text-mute", mobile ? "max-h-24" : "max-h-32")}>{`${state.raw}${heard ? ` ${heard}` : ""}`}</div>}
        </div>
      )}
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
