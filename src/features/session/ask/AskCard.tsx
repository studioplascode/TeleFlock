import { Check, MessageCircle, PenLine, Send, SquareTerminal, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { parseAgentKey, useAgent } from "@/core";
import type { Answer, NeedsOption, UiRequest } from "@/core/gen";
import { cn, Elapsed, Spinner, spring } from "@/design";
import { haptic } from "@/features/shell/haptics";
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

const KIND_LABEL: Record<string, string> = {
  ask: "omp asks · blocking",
  approval: "Approval needed",
  planReview: "Review plan",
  confirm: "Confirm",
  input: "omp needs input",
};

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
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
  const [other, setOther] = useState<string | null>(null);
  const [text, setText] = useState(request.initial ?? "");
  const [sent, setSent] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [busy, run] = usePending();
  const otherRef = useRef<HTMLInputElement>(null);
  const multi = request.kind === "multiSelect";
  const editor = request.kind === "editor" || request.kind === "input";
  const options: NeedsOption[] =
    request.options.length > 0 || editor
      ? request.options
      : [
          { id: "__confirm", label: "Confirm", recommended: true, tone: "primary" },
          { id: "__cancel", label: "Cancel", recommended: false, tone: "danger" },
        ];
  const kindKey = request.kind === "planReview" ? "planReview" : (needs?.kind ?? (request.kind === "confirm" ? "confirm" : editor ? "input" : "ask"));

  const answer = async (a: Partial<Answer>, label: string) => {
    if (busy || sent) return;
    const full: Answer = { choices: [], cancel: false, chat: false, ...a };
    const res = await run(hostCall(hostId, "agent.answer", { agentId, requestId: request.id, answer: full }, { failure: "Answer not delivered" }));
    if (res.ok) {
      haptic("success");
      setSent(label);
      onAnswered?.();
    } else haptic("warning");
  };

  const choose = (o: NeedsOption) => {
    if (o.id === "__confirm") return answer({}, o.label);
    if (o.id === "__cancel") return answer({ cancel: true }, o.label);
    if (multi) {
      haptic("select");
      setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]));
      return;
    }
    setChoosing(o.id);
    return answer({ choices: [o.id] }, o.label);
  };

  const submit = () => {
    if (editor) return answer({ text }, "Submitted");
    if (other != null && other.trim()) return answer({ choices: multi ? picked : [], text: other.trim() }, other.trim());
    if (multi && picked.length > 0) return answer({ choices: picked }, `${picked.length} selected`);
  };

  const canSubmit = editor ? true : (other != null && other.trim() !== "") || (multi && picked.length > 0);

  // 1–9 pick, Enter sends (multi/other), Esc in Other closes it.
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (e: KeyboardEvent) => {
      // Digits pass through from an empty composer so the card answers without leaving the keyboard.
      const fromEmptyComposer = e.target instanceof HTMLTextAreaElement && e.target.hasAttribute("data-composer") && e.target.value === "";
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (isEditable(e.target) && !fromEmptyComposer)) return;
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
  // the message: promote it to the headline. Approval messages repeat the command and the title.
  const genericTitle = /^(question|ask|input|confirm|continue\??)$/i.test(request.title.trim());
  const message = request.message
    ?.split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(needs?.command && t === needs.command.trim()) && !(kindKey === "approval" && /^allow tool:/i.test(t));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const headline = genericTitle && message ? message : request.title;
  const body = genericTitle && message ? null : message;
  return (
    <motion.section
      layout
      aria-label={request.title}
      data-status="needs-you"
      className={cn(
        "relative isolate overflow-hidden text-white",
        compact ? "rounded-[24px] px-4 pt-3.5 pb-4" : "rounded-tile px-5 pt-4 pb-5",
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
          {KIND_LABEL[kindKey] ?? KIND_LABEL.ask}
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

      <h3 className={cn("relative mt-2.5 mb-1 font-display font-bold tracking-[-0.03em] text-balance", compact ? "text-xl leading-[1.2]" : "text-[25px] leading-[1.15]")}>{headline}</h3>
      {body && <div className="relative mb-2 text-[13px] leading-[1.5] whitespace-pre-wrap text-white/90">{body}</div>}
      {needs?.command && (
        <div className="relative my-2.5 overflow-hidden rounded-md bg-[rgb(30_4_18/0.42)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)]">
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
        <div className={cn("relative mt-2 grid gap-2", compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2")} role={multi ? "group" : "radiogroup"} aria-label="Options">
          {options.map((o, i) => {
            const on = picked.includes(o.id) || sent === o.label;
            return (
              <motion.button
                key={o.id}
                type="button"
                role={multi ? "checkbox" : "radio"}
                aria-checked={on}
                disabled={busy || (!!sent && sent !== o.label)}
                onClick={() => void choose(o)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, delay: 0.03 * i } }}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.97 }}
                className={cn(
                  "focus-ring group/opt flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors duration-200",
                  on
                    ? "bg-white text-[#2a0b16] shadow-[0_12px_26px_-8px_rgb(80_0_30/0.55)]"
                    : o.tone === "danger"
                      ? "bg-[rgb(45_0_22/0.34)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.28)] hover:bg-[rgb(45_0_22/0.48)]"
                      : "bg-[rgb(45_0_22/0.22)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] hover:bg-[rgb(45_0_22/0.34)]",
                  busy && !on && "opacity-70",
                )}
              >
                <span
                  className={cn(
                    "mt-px grid size-[18px] shrink-0 place-items-center transition-shadow",
                    multi ? "rounded-[6px]" : "rounded-full",
                    on ? "bg-sun text-white" : "shadow-[inset_0_0_0_2px_rgb(255_255_255/0.7)]",
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={3.5} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-extrabold">
                    {o.label}
                    {o.recommended && (
                      <span className={cn("rounded-full px-[7px] py-[2px] text-[9.5px] tracking-[0.08em] uppercase", on ? "bg-sun text-white" : "bg-white/25")}>Recommended</span>
                    )}
                  </span>
                  {o.description && <span className={cn("mt-0.5 block text-[11.5px] leading-[1.35]", on ? "opacity-70" : "opacity-[0.88]")}>{o.description}</span>}
                </span>
                {busy && choosing === o.id ? (
                  <Spinner size={13} label="Sending" className="shrink-0" />
                ) : (
                  !compact && i < 9 && <kbd className={cn("shrink-0 rounded-xs px-1.5 font-mono text-[10px] font-bold", on ? "bg-black/10" : "bg-white/15")}>{i + 1}</kbd>
                )}
              </motion.button>
            );
          })}
          {request.allowOther && (
            <div
              className={cn(
                "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                other != null ? "bg-white text-[#2a0b16]" : "bg-[rgb(45_0_22/0.22)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] hover:bg-[rgb(45_0_22/0.34)]",
              )}
            >
              <PenLine className="mt-0.5 size-4 shrink-0" />
              {other == null ? (
                <button
                  type="button"
                  className="focus-ring flex-1 rounded-xs text-left text-[13.5px] font-extrabold"
                  onClick={() => {
                    setOther("");
                    window.setTimeout(() => otherRef.current?.focus(), 0);
                  }}
                >
                  Other…
                  <span className="mt-0.5 block text-[11.5px] font-normal opacity-85">Type your own answer</span>
                </button>
              ) : (
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
                  placeholder="Type your own answer"
                  className="w-full border-0 border-b border-dashed border-[#8a5a6a] bg-transparent py-0.5 text-[13px] font-semibold outline-none placeholder:text-[#8a5a6a]"
                />
              )}
              {!compact && other == null && options.length < 9 && <kbd className="shrink-0 rounded-xs bg-white/15 px-1.5 font-mono text-[10px] font-bold">{options.length + 1}</kbd>}
            </div>
          )}
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
        <div className="relative mt-3 flex flex-wrap items-center gap-2 text-xs font-bold">
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
          {request.options.length > 0 || editor ? (
            <button
              type="button"
              disabled={busy || !!sent}
              onClick={() => void answer({ cancel: true }, "Dismissed")}
              className="pressable focus-ring ml-auto flex items-center gap-1.5 rounded-full px-2.5 py-1.5 opacity-80 hover:bg-black/20 hover:opacity-100"
            >
              <X className="size-3.5" />
              Dismiss
            </button>
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
