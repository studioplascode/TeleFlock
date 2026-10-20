import { motion } from "motion/react";
import { type FormEvent, useState } from "react";
import { useAgent } from "@/core";
import type { NeedsOption, NeedsYou } from "@/core/gen";
import { AnimatePresence, Kbd, Spinner, cn, popIn, spring } from "@/design";
import { answerAgent, openAgent, openTerminal } from "./agentActions";

export type QuickAnswerAppearance = "card" | "hero" | "big";

/** Send one option of a needs-you request. Resolves true when the host accepted it. */
export async function sendOption(agentKey: string, needs: NeedsYou, optionId: string): Promise<boolean> {
  if (!needs.requestId) return false;
  try {
    await answerAgent(agentKey, needs.requestId, { choices: [optionId], cancel: false, chat: false });
    return true;
  } catch {
    return false;
  }
}

const CHIP: Record<QuickAnswerAppearance, { base: string; primary: string; neutral: string; danger: string }> = {
  card: {
    base: "h-7 rounded-sm px-2.5 text-2xs font-bold",
    primary: "bg-sun text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_6px_16px_-6px_rgb(255_61_119/0.7)] hover:brightness-110",
    neutral: "bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] hover:bg-tile-5",
    danger: "bg-error/12 text-[#ff8aa5] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)] hover:bg-error hover:text-white",
  },
  hero: {
    base: "min-h-8 rounded-md px-3 py-1.5 text-xs font-bold text-left",
    primary: "bg-white text-[#d21a5a] shadow-[0_8px_20px_-6px_rgb(80_0_30/0.5)] hover:bg-white/90",
    neutral: "bg-[rgb(40_0_20/0.24)] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)] hover:bg-[rgb(40_0_20/0.36)]",
    danger: "bg-[rgb(40_0_20/0.42)] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.3)] hover:bg-[rgb(60_0_20/0.6)]",
  },
  big: {
    base: "min-h-12 rounded-lg px-4 py-3 text-sm font-bold text-left",
    primary: "bg-sun text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),var(--shadow-glow-sun)]",
    neutral: "bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] active:bg-tile-5",
    danger: "bg-error/14 text-[#ff8aa5] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.4)] active:bg-error active:text-white",
  },
};

/**
 * Inline answer controls for an agent's pending request (spec §1.2 "unblock in one gesture"):
 * approval chips, ask options, multi-select, "Other…" free text, "Chat about this", or the
 * terminal when the dialog isn't answerable in-app.
 */
