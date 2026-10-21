import { Bot } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { navigate, openSession, parseAgentKey, useAgent, useSession, useUi } from "@/core";
import { Button, cn, EmptyState, spring } from "@/design";
import { hostCall } from "./api";
import { AskCard } from "./ask/AskCard";
import { Composer } from "./composer/Composer";
import { SessionCtx } from "./context";
import { SessionDialogs } from "./header/Dialogs";
import { FocusHeader } from "./header/FocusHeader";
import { SessionHeader } from "./header/SessionHeader";
import { LinkGate } from "./LinkGate";
import { NonOmpView } from "./NonOmpView";
import { SubagentViewer } from "./subagents/SubagentViewer";
import { Transcript, TRANSCRIPT_MAX_WIDTH, TranscriptSkeleton } from "./transcript/Transcript";

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

/** Keeps the session subscribed while mounted; `retry` re-acquires it (reload after an error). */
export function useOpenSession(agentKey: string): () => void {
  const [nonce, setNonce] = useState(0);
  useEffect(() => openSession(agentKey), [agentKey, nonce]);
  return () => setNonce((n) => n + 1);
}

export interface SessionPaneProps {
  agentKey: string;
  /** Split view: compact header, no global hotkeys. */
  compact?: boolean;
  /** Hide the header (mobile renders its own top bar). */
  header?: boolean;
  /** Phone layout for the composer and ask card. */
  mobile?: boolean;
  /** Focus mode: minimal header, frameless transcript, floating composer. */
  focus?: boolean;
  /**
   * False renders a skeleton in place of the transcript (the session still subscribes), so the
   * phone can mount the rows after its slide-in. Default true.
   */
  ready?: boolean;
  className?: string;
}

/**
 * One session: header, virtualised transcript, sticky ask card and composer. Used by the
 * desktop SessionView, the mobile pager and the split view.
 */
export function SessionPane({ agentKey, compact = false, header = true, mobile = false, focus = false, ready = true, className }: SessionPaneProps) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const retry = useOpenSession(agentKey);
  const hotkeys = !compact;
  const stoppable = agent?.column === "running" && agent.omp?.link === "live";

  // Esc anywhere in the focused session (outside inputs and overlays) stops the turn.
  useEffect(() => {
    if (!hotkeys || !stoppable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isEditable(e.target)) return;
      // In focus mode Esc leaves focus (SessionView); the composer's Esc still stops the turn.
      if (useUi.getState().focusMode) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [cmdk-root]')) return;
      e.preventDefault();
      void hostCall(hostId, "agent.abort", { agentId }, { failure: "Stop failed" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys, stoppable, hostId, agentId]);

  if (!agent)
    return (
      <EmptyState
        className="flex-1"
        icon={<Bot />}
        title="Agent not found"
        description="It may have exited, or its host isn't connected."
        action={<Button onClick={() => navigate({ name: "board" })}>Back to board</Button>}
      />
    );

  return (
    <SessionCtx.Provider value={{ hostId, agentId, key: agentKey }}>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", mobile || compact ? "gap-2" : "gap-3", compact && "p-2", className)}>
        {agent.omp == null ? (
          <NonOmpView agentKey={agentKey} />
        ) : (
          <>
            {header && (focus ? <FocusHeader agentKey={agentKey} /> : <SessionHeader agentKey={agentKey} compact={compact} />)}
            <LinkGate agentKey={agentKey} onRetry={retry}>
              <SessionBody agentKey={agentKey} hotkeys={hotkeys} mobile={mobile} compact={compact} focus={focus} ready={ready} />
            </LinkGate>
          </>
        )}
      </div>
    </SessionCtx.Provider>
  );
}

function SessionBody({ agentKey, hotkeys, mobile, compact, focus, ready }: { agentKey: string; hotkeys: boolean; mobile: boolean; compact: boolean; focus: boolean; ready: boolean }) {
  const { ui } = useSession(agentKey);
  return (
    <>
      {/* desktop: a short window keeps a strip of transcript beside an ask card (the card scrolls instead) */}
      <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", !mobile && !focus && "rounded-tile glass", !mobile && "min-h-24")}>
        {ready ? (
          <Transcript agentKey={agentKey} padX={mobile ? 10 : focus ? 8 : compact ? 14 : 22} gutter={mobile ? 0 : 38} overscan={mobile ? 3 : 8} dense={mobile} />
        ) : (
          <div className="px-3" aria-busy>
            <TranscriptSkeleton />
          </div>
        )}
      </div>
      <AnimatePresence mode="popLayout">
        {ui && (
          <motion.div
            key={ui.id}
            initial={{ opacity: 0, y: 40, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: spring.bouncy }}
            exit={{ opacity: 0, y: 24, scale: 0.97, transition: { duration: 0.2 } }}
            className={cn("relative z-raised mx-auto flex max-h-[62%] w-full flex-col", mobile ? "shrink-0" : "min-h-0 shrink")}
            style={{ maxWidth: TRANSCRIPT_MAX_WIDTH }}
          >
            {/* Sunset bloom: flares as the card lands, then settles into a glow spilling over the transcript. */}
            <motion.span
              aria-hidden
              className="pointer-events-none absolute -inset-x-4 -top-20 bottom-1/2 -z-10 rounded-[64px] bg-[radial-gradient(55%_60%_at_50%_42%,rgb(255_61_119/0.8),rgb(255_122_24/0.35)_55%,transparent_80%)] blur-2xl"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: [0, 1, 0.7], scale: [0.6, 1.1, 1] }}
              transition={{ duration: 1.6, times: [0, 0.3, 1], ease: "easeOut" }}
            />
            <div className="min-h-0 overflow-y-auto rounded-tile">
              <AskCard agentKey={agentKey} request={ui} hotkeys={hotkeys} compact={mobile || compact} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className={cn("mx-auto w-full", focus && "rounded-[24px] shadow-[0_24px_60px_-16px_rgb(0_0_0/0.75),0_0_40px_-12px_rgb(163_92_240/0.35)]")} style={{ maxWidth: TRANSCRIPT_MAX_WIDTH }}>
        <Composer agentKey={agentKey} mobile={mobile} autoFocus={!mobile && !compact} />
      </div>
      <SessionDialogs agentKey={agentKey} />
      <SubagentViewer agentKey={agentKey} />
    </>
  );
}
