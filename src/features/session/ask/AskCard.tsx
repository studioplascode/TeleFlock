import { Check, MessageCircle, PenLine, Send, SquareTerminal } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { answerDraftKey, drafts, parseAgentKey, useAgent, useDraft } from "@/core";
import type { Answer, NeedsKind, NeedsOption, UiRequest } from "@/core/gen";
import { cn, Elapsed, Spinner } from "@/design";
import { OptionTile, SkipButton, isTyping, optionFrame } from "@/features/inbox/AnswerParts";
import { CONFIRM_OPTIONS, optionAnswer, otherAnswer } from "@/features/inbox/answers";
import { askText } from "@/features/inbox/askText";
import { haptic } from "@/features/shell/haptics";
import { NEEDS_WORD } from "@/features/shell/vocab";
import { hostCall, usePending } from "../api";
import { Markdown } from "../markdown/Markdown";

export interface AskCardProps {
  agentKey: string;
  request: UiRequest;
  /** Single-column, tighter layout (mobile, inbox). */
  compact?: boolean;
  /** Listen for 1–9 / Enter globally (only the focused session's card should). */
  hotkeys?: boolean;
  onAnswered?: () => void;
}

/**
 * The sunset ask / approval / plan-review card. Single-select answers in one tap (or key 1–9);
 * multi-select toggles then sends; "Other…" takes free text; editors get a textarea.
 */
