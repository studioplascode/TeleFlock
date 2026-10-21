import { motion } from "motion/react";
import { SquareTerminal } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { navigate, useHostState } from "@/core";
import type { Started } from "@/core/gen";
import { Button, Elapsed, Shimmer, cn, spring, tween } from "@/design";

/** Minimum time the success state is on screen before we fly into the session (ms). */
const SUCCESS_HOLD_MS = 1100;
/** After this long without the agent showing up in host state we offer the terminal (ms). */
const AGENT_WAIT_MS = 15000;

/** Indeterminate "it's working" panel: orbiting gradient ring, shimmering stage line, ticking timer. */
export function WorkingPanel({ label, detail, since }: { label: string; detail?: string; since: number }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center" role="status" aria-live="polite">
      <div className="relative grid size-24 place-items-center">
        <span className="tf-loop absolute inset-0 animate-spin rounded-full [background:conic-gradient(from_0deg,transparent_0%,#f053d0_30%,#a15eef_55%,#7fa2e7_75%,transparent_100%)] [mask:radial-gradient(farthest-side,transparent_calc(100%-3px),#000_calc(100%-2px))] [animation-duration:1.4s]" />
        <span className="tf-loop absolute inset-3 animate-spin rounded-full [background:conic-gradient(from_180deg,transparent,rgb(163_92_240/0.6),transparent_60%)] [mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-1px))] [animation-direction:reverse] [animation-duration:2.2s]" />
        <span className="tf-loop size-3 animate-breathe rounded-full bg-omp shadow-glow-accent" />
      </div>
      <div className="flex flex-col gap-1">
        <Shimmer className="font-display text-lg font-bold">{label}</Shimmer>
        {detail && <p className="max-w-sm font-mono text-2xs text-mute-2">{detail}</p>}
        <span className="text-2xs text-mute tabular">
          <Elapsed since={since} />
        </span>
      </div>
    </div>
  );
}

export interface LaunchSuccessProps {
  hostId: string;
  started: Started;
  /** Title from the real herdr agent name; `undefined` until the agent is in host state (show neutral text). */
  title: (agentName: string | undefined) => string;
  subtitle?: ReactNode;
  /** Close the dialog (called right before navigation). */
  onClose: () => void;
}

/**
 * Success state after a launch: a burst + check draws in, then — as soon as the new agent is in
 * host state — we close and navigate to its session. If it never shows up, the user gets the pane.
 */
export function LaunchSuccess({ hostId, started, title, subtitle, onClose }: LaunchSuccessProps) {
  const host = useHostState(hostId);
  const agent =
    (started.agentId ? host?.agents.find((a) => a.id === started.agentId) : undefined) ?? host?.agents.find((a) => a.paneId === started.paneId);
  const agentId = agent?.id;
  const [held, setHeld] = useState(false);
  const [late, setLate] = useState(false);

  useEffect(() => {
    const t1 = window.setTimeout(() => setHeld(true), SUCCESS_HOLD_MS);
    const t2 = window.setTimeout(() => setLate(true), AGENT_WAIT_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  useEffect(() => {
    if (!held || !agentId) return;
    onClose();
    navigate({ name: "agent", hostId, agentId });
  }, [held, agentId, hostId, onClose]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-6 text-center" role="status" aria-live="polite">
      <div className="relative grid size-28 place-items-center">
        <motion.span
          className="absolute -inset-10 rounded-full bg-[radial-gradient(closest-side,rgb(163_92_240/0.45),rgb(240_83_208/0.12)_55%,transparent)]"
          initial={{ scale: 0.2, opacity: 0 }}
          animate={{ scale: [0.2, 1.15, 1], opacity: [0, 1, 0.55] }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          aria-hidden
        />
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute inset-0 rounded-full shadow-[inset_0_0_0_2px_rgb(163_92_240/0.8)]"
            initial={{ scale: 0.4, opacity: 0.9 }}
            animate={{ scale: 1.6 + i * 0.25, opacity: 0 }}
            transition={{ ...tween.slow, duration: 1.1, delay: 0.08 * i }}
            aria-hidden
          />
        ))}
        {Array.from({ length: 10 }, (_, i) => {
          const a = (i / 10) * Math.PI * 2;
          return (
            <motion.span
              key={`s${i}`}
              className={cn("absolute size-1.5 rounded-full", i % 2 ? "bg-omp-pink" : "bg-omp-blue")}
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{ x: Math.cos(a) * 64, y: Math.sin(a) * 64, opacity: 0, scale: 0.4 }}
              transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
              aria-hidden
            />
          );
        })}
        <motion.div
          className="grid size-20 place-items-center rounded-full bg-omp shadow-glow-accent"
          initial={{ scale: 0.3, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={spring.bouncy}
        >
          <svg viewBox="0 0 24 24" className="size-10 text-white" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, delay: 0.25, ease: "easeOut" }} />
          </svg>
        </motion.div>
      </div>
      <motion.div className="flex w-full min-w-0 flex-col gap-1" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.smooth, delay: 0.2 }}>
        <p className="font-display text-2xl font-bold">{title(agent?.name)}</p>
        {subtitle && <div className="mx-auto flex max-w-full min-w-0 flex-col gap-0.5 font-mono text-xs text-mute">{subtitle}</div>}
      </motion.div>
      {!late || agentId ? (
        <div className="flex w-56 flex-col items-center gap-2">
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/8">
            <motion.div
              className="h-full rounded-full bg-omp"
              initial={{ width: "0%" }}
              animate={{ width: agentId ? "100%" : "82%" }}
              transition={agentId ? spring.smooth : { duration: SUCCESS_HOLD_MS / 1000 + 2, ease: [0.2, 0.8, 0.2, 1] }}
            />
          </div>
          <Shimmer className="text-xs font-semibold">{agentId ? "Opening session…" : "Waiting for the agent to come online…"}</Shimmer>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-mute">The pane is up, but herdr hasn't reported the agent yet.</p>
          <Button
            icon={<SquareTerminal />}
            onClick={() => {
              onClose();
              navigate({ name: "terminal", hostId, paneId: started.paneId });
            }}
          >
            Open the pane's terminal
          </Button>
        </div>
      )}
    </div>
  );
}
