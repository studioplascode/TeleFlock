import { motion } from "motion/react";
import { useRef } from "react";
import { useInbox, useUi } from "@/core";
import { AnimatePresence, Button, CardFlight, EmptyState, Kbd, LayoutGroup, cn, fadeRise, useInView, useIsMobile } from "@/design";
import { openAgent, openAnswerHud, openTerminal } from "@/features/board/agentActions";
import { QuickAnswer } from "@/features/board/QuickAnswer";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { LastAssistantText, NeedsHeader, NeedsQuestion } from "./NeedsContext";

function InboxItem({ agentKey, index, mobile }: { agentKey: string; index: number; mobile: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref, "200px");
  return (
    <CardFlight flightId={agentKey} {...fadeRise}>
      <article
        ref={ref}
        data-status="needs-you"
        aria-label={`Waiting ${index + 1}`}
        className={cn("card-surface st-border-grad flex flex-col gap-3.5 rounded-xl", mobile ? "p-4" : "p-5")}
      >
        <NeedsHeader agentKey={agentKey} />
        <LastAssistantText agentKey={agentKey} enabled={visible} />
        <NeedsQuestion agentKey={agentKey} />
        <QuickAnswer agentKey={agentKey} appearance={mobile ? "big" : "card"} mobile={mobile} />
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
          <Button size="sm" variant="ghost" onClick={() => openAgent(agentKey)}>
            Open session
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openTerminal(agentKey, mobile)}>
            Terminal
          </Button>
          {!mobile && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openAnswerHud(agentKey)} trailing={<Kbd>Ctrl J</Kbd>}>
              Answer in HUD
            </Button>
          )}
        </div>
      </article>
    </CardFlight>
  );
}

/** Everything waiting on you, oldest first, with full question context. */
export function InboxView() {
  const keys = useInbox();
  const mobile = useIsMobile();
  const setAnswerNext = useUi((s) => s.setAnswerNext);
  const body = (
    <LayoutGroup id="inbox">
      <div className="flex flex-col gap-3.5">
        <AnimatePresence mode="popLayout" initial={false}>
          {keys.map((k, i) => (
            <InboxItem key={k} agentKey={k} index={i} mobile={mobile} />
          ))}
        </AnimatePresence>
        {keys.length === 0 && (
          <motion.div {...fadeRise}>
            <EmptyState
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-8 text-done" aria-hidden>
                  <path d="M4 13.5 9 18.5 20 6.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
              title="Inbox zero"
              description="No agent is waiting on you. New questions and approvals appear here, oldest first."
            />
          </motion.div>
        )}
      </div>
    </LayoutGroup>
  );

  if (mobile) {
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Inbox" subtitle={keys.length > 0 ? `${keys.length} waiting · oldest first` : "All clear"} />
        <div className="px-4 pt-2 pb-6">{body}</div>
      </div>
    );
  }
  return (
    <div>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
        <header className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold text-ink">Inbox</h1>
          <span className="text-sm font-semibold text-mute">{keys.length > 0 ? `${keys.length} waiting · oldest first` : "All clear"}</span>
          {keys.length > 0 && (
            <Button variant="sunset" size="sm" className="ml-auto" onClick={() => setAnswerNext(true)} trailing={<Kbd>Ctrl J</Kbd>}>
              Answer next
            </Button>
          )}
        </header>
        {body}
      </div>
    </div>
  );
}
