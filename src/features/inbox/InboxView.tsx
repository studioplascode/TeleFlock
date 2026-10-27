import { motion } from "motion/react";
import { type ReactNode, useRef } from "react";
import { useInbox, useUi } from "@/core";
import { AnimatePresence, Button, CardFlight, EmptyState, FlightGroup, Kbd, PageHeader, StatusOrb, cn, fadeRise, useInView, useIsMobile } from "@/design";
import { openAgent, openAnswerHud, openTerminal } from "@/features/board/agentActions";
import { QuickAnswer } from "@/features/board/QuickAnswer";
import { UpdatesActions, UpdatesList, useUpdates } from "@/features/notify/NotificationCenter";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { ACTIONS, LANE_TITLE } from "@/features/shell/vocab";
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
        className={cn("card-surface st-border-grad flex flex-col rounded-xl", mobile ? "gap-3 p-3.5" : "gap-3.5 p-5")}
      >
        <NeedsHeader agentKey={agentKey} />
        <LastAssistantText agentKey={agentKey} enabled={visible} />
        <NeedsQuestion agentKey={agentKey} />
        <QuickAnswer agentKey={agentKey} appearance={mobile ? "big" : "card"} full numbered={!mobile} mobile={mobile} />
        <div className={cn("flex flex-wrap gap-1.5 border-t border-line", mobile ? "-mb-1 pt-2" : "pt-3")}>
          <Button size="sm" variant="ghost" onClick={() => openAgent(agentKey)}>
            {ACTIONS.openSession.label}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openTerminal(agentKey, mobile)}>
            {ACTIONS.terminal.label}
          </Button>
          {!mobile && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openAnswerHud(agentKey)} trailing={<Kbd>{ACTIONS.answerNext.shortcut}</Kbd>}>
              Answer in HUD
            </Button>
          )}
        </div>
      </article>
    </CardFlight>
  );
}

function SectionHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2.5 px-1">
      <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
      {meta && <span className="text-xs font-bold text-mute">{meta}</span>}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** Inbox: everything waiting on you (oldest first, full question context), then unread updates. */
export function InboxView() {
  const keys = useInbox();
  const updates = useUpdates();
  const mobile = useIsMobile();
  const setAnswerNext = useUi((s) => s.setAnswerNext);
  const subtitle = `${keys.length > 0 ? `${keys.length} waiting` : "Nothing waiting"} · ${updates.length > 0 ? `${updates.length} update${updates.length === 1 ? "" : "s"}` : "no updates"}`;

  const body = (
    <div className={cn("flex flex-col", mobile ? "gap-6" : "gap-8")}>
      <section aria-label={LANE_TITLE.needs} className={cn("flex flex-col", mobile ? "gap-3" : "gap-3.5")}>
        <SectionHeader title={LANE_TITLE.needs} meta={keys.length > 0 ? `${keys.length} · oldest first` : undefined} />
        <FlightGroup id="inbox" arrangement={keys.join(" ")}>
          <AnimatePresence mode="popLayout" initial={false}>
            {keys.map((k, i) => (
              <InboxItem key={k} agentKey={k} index={i} mobile={mobile} />
            ))}
          </AnimatePresence>
        </FlightGroup>
        {keys.length === 0 && (
          <motion.div {...fadeRise} className="card-surface rounded-xl">
            <EmptyState
              compact
              icon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-6 text-done" aria-hidden>
                  <path d="M4 13.5 9 18.5 20 6.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
              title="Nobody is waiting on you"
              description="Questions and approvals land here, oldest first."
            />
          </motion.div>
        )}
      </section>

      <section aria-label="Updates" className="flex flex-col gap-2">
        <SectionHeader title="Updates" meta={updates.length > 0 ? `${updates.length} unread · newest first` : undefined} actions={<UpdatesActions />} />
        <UpdatesList items={updates} className={cn("card-surface rounded-xl", mobile ? "p-1.5" : "p-2")} />
      </section>
    </div>
  );

  if (mobile) {
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader title="Inbox" subtitle={subtitle} />
        <div className="px-3 pt-1 pb-5">{body}</div>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-6 px-8 pt-7 pb-12">
      <PageHeader
        title="Inbox"
        meta={
          <>
            <StatusOrb status={keys.length > 0 ? "needs-you" : "done"} size={7} label={null} />
            {subtitle}
          </>
        }
        actions={
          keys.length > 0 && (
            <Button variant="sunset" size="sm" onClick={() => setAnswerNext(true)} trailing={<Kbd>{ACTIONS.answerNext.shortcut}</Kbd>}>
              {ACTIONS.answerNext.label}
            </Button>
          )
        }
      />
      {body}
    </div>
  );
}