export function AskCard({ agentKey, request, compact = false, hotkeys = false, onAnswered }: AskCardProps) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const needs = agent?.needs;
  const [picked, setPicked] = useState<string[]>([]);
  // Free-text answers persist per request (shared with the board and the answer HUD); the Other
  // field shows while open or holding a draft.
  const otherKey = answerDraftKey(agentKey, request.id, "other");
  const textKey = answerDraftKey(agentKey, request.id, "text");
  const [otherText, setOtherText] = useDraft(otherKey);
  const [otherOpen, setOtherOpen] = useState(false);
  const other = otherOpen || otherText !== "" ? otherText : null;
  // On a multi-select a typed answer replaces the ticks: the host takes text only without choices.
  const setOther = (v: string | null) => {
    setOtherOpen(v != null);
    setOtherText(v ?? "");
    if (v != null) setPicked([]);
  };
  const [text, setText] = useDraft(textKey, request.initial ?? "");
  const [sent, setSent] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [busy, run] = usePending();
  const otherRef = useRef<HTMLInputElement>(null);
  const multi = request.kind === "multiSelect";
  const editor = request.kind === "editor" || request.kind === "input";
  const options: readonly NeedsOption[] = request.options.length > 0 || editor ? request.options : CONFIRM_OPTIONS;
  const kindKey: NeedsKind = request.kind === "planReview" ? "planReview" : (needs?.kind ?? (request.kind === "confirm" ? "confirm" : editor ? "input" : "ask"));

  const answer = async (a: Partial<Answer>, label: string) => {
    if (busy || sent) return;
    const full: Answer = { choices: [], cancel: false, chat: false, ...a };
    const res = await run(hostCall(hostId, "agent.answer", { agentId, requestId: request.id, answer: full }, { failure: "Answer not delivered" }));
    if (res.ok) {
      haptic("success");
      drafts.clear(otherKey);
      drafts.clear(textKey);
      setSent(label);
      onAnswered?.();
    } else haptic("warning");
  };

  const choose = (o: NeedsOption) => {
    if (multi) {
      if (other != null) return;
      haptic("select");
      setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
      return;
    }
    setChoosing(o.id);
    return answer(optionAnswer(o.id), o.label);
  };

  const submit = () => {
    if (editor) return answer({ text }, "Submitted");
    if (other != null && other.trim()) return answer(otherAnswer(other), other.trim());
    if (multi && picked.length > 0) return answer({ choices: picked }, `${picked.length} selected`);
  };

  const canSubmit = editor ? true : (other != null && other.trim() !== "") || (multi && picked.length > 0);

  // 1–9 pick, Enter sends (multi/other), Esc in Other closes it.
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      // Digits pass through from an empty composer so the card answers without leaving the keyboard.
      const fromEmptyComposer = e.target instanceof HTMLTextAreaElement && e.target.hasAttribute("data-composer") && e.target.value === "";
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (isTyping(e.target) && !fromEmptyComposer)) return;
      if (fromEmptyComposer && e.key === "Enter") {
        e.preventDefault();
        if (canSubmit && !editor) void submit();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const o = options[Number(e.key) - 1];
        if (o) {
          e.preventDefault();
          void choose(o);
        } else if (request.allowOther && Number(e.key) === options.length + 1) {
          e.preventDefault();
          setOther("");
          window.setTimeout(() => otherRef.current?.focus(), 0);
        }
      } else if (e.key === "Enter" && canSubmit && !editor) {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const n = options.length + (request.allowOther ? 1 : 0);
  // omp often titles dialogs generically ("Question", "Continue?") and puts the real question in
  // the message; an approval's command shows once, in its code block.
  const { headline, body } = askText({ title: request.title, message: request.message, command: needs?.command, approval: kindKey === "approval" });
  return (
    <motion.section
      layout
      aria-label={request.title}
      data-status="needs-you"
      className={cn(
        "relative isolate overflow-hidden text-white",
        compact ? "rounded-[24px] px-3.5 pt-3 pb-3.5" : "rounded-tile px-5 pt-4 pb-5",
        "[background:radial-gradient(90%_140%_at_100%_0%,rgb(255_61_119)_0%,transparent_65%),linear-gradient(125deg,#ff7a18,#ff3d77)]",
        "shadow-[0_30px_70px_-18px_rgb(255_61_119/0.75),0_10px_30px_-10px_rgb(255_122_24/0.6),inset_0_1px_0_rgb(255_255_255/0.35)]",
      )}
    >
      <span className="pointer-events-none absolute -bottom-[120px] -left-[60px] -z-10 size-[300px] rounded-full border-[44px] border-white/[0.07]" aria-hidden />
      <span className="tf-loop pointer-events-none absolute inset-0 -z-10 animate-sun-pulse bg-[radial-gradient(60%_80%_at_0%_100%,rgb(255_255_255/0.16),transparent_70%)]" aria-hidden />

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-2 rounded-full bg-black/20 px-2.5 py-1 text-[11px] font-extrabold tracking-wide">
          <span className="relative flex size-2">
            <span className="tf-loop absolute inset-0 animate-ping-soft rounded-full bg-white" />
            <span className="relative size-2 rounded-full bg-white" />
          </span>
          {NEEDS_WORD[kindKey]}
          {needs?.since != null && (
            <span className="font-semibold opacity-80">
              · <Elapsed since={needs.since} />
            </span>
          )}
        </span>
        {!editor && !compact && (
          <span className="ml-auto text-[11.5px] font-bold opacity-85">
            {multi ? "Pick any" : "Pick one"} · <span className="font-mono">1–{Math.min(n, 9)}</span>
          </span>
        )}
        {(canSubmit || editor) && !compact && (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !!sent || !canSubmit}
            className={cn("pressable focus-ring flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-extrabold text-[#d21a5a] disabled:opacity-60", compact && "ml-auto")}
          >
            {editor ? "Submit" : "Send answer"}
            <Send className="size-3.5" />
          </button>
        )}
      </div>

      <h3 className={cn("relative mb-1 font-display font-bold tracking-[-0.03em] text-balance", compact ? "mt-2 text-lg leading-[1.2]" : "mt-2.5 text-[25px] leading-[1.15] short:text-[21px]")}>{headline}</h3>
      {body && <div className="relative mb-2 text-[13px] leading-[1.5] whitespace-pre-wrap text-white/90">{body}</div>}
      {needs?.command && (
        <div className={cn("relative overflow-hidden rounded-md bg-[rgb(30_4_18/0.42)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]", compact ? "my-2" : "my-2.5")}>
          <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-1 text-[10px] font-extrabold tracking-[0.08em] uppercase opacity-75">
            <SquareTerminal className="size-3" /> Wants to run
          </div>
          <pre className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-[1.5] whitespace-pre-wrap">
            <span className="select-none opacity-60">$ </span>
            {needs.command}
          </pre>
        </div>
      )}

      {request.plan && (
        <div className="relative my-3 max-h-[min(44vh,420px)] overflow-y-auto rounded-[18px] bg-[#16121c]/90 px-4 py-3 text-ink shadow-[0_12px_30px_-12px_rgb(60_0_30/0.6)]">
          {(request.plan.title || request.plan.path) && (
            <div className="mb-2 flex items-center gap-2 border-b border-line pb-2">
              <span className="font-display text-md font-bold">{request.plan.title ?? "Plan"}</span>
              {request.plan.path && <span className="ml-auto truncate font-mono text-2xs text-mute-2">{request.plan.path}</span>}
            </div>
          )}
          <Markdown text={request.plan.content} className="text-[13px]" />
        </div>
      )}

      {editor && (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={compact ? 4 : 6}
          aria-label="Your answer"
          className="relative mt-2 w-full resize-y rounded-[16px] bg-black/20 px-3 py-2.5 font-mono text-[12.5px] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)] outline-none placeholder:text-white/60 focus:shadow-[inset_0_0_0_2px_rgb(255_255_255/0.7)]"
          placeholder="Type your answer…"
        />
      )}

      {options.length > 0 && (
        <div className={cn("relative mt-2 grid", compact ? "grid-cols-1 gap-1.5" : "grid-cols-1 gap-2 sm:grid-cols-2")} role="group" aria-label="Options">
          {options.map((o, i) => (
            <OptionTile
              key={o.id}
              skin="sun"
              option={o}
              number={!compact && i < 9 ? i + 1 : undefined}
              multi={multi}
              on={picked.includes(o.id) || sent === o.label}
              pending={busy && choosing === o.id}
              describe="full"
              disabled={busy || (!!sent && sent !== o.label) || (multi && other != null)}
              enter={i}
              onClick={() => void choose(o)}
            />
          ))}
          {request.allowOther &&
            (other == null ? (
              <OptionTile
                skin="sun"
                option={{ label: "Other…", description: "Type your own answer" }}
                number={!compact && options.length < 9 ? options.length + 1 : undefined}
                icon={compact ? <PenLine /> : undefined}
                describe="full"
                disabled={busy || !!sent}
                enter={options.length}
                onClick={() => {
                  setOther("");
                  window.setTimeout(() => otherRef.current?.focus(), 0);
                }}
              />
            ) : (
              <div className={optionFrame("sun", { on: true })}>
                <PenLine className="mt-0.5 size-4 shrink-0" />
                <input
                  ref={otherRef}
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submit();
                    } else if (e.key === "Escape") {
                      e.stopPropagation();
                      setOther(null);
                    }
                  }}
                  aria-label="Other answer"
                  placeholder={multi ? "Your own answer (replaces the ticks)" : "Type your own answer"}
                  className="w-full border-0 border-b border-dashed border-[#8a5a6a] bg-transparent py-0.5 text-[13px] font-semibold outline-none placeholder:text-[#8a5a6a]"
                />
              </div>
            ))}
        </div>
      )}

      {/* Phones: the send action sits under the options, full width, in the thumb zone. */}
      {compact && (canSubmit || editor) && (
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !!sent || !canSubmit}
          className="pressable focus-ring relative mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-white text-sm font-extrabold text-[#d21a5a] shadow-[0_12px_26px_-8px_rgb(80_0_30/0.55)] disabled:opacity-60"
        >
          {busy ? <Spinner size={14} label="Sending" /> : <Send className="size-4" />}
          {editor ? "Submit" : multi && picked.length > 0 ? `Send ${picked.length} selected` : "Send answer"}
        </button>
      )}

      {(request.allowChat || request.kind !== "planReview") && (
        <div className={cn("relative flex flex-wrap items-center gap-2 text-xs font-bold", compact ? "mt-2" : "mt-3")}>
          {request.allowChat && (
            <button
              type="button"
              disabled={busy || !!sent}
              onClick={() => void answer({ chat: true }, "Chat")}
              className="pressable focus-ring flex items-center gap-1.5 rounded-full bg-black/20 px-3 py-1.5 hover:bg-black/30"
            >
              <MessageCircle className="size-3.5" />
              Chat about this
            </button>
          )}
          {request.kind !== "planReview" && (request.options.length > 0 || editor) ? (
            <SkipButton sunset className="ml-auto" disabled={busy || !!sent} onClick={() => void answer({ cancel: true }, "Skipped")} />
          ) : null}
          {sent && (
            <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="flex items-center gap-1 rounded-full bg-white/25 px-2.5 py-1">
              <Check className="size-3.5" /> Sent · waiting for omp
            </motion.span>
          )}
        </div>
      )}
    </motion.section>
  );
}
