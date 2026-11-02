import { ArrowUpRight, Check, CheckCheck, PenLine, Send } from "lucide-react";
import { motion } from "motion/react";
import { type KeyboardEvent, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { agentKey, useCore, useHosts } from "@/core";
import type { Agent } from "@/core/gen";
import { AgentGlyph, AnimatePresence, Badge, BottomSheet, Button, cn, formatAge, Input, useNow } from "@/design";
import { openAgent } from "@/features/board/agentActions";
import { openPastSessions } from "@/features/history/PastSessionsDialog";
import { HostBadge } from "@/features/hosts/HostBadge";
import { SectionHeader } from "@/features/inbox/SectionHeader";
import { Ticks } from "@/features/shell/Ticks";
import { changeDecisionAnswer, reviewDecisions, useDecisionPending } from "./actions";
import { useDecisions } from "./hooks";
import {
  type AnswerChoice,
  changeAnswerMessage,
  changeBlock,
  changeBlockText,
  choiceChanged,
  decisionAgent,
  decisionKey,
  decisionMeta,
  decisionQuestion,
  type HostDecision,
  otherOptions,
  pickedText,
  sentChoice,
} from "./review";
import { useDecisionFocus } from "./reviewFocus";

/*
 * The Inbox's "Decided for you" (architecture §3.23 "Review"): the questions decide for me answered
 * that nobody reviewed yet, oldest first, between Needs you and Updates while there are any. Each
 * row says what was asked, what was sent and what was not, when, after how long a wait and by whose
 * setting; Looks good marks it reviewed on every device, Open shows the conversation, Change answer
 * tells a live agent to go another way.
 */

const NO_AGENTS: readonly Agent[] = [];
/** How long a notification's row stays highlighted once it was brought into view. */
const FLASH_MS = 2400;
/** A focus that waited this long for its host to connect is dropped (no jump much later). */
const FOCUS_TTL_MS = 60_000;

/**
 * Opening a "decided for you" notification: bring its row into view, highlight and focus it, or the
 * section when none has it (reviewed elsewhere). Waits for the host's state while it is not online.
 */
function useFocusedDecision(decisions: readonly HostDecision[], section: RefObject<HTMLElement | null>): void {
  const focus = useDecisionFocus((s) => s.focus);
  const online = useHosts((s) => (focus ? s.status[focus.hostId]?.phase === "online" : false));
  useEffect(() => {
    if (!focus) return;
    const hit = focus.notificationId ? decisions.find((d) => d.hostId === focus.hostId && d.notificationId === focus.notificationId) : undefined;
    if (!hit && !online && Date.now() - focus.at < FOCUS_TTL_MS) return;
    const key = hit ? decisionKey(hit) : null;
    useDecisionFocus.setState({ focus: null, flash: key });
    const el = key ? document.querySelector<HTMLElement>(`[data-decision="${CSS.escape(key)}"]`) : section.current;
    el?.scrollIntoView({ block: key ? "center" : "start", behavior: "smooth" });
    if (key) el?.focus({ preventScroll: true });
  }, [focus, decisions, online, section]);
  const flash = useDecisionFocus((s) => s.flash);
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => useDecisionFocus.setState({ flash: null }), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flash]);
}

