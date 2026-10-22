import { MessageCircle, PenLine, Send } from "lucide-react";
import { motion, useIsPresent } from "motion/react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { answerDraftKey, openSession, useAgent, useCore, useDraft } from "@/core";
import type { Answer, NeedsOption } from "@/core/gen";
import { AnimatePresence, Kbd, Spinner, cn, popIn, spring } from "@/design";
import { type OptionSkin, OptionTile, SkipButton, isTyping } from "@/features/inbox/AnswerParts";
import { needsOptions, optionAnswer, otherAnswer } from "@/features/inbox/answers";
import { answerAgent, openAgent, openAnswerHud, openTerminal } from "./agentActions";

export type QuickAnswerAppearance = "card" | "hero" | "big";

/** Buttons that act (Submit, Send, Answer…), and plain chips (+N more, Other… on cards). */
const CHIP: Record<QuickAnswerAppearance, { base: string; action: string; neutral: string }> = {
  card: {
    base: "min-h-7 rounded-sm px-2.5 text-2xs font-bold",
    action: "bg-sun text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_6px_16px_-6px_rgb(255_61_119/0.7)] hover:brightness-110",
    neutral: "bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] hover:bg-tile-5",
  },
  hero: {
    base: "min-h-8 rounded-md px-3 py-1.5 text-xs font-bold text-left",
    action: "bg-white text-[#d21a5a] shadow-[0_8px_20px_-6px_rgb(80_0_30/0.5)] hover:bg-white/90",
    neutral: "bg-[rgb(40_0_20/0.24)] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)] hover:bg-[rgb(40_0_20/0.36)]",
  },
  big: {
    base: "min-h-11 rounded-lg px-3.5 py-2.5 text-sm font-bold text-left",
    action: "bg-sun text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),var(--shadow-glow-sun)]",
    neutral: "bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] active:bg-tile-5",
  },
};

/**
 * Inline answer controls for an agent's pending request (spec §1.2 "unblock in one gesture"),
 * drawn with the shared option model (`features/inbox/AnswerParts`): options with their
 * descriptions, multi-select, "Other…" free text, "Chat about this", Confirm / Cancel for bare
 * confirms, a textarea for input requests on roomy surfaces ("Answer…" → HUD on cards), or the
 * terminal when the dialog isn't answerable in-app.
 */
