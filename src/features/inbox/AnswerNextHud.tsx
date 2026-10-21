import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { useAgent, useInbox, useUi } from "@/core";
import { Dialog, DialogContent, Kbd, NumberTicker, cn, spring, useIsMobile } from "@/design";
import { openAgent } from "@/features/board/agentActions";
import { QuickAnswer, sendOption } from "@/features/board/QuickAnswer";
import { LastAssistantText, NeedsHeader, NeedsQuestion } from "./NeedsContext";

type Dir = 1 | -1 | 0;

const slide = {
  enter: (dir: Dir) => ({ opacity: 0, x: dir === 0 ? 0 : dir * 70, y: dir === 0 ? 46 : 0, scale: dir === 0 ? 0.94 : 1, filter: "blur(4px)" }),
  center: { opacity: 1, x: 0, y: 0, scale: 1, filter: "blur(0px)" },
  exit: (dir: Dir) =>
    dir === 0
      ? { opacity: 0, y: -60, scale: 0.9, filter: "blur(6px)", transition: { duration: 0.38, ease: [0.4, 0, 0.2, 1] as const } }
      : { opacity: 0, x: -dir * 70, filter: "blur(4px)", transition: { duration: 0.2 } },
};

function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/** Burst ring when an answer lands. */
function AnswerBurst() {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute top-1/2 left-1/2 z-raised size-24 rounded-full border-2 border-done"
      style={{ x: "-50%", y: "-50%" }}
      initial={{ scale: 0.3, opacity: 0.9 }}
      animate={{ scale: 4, opacity: 0 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
    />
  );
}

/**
 * Ctrl+J "answer next" overlay: cycles blocked agents oldest-first with their context.
 * 1–9 answer · Tab/J/K move · Enter opens the session · Esc closes.
 */
export function AnswerNextHud() {
  const open = useUi((s) => s.answerNextOpen);
  const setOpen = useUi((s) => s.setAnswerNext);
  const inbox = useInbox();
  const mobile = useIsMobile();
  const [picked, setPicked] = useState<string | null>(null);
  const [lastIdx, setLastIdx] = useState(0);
  const [dir, setDir] = useState<Dir>(1);
  const [answered, setAnswered] = useState(0);
  const [sent, setSent] = useState<{ key: string; label: string } | null>(null);
  // the agent on screen: the picked one while it still waits, else whoever took its place
  const cur = picked && inbox.includes(picked) ? picked : (inbox[Math.min(lastIdx, inbox.length - 1)] ?? null);
  const agent = useAgent(cur ?? "");
  // decided during render so the answered card exits upward on the very frame it leaves
  const flow: Dir = picked !== null && !inbox.includes(picked) ? 0 : dir;

  // opening: start at the board selection when it needs you, else the oldest; closing: reset
  useEffect(() => {
    if (!open) {
      setPicked(null);
      setSent(null);
      return;
    }
    const sel = useUi.getState().selectedKey;
    const start = sel && inbox.includes(sel) ? sel : (inbox[0] ?? null);
    setPicked(start);
    setLastIdx(start ? inbox.indexOf(start) : 0);
    setDir(1);
    setAnswered(0);
    // only on open/close
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // the picked agent was answered (left the inbox): count it, the next one slides up into place
  useEffect(() => {
    if (!open || !picked || inbox.includes(picked)) return;
    setDir(0);
    setAnswered((n) => n + 1);
    setPicked(cur);
  }, [open, picked, inbox, cur]);

  useEffect(() => {
    if (cur) setLastIdx(inbox.indexOf(cur));
  }, [cur, inbox]);

  // all clear: celebrate briefly, then close
  useEffect(() => {
    if (!open || inbox.length > 0) return;
    const t = window.setTimeout(() => setOpen(false), answered > 0 ? 1600 : 2600);
    return () => clearTimeout(t);
  }, [open, inbox.length, answered, setOpen]);

  const move = (d: 1 | -1) => {
    if (inbox.length < 2 || !cur) return;
    const i = inbox.indexOf(cur);
    setDir(d);
    setPicked(inbox[(i + d + inbox.length) % inbox.length] ?? null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "Tab" || k === "j" || k === "J" || k === "ArrowDown") move(e.shiftKey && k === "Tab" ? -1 : 1);
    else if (k === "k" || k === "K" || k === "ArrowUp") move(-1);
    else if (k === "Enter" && cur && !(e.target instanceof HTMLButtonElement)) {
      setOpen(false);
      openAgent(cur);
    } else if (/^[1-9]$/.test(k) && cur && agent?.needs) {
      const opt = agent.needs.options[Number(k) - 1];
      if (!opt || agent.needs.multi) return;
      const key = cur;
      setSent({ key, label: opt.label });
      void sendOption(key, agent.needs, opt.id).then((ok) => {
        if (!ok) setSent(null);
      });
    } else return;
    e.preventDefault();
  };

  const index = cur ? inbox.indexOf(cur) : -1;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        width={720}
        onKeyDown={onKeyDown}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // keep focus on the HUD itself so 1–9 / Enter act on the question, not the close button
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
        icon={
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M10 2.5 3.5 11H10l-1 6.5L16.5 9H10z" strokeLinejoin="round" />
          </svg>
        }
        title={
          <span className="flex items-baseline gap-2">
            Answer next
            {inbox.length > 0 && (
              <span className="text-md font-semibold text-mute tabular">
                <NumberTicker value={Math.max(1, index + 1)} /> of <NumberTicker value={inbox.length} />
              </span>
            )}
          </span>
        }
        description={mobile ? undefined : "Oldest question first. Answer with 1–9, Tab moves, Enter opens the session."}
        className={cn(mobile && "p-5")}
      >
        <div className="relative min-h-72 overflow-hidden">
          {answered > 0 && <AnswerBurst key={answered} />}
          <AnimatePresence mode="popLayout" custom={flow} initial={false}>
            {cur && agent?.needs ? (
              <motion.div
                key={cur}
                custom={flow}
                variants={slide}
                initial="enter"
                animate="center"
                exit="exit"
                transition={spring.smooth}
                className="flex flex-col gap-3.5"
              >
                <NeedsHeader agentKey={cur} />
                <LastAssistantText agentKey={cur} />
                <NeedsQuestion agentKey={cur} />
                {sent?.key === cur ? (
                  <motion.p initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={spring.bouncy} className="flex items-center gap-2 text-sm font-bold text-done">
                    <svg viewBox="0 0 12 12" className="size-4" aria-hidden>
                      <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Sent · {sent.label}
                  </motion.p>
                ) : (
                  <QuickAnswer agentKey={cur} appearance={mobile ? "big" : "card"} numbered={!mobile} mobile={mobile} />
                )}
              </motion.div>
            ) : (
              <motion.div
                key="clear"
                className="grid min-h-72 place-items-center text-center"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={spring.bouncy}
              >
                <div className="flex flex-col items-center gap-3">
                  <motion.span
                    data-status="done"
                    className="grid size-16 place-items-center rounded-full st-bg"
                    initial={{ rotate: -120, scale: 0.4 }}
                    animate={{ rotate: 0, scale: 1 }}
                    transition={spring.bouncy}
                  >
                    <svg viewBox="0 0 24 24" className="size-8" aria-hidden>
                      <path d="M5 12.5 10 17.5 19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </motion.span>
                  <p className="font-display text-2xl font-bold text-ink">All clear</p>
                  <p className="text-sm text-mute">{answered > 0 ? `${answered} answered — everyone is back to work.` : "Nobody is waiting on you."}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {!mobile && inbox.length > 0 && (
          <div className="mt-4 flex items-center gap-3 border-t border-line pt-3 text-2xs font-semibold text-mute-2">
            <span>
              <Kbd>1</Kbd>–<Kbd>9</Kbd> answer
            </span>
            <span>
              <Kbd>Tab</Kbd> <Kbd>J</Kbd> <Kbd>K</Kbd> move
            </span>
            <span>
              <Kbd>↵</Kbd> open session
            </span>
            <span className="ml-auto">
              <Kbd>Esc</Kbd> close
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