/** "Decided for you": nothing while every decision is reviewed (or the hosts are older than 0.9.0). */
export function DecidedSection({ mobile }: { mobile: boolean }) {
  const decisions = useDecisions();
  const ref = useRef<HTMLElement>(null);
  useFocusedDecision(decisions, ref);
  const flash = useDecisionFocus((s) => s.flash);
  const [marking, setMarking] = useState(false);
  if (decisions.length === 0) return null;
  const markAll = () => {
    setMarking(true);
    void reviewDecisions(decisions).finally(() => setMarking(false));
  };
  return (
    <section ref={ref} aria-label="Decided for you" className={cn("flex scroll-mt-4 flex-col max-md:scroll-mt-16", mobile ? "gap-3" : "gap-3.5")}>
      <SectionHeader
        title="Decided for you"
        meta={`${decisions.length} · oldest first`}
        actions={
          <Button size="sm" variant="ghost" icon={<CheckCheck />} loading={marking} onClick={markAll} aria-label={`Mark all ${decisions.length} reviewed`}>
            {mobile ? "All reviewed" : "Mark all reviewed"}
          </Button>
        }
      />
      <div className="flex flex-col gap-2.5">
        <AnimatePresence mode="popLayout" initial={false}>
          {decisions.map((d, i) => (
            <DecisionRow key={decisionKey(d)} d={d} index={i} mobile={mobile} flash={flash === decisionKey(d)} />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function DecisionRow({ d, index, mobile, flash }: { d: HostDecision; index: number; mobile: boolean; flash: boolean }) {
  const now = useNow(30_000);
  const agent = useCore((s) => decisionAgent(d, s.hosts[d.hostId]?.state.agents ?? NO_AGENTS));
  const online = useHosts((s) => s.status[d.hostId]?.phase === "online");
  const hostName = useHosts((s) => s.profiles.find((p) => p.id === d.hostId)?.name ?? d.hostId);
  const pending = useDecisionPending(d);
  const [changing, setChanging] = useState(false);
  const reasonId = useId();
  const name = agent?.name ?? d.agentName;
  const ended = !agent || !!agent.parked;
  const block = changeBlock(agent, online);
  const { title, question } = decisionQuestion(d);
  const others = otherOptions(d);
  const open = () => {
    if (agent) openAgent(agentKey(d.hostId, agent.id));
    else openPastSessions({ hostId: d.hostId, cwd: d.cwd, file: d.sessionFile });
  };
  return (
    <motion.article
      layout="position"
      data-decision={decisionKey(d)}
      tabIndex={-1}
      aria-label={`Decided for you ${index + 1}: ${name}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
      className={cn("card-surface relative flex flex-col rounded-xl outline-none", mobile ? "gap-2 p-3" : "gap-2.5 p-4")}
    >
      {flash && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl bg-accent/8 shadow-[inset_0_0_0_2px_var(--color-accent)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: FLASH_MS / 1000, times: [0, 0.12, 0.7, 1] }}
        />
      )}
      <div className="flex min-w-0 items-center gap-2.5">
        <AgentGlyph name={name} size={mobile ? 24 : 28} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-extrabold text-ink">{name}</span>
          {ended && <Badge>Ended</Badge>}
          <HostBadge hostId={d.hostId} className="max-w-[40%]" />
        </div>
        <time dateTime={new Date(d.at).toISOString()} title={new Date(d.at).toLocaleString()} className="shrink-0 font-mono text-2xs text-mute-2">
          {formatAge(now - d.at)}
        </time>
      </div>
      <div className="flex flex-col gap-0.5">
        {title && <p className="text-2xs font-bold text-mute">{title}</p>}
        <p className="line-clamp-4 text-sm font-bold break-words whitespace-pre-wrap text-ink">
          <Ticks text={question} className="text-[0.88em]" />
        </p>
      </div>
      <p className="flex items-start gap-1.5 text-sm">
        <Check className="mt-0.5 size-4 shrink-0 text-done" aria-hidden />
        <span className="min-w-0 break-words">
          <span className="text-mute">{d.earlier ? "Sent " : "Picked "}</span>
          <span className="font-bold text-ink">{pickedText(d)}</span>
        </span>
      </p>
      {others.length > 0 && (
        <p className="pl-5.5 text-xs break-words text-mute">
          Not picked: {others.map((o) => `${o.recommended ? "★ " : ""}${o.label}`).join(" · ")}
        </p>
      )}
      <p className="pl-5.5 text-2xs font-semibold text-mute-2">{decisionMeta(d)}</p>
      <div className={cn("flex flex-wrap items-center gap-1.5 border-t border-line", mobile ? "-mb-1 pt-2" : "pt-2.5")}>
        <Button size="sm" variant="secondary" icon={<Check />} loading={pending && !changing} disabled={pending} onClick={() => void reviewDecisions([d])}>
          Looks good
        </Button>
        <Button size="sm" variant="ghost" icon={<ArrowUpRight />} onClick={open} aria-label={agent ? `Open ${name}'s session` : `Open ${name}'s past session`}>
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<PenLine />}
          aria-disabled={block !== null || pending || undefined}
          aria-describedby={block ? reasonId : undefined}
          aria-expanded={block ? undefined : changing}
          onClick={() => block === null && !pending && setChanging((c) => !c)}
        >
          Change answer
        </Button>
        {block && (
          <span id={reasonId} className="text-2xs font-semibold text-mute-2">
            {changeBlockText(block, name, hostName)}
          </span>
        )}
      </div>
      {agent && block === null && (changing || mobile) && <ChangeAnswer d={d} agent={agent} mobile={mobile} open={changing} onClose={() => setChanging(false)} />}
    </motion.article>
  );
}

/**
 * Change answer: the question's options (radio for one, checkboxes for several) and an "Other"
 * field, starting from what was sent; Send stays off until the choice differs from it. Inline on
 * a computer, a bottom sheet on phones. Send tells the agent (`changeDecisionAnswer`), then marks
 * the decision reviewed.
 */
function ChangeAnswer({ d, agent, mobile, open, onClose }: { d: HostDecision; agent: Pick<Agent, "id" | "name">; mobile: boolean; open: boolean; onClose: () => void }) {
  const sent = useMemo(() => sentChoice(d), [d]);
  const [labels, setLabels] = useState<string[]>(sent.labels);
  const [other, setOther] = useState(sent.text ?? "");
  const [otherOn, setOtherOn] = useState(!d.multi && sent.labels.length === 0 && !!sent.text);
  const pending = useDecisionPending(d);
  const group = useId();
  const otherRef = useRef<HTMLInputElement>(null);
  const choice: AnswerChoice = d.multi ? { labels, text: other } : otherOn ? { labels: [], text: other } : { labels: labels.slice(0, 1) };
  const changed = choiceChanged(d, choice);
  const send = () => {
    if (changed && !pending) void changeDecisionAnswer(d, agent, choice).then((ok) => ok && onClose());
  };
  const pick = (label: string, on: boolean) => {
    setOtherOn(false);
    if (!d.multi) setLabels([label]);
    else setLabels(d.options.map((o) => o.label).filter((l) => (l === label ? on : labels.includes(l))));
  };
  const row = (on: boolean) => cn("flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors", on ? "bg-accent/14 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]" : "hover:bg-ink/5");
  const input = "focus-ring mt-0.5 size-4 shrink-0 accent-accent";

  const fields = (
    <fieldset disabled={pending} className="flex min-w-0 flex-col gap-1">
      <legend className="sr-only">{d.multi ? `Pick what ${agent.name} should go with` : `Pick what ${agent.name} should go with instead`}</legend>
      {d.options.map((o, i) => {
        const on = d.multi ? labels.includes(o.label) : !otherOn && labels[0] === o.label;
        return (
          <label key={i} className={row(on)}>
            <input type={d.multi ? "checkbox" : "radio"} name={group} checked={on} onChange={(e) => pick(o.label, e.target.checked)} className={input} />
            <span className="min-w-0 flex-1 text-sm font-semibold break-words text-ink">
              {o.label}
              {o.recommended && (
                <span className="ml-1.5 text-xs font-extrabold whitespace-nowrap text-sun-ink">
                  <span aria-hidden>★ </span>recommended
                </span>
              )}
              {o.picked && <span className="ml-1.5 text-xs font-bold whitespace-nowrap text-mute">· sent</span>}
            </span>
          </label>
        );
      })}
      {!d.multi && (
        <label className={row(otherOn)}>
          <input
            type="radio"
            name={group}
            checked={otherOn}
            onChange={() => {
              setOtherOn(true);
              otherRef.current?.focus();
            }}
            className={input}
          />
          <span className="text-sm font-semibold text-ink">Other</span>
        </label>
      )}
      <Input
        ref={otherRef}
        value={other}
        onChange={(e) => {
          setOther(e.target.value);
          if (!d.multi) setOtherOn(e.target.value.trim() !== "" || otherOn);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={d.multi ? "Other (optional): anything to add" : "Other: type your own answer"}
        aria-label="Other answer"
        boxClassName={cn("mt-1", mobile ? "h-11" : "h-9")}
      />
    </fieldset>
  );
  const preview = changed && (
    <p className="text-2xs break-words text-mute-2">
      Sends {agent.name}: <span className="text-mute">{changeAnswerMessage(d, choice)}</span>
    </p>
  );
  const sendButton = (
    <Button variant="primary" size={mobile ? "md" : "sm"} icon={<Send />} loading={pending} disabled={!changed} onClick={send} className={mobile ? "flex-[2]" : undefined}>
      Send
    </Button>
  );
  const cancel = (
    <Button variant="ghost" size={mobile ? "md" : "sm"} disabled={pending} onClick={onClose} className={mobile ? "flex-1" : undefined}>
      Cancel
    </Button>
  );

  if (mobile) {
    return (
      <BottomSheet
        open={open}
        onOpenChange={(o) => !o && !pending && onClose()}
        title={`Change ${agent.name}'s answer`}
        description={d.question}
        autoFocus={false}
        footer={
          <div className="flex w-full gap-2">
            {cancel}
            {sendButton}
          </div>
        }
      >
        <div className="flex flex-col gap-3 pb-1">
          {fields}
          {preview}
        </div>
      </BottomSheet>
    );
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || pending) return;
    e.stopPropagation();
    onClose();
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={`Change ${agent.name}'s answer`}
      className="flex flex-col gap-2.5 rounded-lg well p-2.5"
    >
      {fields}
      {preview}
      <div className="flex items-center justify-end gap-1.5">
        {cancel}
        {sendButton}
      </div>
    </motion.div>
  );
}