export function QuickAnswer({
  agentKey,
  appearance = "card",
  max,
  full = false,
  numbered = false,
  hotkeys = false,
  mobile = false,
  chat = true,
  onAnswered,
  className,
}: {
  agentKey: string;
  appearance?: QuickAnswerAppearance;
  /** Show at most this many options; a "+N more" chip opens the HUD on this agent. */
  max?: number;
  /** Roomy surface (Inbox, HUD): full descriptions, a textarea for input requests, Skip. */
  full?: boolean;
  /** 1…N badges, Other = N+1; the keys work while focus is inside the controls. */
  numbered?: boolean;
  /** 1–9 answer from anywhere (the HUD: one question on screen). */
  hotkeys?: boolean;
  mobile?: boolean;
  /** Offer "Chat about this" when the ask allows it (off on dense surfaces; the session has it). */
  chat?: boolean;
  onAnswered?: () => void;
  className?: string;
}) {
  const needs = useAgent(agentKey)?.needs;
  const requestId = needs?.requestId ?? "";
  const live = !!needs?.answerable && requestId !== "";
  const [sent, setSent] = useState<{ requestId: string; label: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // null = untouched: the "Other…" field shows on its own when a typed answer is waiting
  const [otherOpen, setOtherOpen] = useState<boolean | null>(null);
  const [otherText, setOtherText, clearOther] = useDraft(answerDraftKey(agentKey, requestId, "other"));
  const [picked, setPicked] = useState<string[]>([]);
  const otherRef = useRef<HTMLInputElement>(null);
  // a HUD card sliding out keeps its props; only the one on screen takes number keys
  const present = useIsPresent();
  const editor = !!needs && needs.kind === "input" && needs.options.length === 0;
  const textarea = full && editor && live;
  // Input requests prefill with the dialog's default text, which only the session carries.
  const ui = useCore((s) => s.sessions[agentKey]?.ui);
  const [text, setText, clearText] = useDraft(answerDraftKey(agentKey, requestId, "text"), ui && ui.id === requestId ? (ui.initial ?? "") : "");
  useEffect(() => {
    if (textarea) return openSession(agentKey);
  }, [textarea, agentKey]);

  const options: readonly NeedsOption[] = needs ? needsOptions(needs) : [];
  const busy = pending !== null;
  const answered = sent !== null && sent.requestId === requestId;

  const send = async (label: string, answer: Partial<Answer>) => {
    if (!live || busy) return;
    setPending(label);
    try {
      await answerAgent(agentKey, requestId, { choices: [], cancel: false, chat: false, ...answer });
      setSent({ requestId, label });
      clearOther();
      clearText();
      onAnswered?.();
    } catch {
      // answerAgent already toasted the error; keep the controls so the user can retry.
    } finally {
      setPending(null);
    }
  };
  // On a multi-select, a typed answer replaces the ticks (the host takes text only without choices).
  const showOther = !!needs?.allowOther && (otherOpen ?? otherText !== "");
  const onOption = (o: NeedsOption) => {
    if (!needs?.multi) void send(o.label, optionAnswer(o.id));
    else if (!showOther) setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
  };
  const openOther = () => {
    setOtherOpen(true);
    setPicked([]);
    window.setTimeout(() => otherRef.current?.focus(), 0);
  };
  /** 1…N picks an option, N+1 opens Other. */
  const pickByKey = (key: string): boolean => {
    if (!live || busy || answered || !/^[1-9]$/.test(key)) return false;
    const i = Number(key) - 1;
    const o = options[i];
    if (o) onOption(o);
    else if (needs?.allowOther && i === options.length) openOther();
    else return false;
    return true;
  };

  useEffect(() => {
    if (!hotkeys || !present) return;
    // Capture phase: the HUD's question wins over a session ask card underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (pickByKey(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!needs) return null;
  const chip = CHIP[appearance];
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  if (!live) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)} onClick={stop} onPointerDown={stop}>
        <button type="button" className={cn(chip.base, chip.action, "pressable focus-ring")} onClick={() => openTerminal(agentKey, mobile)}>
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

  if (answered) {
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

  const onRootKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (numbered && !hotkeys && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target) && pickByKey(e.key)) e.preventDefault();
  };
  const skin: OptionSkin = appearance === "card" ? (full ? "panel" : "card") : appearance;
  const describe = full ? "full" : "clamp";
  const shown = max !== undefined && options.length > max ? options.slice(0, max) : options;
  const more = options.length - shown.length;
  const offerChat = chat && needs.allowChat;
  // Roomy and phone layouts give Other / Chat their own row (half width each); cards keep chips.
  const rowed = full || appearance === "big";
  // omp refuses to dismiss a plan review remotely; Skip is offered only where it can work.
  const skip = full && needs.kind !== "planReview" && (needs.options.length > 0 || editor);

  const submitOther = (e: FormEvent) => {
    e.preventDefault();
    const answer = otherAnswer(otherText);
    if (answer.text) void send(answer.text, answer);
  };

  const otherTile = needs.allowOther && !showOther && (
    <OptionTile
      skin={skin}
      option={{ label: "Other…", description: full && appearance !== "big" ? "Type your own answer" : undefined }}
      icon={numbered && options.length < 9 ? undefined : <PenLine />}
      number={numbered && options.length < 9 ? options.length + 1 : undefined}
      describe={describe}
      disabled={busy}
      onClick={openOther}
    />
  );
  const chatTile = offerChat && (
    <OptionTile skin={skin} option={{ label: "Chat about this" }} icon={<MessageCircle />} disabled={busy} pending={pending === "Chat about this"} onClick={() => void send("Chat about this", { chat: true })} />
  );

  return (
    <div className={cn("flex flex-col gap-1.5", className)} onClick={stop} onPointerDown={stop} onKeyDown={onRootKey}>
      {textarea ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send("Submitted", { text });
              }
            }}
            rows={mobile ? 4 : 5}
            aria-label="Your answer"
            placeholder="Type your answer…"
            className={cn("well w-full resize-y rounded-md px-3 py-2.5 font-mono text-xs leading-relaxed text-ink outline-none placeholder:text-mute-2 focus-ring", mobile && "text-sm")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void send("Submitted", { text })} className={cn(chip.base, chip.action, "pressable focus-ring flex items-center gap-1.5 disabled:opacity-60")}>
              {busy ? <Spinner size={12} label="Sending" /> : <Send className="size-3.5" aria-hidden />}
              Submit
            </button>
            {!mobile && (
              <span className="text-2xs font-semibold text-mute-2">
                <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd>
              </span>
            )}
            <SkipButton className="ml-auto" disabled={busy} onClick={() => void send("Skipped", { cancel: true })} />
          </div>
        </div>
      ) : editor ? (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => openAnswerHud(agentKey)} className={cn(chip.base, chip.action, "pressable focus-ring")}>
            Answer…
          </button>
        </div>
      ) : (
        <>
          <div
            role="group"
            aria-label="Options"
            className={cn(
              "gap-1.5",
              full && appearance === "card"
                ? "grid grid-cols-1 sm:grid-cols-2"
                : appearance === "big"
                  ? "grid grid-cols-1"
                  : appearance === "hero" && shown.length + (needs.allowOther ? 1 : 0) + (more > 0 ? 1 : 0) <= 4 && !needs.multi
                    ? "grid grid-cols-2"
                    : "flex flex-wrap",
            )}
          >
            {shown.map((o, i) => (
              <OptionTile
                key={o.id}
                skin={skin}
                option={o}
                number={numbered && i < 9 ? i + 1 : undefined}
                multi={needs.multi}
                on={needs.multi && picked.includes(o.id)}
                pending={pending === o.label}
                describe={describe}
                disabled={busy || (needs.multi && showOther)}
                onClick={() => onOption(o)}
                className={appearance === "card" && !full ? "max-w-full" : undefined}
              />
            ))}
            {more > 0 && (
              <button
                type="button"
                onClick={() => openAnswerHud(agentKey)}
                title="See every option in Answer next"
                className={cn(chip.base, chip.neutral, "pressable focus-ring")}
              >
                +{more} more
              </button>
            )}
            {!rowed && otherTile}
            {!rowed && chatTile}
          </div>
          {rowed && (otherTile || chatTile) && <div className={cn("grid gap-1.5", otherTile && chatTile ? "grid-cols-2" : "grid-cols-1")}>{otherTile}{chatTile}</div>}
          {needs.multi && (
            <div className="flex">
              <button
                type="button"
                disabled={busy || picked.length === 0 || showOther}
                onClick={() => void send(`${picked.length} selected`, { choices: picked })}
                className={cn(chip.base, chip.action, "pressable focus-ring disabled:opacity-50")}
              >
                Submit {picked.length > 0 && `(${picked.length})`}
              </button>
            </div>
          )}
          <AnimatePresence initial={false}>
            {showOther && (
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
                  ref={otherRef}
                  autoFocus={otherOpen === true}
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") setOtherOpen(false);
                  }}
                  placeholder={needs.multi ? "Your own answer (replaces the ticks)…" : "Type your own answer…"}
                  aria-label="Your answer"
                  className={cn(
                    "min-w-0 flex-1 rounded-sm px-2.5 text-xs font-semibold outline-none focus-ring",
                    appearance === "hero" ? "bg-white/90 text-[#3a0a1c] placeholder:text-[#3a0a1c]/50" : "well text-ink placeholder:text-mute-2",
                    appearance === "big" ? "min-h-11 text-sm" : "h-8",
                  )}
                />
                <button type="submit" disabled={busy || !otherText.trim()} className={cn(chip.base, chip.action, "pressable focus-ring disabled:opacity-50")}>
                  {busy ? <Spinner size={12} /> : "Send"}
                </button>
              </motion.form>
            )}
          </AnimatePresence>
          {skip && (
            <div className="flex justify-end">
              <SkipButton disabled={busy} onClick={() => void send("Skipped", { cancel: true })} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