export function QuickAnswer({
  agentKey,
  appearance = "card",
  max,
  numbered = false,
  mobile = false,
  chat = true,
  onAnswered,
  className,
}: {
  agentKey: string;
  appearance?: QuickAnswerAppearance;
  /** Show at most this many options (the rest are reachable via the session). */
  max?: number;
  /** Show 1–9 key hints (HUD). */
  numbered?: boolean;
  mobile?: boolean;
  /** Offer "Chat about this" when the ask allows it (off on dense surfaces; the session has it). */
  chat?: boolean;
  onAnswered?: () => void;
  className?: string;
}) {
  const needs = useAgent(agentKey)?.needs;
  const [sent, setSent] = useState<{ requestId: string; label: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  if (!needs) return null;
  const chip = CHIP[appearance];
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  if (!needs.answerable || !needs.requestId) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)} onClick={stop} onPointerDown={stop}>
        <button type="button" className={cn(chip.base, chip.primary, "pressable focus-ring")} onClick={() => openTerminal(agentKey, mobile)}>
          Answer in terminal
        </button>
        {needs.kind === "planReview" && (
          <button type="button" className={cn(chip.base, chip.neutral, "pressable focus-ring")} onClick={() => openAgent(agentKey)}>
            Review plan
          </button>
        )}
      </div>
    );
  }

  const requestId = needs.requestId;
  if (sent?.requestId === requestId) {
    return (
      <motion.div {...popIn} className={cn("flex items-center gap-2 text-xs font-bold", appearance === "hero" ? "text-white" : "text-ink", className)}>
        <motion.span
          className="grid size-5 place-items-center rounded-full bg-done text-[#1a2e05]"
          initial={{ scale: 0, rotate: -90 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={spring.bouncy}
        >
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
            <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </motion.span>
        <span className="truncate">Sent · {sent.label}</span>
      </motion.div>
    );
  }

  const send = async (label: string, answer: { choices: string[]; text?: string; cancel?: boolean; chat?: boolean }) => {
    setPending(label);
    try {
      await answerAgent(agentKey, requestId, { choices: answer.choices, text: answer.text, cancel: answer.cancel ?? false, chat: answer.chat ?? false });
      setSent({ requestId, label });
      onAnswered?.();
    } catch {
      // answerAgent already toasted the error; keep the controls so the user can retry.
    } finally {
      setPending(null);
    }
  };

  const options = max !== undefined ? needs.options.slice(0, max) : needs.options;
  const onOption = (o: NeedsOption) => {
    if (needs.multi) setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
    else void send(o.label, { choices: [o.id] });
  };
  const submitOther = (e: FormEvent) => {
    e.preventDefault();
    const text = otherText.trim();
    if (text) void send(text, { choices: [], text });
  };
  const busy = pending !== null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)} onClick={stop} onPointerDown={stop} onKeyDown={stop}>
      <div className={cn("gap-1.5", appearance === "big" ? "grid grid-cols-1 sm:grid-cols-2" : appearance === "hero" && options.length + (needs.allowOther ? 1 : 0) <= 4 && !needs.multi ? "grid grid-cols-2" : "flex flex-wrap")}>
        {options.map((o, i) => {
          const on = needs.multi && picked.includes(o.id);
          return (
            <motion.button
              key={o.id}
              type="button"
              layout="position"
              disabled={busy}
              onClick={() => onOption(o)}
              title={o.description}
              aria-pressed={needs.multi ? on : undefined}
              className={cn(
                chip.base,
                chip[o.tone],
                "pressable focus-ring flex min-w-0 items-center gap-1.5 disabled:opacity-60",
                on && "ring-2 ring-accent",
              )}
            >
              {numbered && i < 9 && <Kbd className="shrink-0">{i + 1}</Kbd>}
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.recommended && <span className="shrink-0 text-[0.85em] opacity-80" aria-label="recommended">★</span>}
              {pending === o.label && <Spinner size={12} />}
            </motion.button>
          );
        })}
        {needs.allowOther && !otherOpen && (
          <button type="button" disabled={busy} onClick={() => setOtherOpen(true)} className={cn(chip.base, chip.neutral, "pressable focus-ring disabled:opacity-60")}>
            Other…
          </button>
        )}
        {chat && needs.allowChat && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void send("Chat about this", { choices: [], chat: true })}
            className={cn(chip.base, chip.neutral, "pressable focus-ring disabled:opacity-60")}
          >
            Chat about this
          </button>
        )}
        {needs.multi && (
          <button
            type="button"
            disabled={busy || picked.length === 0}
            onClick={() => void send(`${picked.length} selected`, { choices: picked })}
            className={cn(chip.base, chip.primary, "pressable focus-ring disabled:opacity-50")}
          >
            Submit {picked.length > 0 && `(${picked.length})`}
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {otherOpen && (
          <motion.form
            key="other"
            onSubmit={submitOther}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.snappy}
            className="flex gap-1.5 overflow-hidden"
          >
            <input
              autoFocus
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setOtherOpen(false);
              }}
              placeholder="Type your own answer…"
              aria-label="Your answer"
              className={cn(
                "min-w-0 flex-1 rounded-sm px-2.5 text-xs font-semibold outline-none focus-ring",
                appearance === "hero" ? "bg-white/90 text-[#3a0a1c] placeholder:text-[#3a0a1c]/50" : "well text-ink placeholder:text-mute-2",
                appearance === "big" ? "min-h-12 text-sm" : "h-8",
              )}
            />
            <button type="submit" disabled={busy || !otherText.trim()} className={cn(chip.base, chip.primary, "pressable focus-ring disabled:opacity-50")}>
              {pending ? <Spinner size={12} /> : "Send"}
            </button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
