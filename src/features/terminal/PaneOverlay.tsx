import { AnimatePresence, motion } from "motion/react";
import { CloudOff, Eye, PlugZap, RotateCcw, Unplug, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnStatus, HerdrHealth, TermMode } from "@/core/gen";
import { Button, Shimmer, Skeleton, Spinner, cn, spring, tween, useNow } from "@/design";
import { HerdrStatusText, RestartHerdrButton } from "@/features/hosts/HerdrControls";
import { herdrDown, herdrNotRunning, isHerdrDownError } from "@/features/hosts/herdrHealth";
import { PHASE_LABEL, phaseBusy } from "@/features/shell/status";
import type { TermPhase } from "./session";

export interface PaneOverlayProps {
  phase: TermPhase;
  compact: boolean;
  mode: TermMode;
  offline: boolean;
  conn: ConnStatus | undefined;
  /** The host's herdr health, when its server is not up the terminal says so instead of a raw attach error. */
  herdr?: HerdrHealth;
  hostId: string;
  hostName: string;
  gotFrame: boolean;
  onReattach(): void;
  onTakeover(): void;
  /** Switch the pane to read-only observing (offered when another client holds the input lease). */
  onObserve?: () => void;
}

/** Human copy for herdr's `terminal.closed` reasons. */
export function closedCopy(reason: string, takenOver: boolean): { title: string; detail: string } {
  if (takenOver) return { title: "Taken over", detail: "Another client took control of this terminal." };
  if (/^detached$/i.test(reason)) return { title: "Detached", detail: "The terminal session was released." };
  if (/exit|exited|gone|closed/i.test(reason)) return { title: "Pane closed", detail: reason };
  return { title: "Terminal closed", detail: reason || "The host ended this terminal session." };
}

const SKELETON_ROWS = ["w-[46%]", "w-[72%]", "w-[58%]", "w-[83%]", "w-[38%]", "w-[64%]"];

function RetryIn({ at }: { at: number }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return <>{s > 0 ? `retrying in ${s}s` : "retrying…"}</>;
}

/** Attach / reconnect / closed / error states drawn over the terminal grid. */
export function PaneOverlay({ phase, compact, mode, offline, conn, herdr, hostId, hostName, gotFrame, onReattach, onTakeover, onObserve }: PaneOverlayProps) {
  // herdr's server is not there: the pane can't attach whatever the transport says. It reattaches by itself when herdr is up again.
  // (a server that is only not answering leaves an attached pane alone: its process keeps streaming)
  const herdrGone = !offline && ((herdrDown(herdr) && !(herdr.state === "unresponsive" && phase.k === "live")) || (phase.k === "error" && isHerdrDownError(phase.error)));
  const attaching = !offline && !gotFrame && (phase.k === "idle" || phase.k === "opening" || phase.k === "live");
  const reattaching = !offline && gotFrame && phase.k === "opening";

  let view: { key: string; node: ReactNode } | null = null;

  if (offline) {
    const reconnecting = phaseBusy(conn?.phase);
    view = {
      key: "offline",
      node: (
        <>
          {/* stale screen: a slow shimmer sweeps it while a reconnect is in flight */}
          {reconnecting && <div aria-hidden className="tf-skeleton tf-loop pointer-events-none absolute inset-0 bg-transparent" />}
          {compact ? (
            <CompactNote icon={<CloudOff />} text={conn ? PHASE_LABEL[conn.phase] : "Host offline"} />
          ) : (
            <Banner
              tone="warn"
              icon={reconnecting ? <Spinner size={16} label="Reconnecting" /> : <CloudOff />}
              title={conn ? `${PHASE_LABEL[conn.phase]} · terminal paused` : "Host offline · terminal paused"}
            >
              {conn?.message && <span className="block">{conn.message}</span>}
              {conn?.nextRetryAt && !conn.message && (
                <span className="block">
                  <RetryIn at={conn.nextRetryAt} />
                </span>
              )}
              <span className="block text-mute-2">The terminal reattaches automatically when the host is back.</span>
            </Banner>
          )}
        </>
      ),
    };
  } else if (herdrGone) {
    const title = herdrNotRunning(hostName, herdr);
    view = {
      key: "herdr-down",
      node: compact ? (
        <CompactNote icon={<PlugZap />} text={title} onRetry={onReattach} />
      ) : (
        <Banner
          tone="warn"
          icon={herdr && (herdr.state === "starting" || herdr.state === "restarting") ? <Spinner size={16} label="Starting herdr" /> : <PlugZap />}
          title={title}
          actions={
            <>
              {herdr && <RestartHerdrButton hostId={hostId} health={herdr} />}
              <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={onReattach}>
                Retry
              </Button>
            </>
          }
        >
          {herdr ? <HerdrStatusText health={herdr} className="block" /> : <span className="block">TeleFlock can't reach herdr's server on {hostName}.</span>}
          <span className="block text-mute-2">The terminal reattaches by itself when herdr runs again.</span>
        </Banner>
      ),
    };
  } else if (phase.k === "closed") {
    const copy = closedCopy(phase.reason, phase.takenOver);
    view = {
      key: `closed-${phase.reason}`,
      node: compact ? (
        <CompactNote icon={<Unplug />} text={copy.title} onRetry={onReattach} />
      ) : (
        <Banner
          tone={phase.takenOver ? "sun" : "neutral"}
          icon={<Unplug />}
          title={copy.title}
          actions={
            <>
              <Button size="sm" variant={phase.takenOver ? "secondary" : "primary"} icon={<RotateCcw />} onClick={onReattach}>
                Reattach
              </Button>
              {mode === "control" && (
                <Button size="sm" variant={phase.takenOver ? "sunset" : "secondary"} icon={<Zap />} onClick={onTakeover}>
                  Take over
                </Button>
              )}
              {phase.takenOver && mode === "control" && onObserve && (
                <Button size="sm" variant="ghost" icon={<Eye />} onClick={onObserve}>
                  Watch
                </Button>
              )}
            </>
          }
        >
          {copy.detail}
        </Banner>
      ),
    };
  } else if (phase.k === "error") {
    const busy = phase.error.code === "busy";
    view = {
      key: `error-${phase.error.code}`,
      node: compact ? (
        <CompactNote icon={<PlugZap />} text={busy ? "In use elsewhere" : "Can't attach"} onRetry={onReattach} />
      ) : (
        <Banner
          tone={busy ? "sun" : "error"}
          icon={<PlugZap />}
          title={busy ? "Another client is driving this terminal" : "Couldn't attach"}
          actions={
            <>
              {busy && mode === "control" && (
                <Button size="sm" variant="sunset" icon={<Zap />} onClick={onTakeover}>
                  Take over
                </Button>
              )}
              {busy && mode === "control" && onObserve && (
                <Button size="sm" variant="secondary" icon={<Eye />} onClick={onObserve}>
                  Watch
                </Button>
              )}
              <Button size="sm" variant={busy ? "ghost" : "primary"} icon={<RotateCcw />} onClick={onReattach}>
                Retry
              </Button>
            </>
          }
        >
          {busy ? "Take over to type and resize from here, or watch read-only." : phase.error.message}
          {phase.error.hint && !busy && <span className="mt-1 block text-mute-2">{phase.error.hint}</span>}
        </Banner>
      ),
    };
  } else if (attaching) {
    const label = phase.k === "opening" && phase.takeover ? "Taking over" : phase.k === "live" ? "Attached, waiting for output" : "Attaching";
    view = {
      key: "attaching",
      node: (
        <motion.div
          className={cn("absolute inset-0 flex flex-col", compact ? "gap-1 p-2" : "gap-2.5 p-4")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: tween.base }}
          role="status"
          aria-label={`${label}…`}
        >
          {SKELETON_ROWS.slice(0, compact ? 4 : 6).map((w, i) => (
            <motion.div key={w} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring.smooth, delay: i * 0.05 }}>
              <Skeleton className={cn(w, compact ? "h-1.5" : "h-3")} />
            </motion.div>
          ))}
          {!compact && (
            <div className="mt-2 flex items-center gap-2 text-xs font-bold text-mute">
              <Spinner size={14} label={label} />
              <Shimmer>{label}…</Shimmer>
            </div>
          )}
        </motion.div>
      ),
    };
  } else if (reattaching && !compact) {
    view = {
      key: "reattaching",
      node: <Banner tone="neutral" icon={<Spinner size={16} />} title={phase.k === "opening" && phase.takeover ? "Taking over…" : "Reattaching…"} />,
    };
  }

  return <AnimatePresence mode="wait">{view && <motion.div key={view.key}>{view.node}</motion.div>}</AnimatePresence>;
}

const TONE = {
  neutral: "shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)] [&_.ov-icon]:text-accent-hi",
  warn: "shadow-[var(--shadow-d3),inset_0_0_0_1px_rgb(251_191_36/0.35)] [&_.ov-icon]:text-warn",
  sun: "shadow-[var(--shadow-d3),var(--shadow-glow-sun),inset_0_0_0_1px_rgb(255_61_119/0.45)] [&_.ov-icon]:text-sun-2",
  error: "shadow-[var(--shadow-d3),var(--shadow-glow-error),inset_0_0_0_1px_rgb(255_77_94/0.45)] [&_.ov-icon]:text-error",
} as const;

function Banner({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: keyof typeof TONE;
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: -14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98, transition: tween.fast }}
      transition={spring.bouncy}
      className={cn(
        "absolute inset-x-3 top-10 z-raised mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-[linear-gradient(180deg,rgb(34_34_46/0.96),rgb(25_25_33/0.96))] p-3 pr-3.5 backdrop-blur-xl",
        TONE[tone],
      )}
    >
      <span className="ov-icon grid size-8 shrink-0 place-items-center rounded-md bg-white/6 [&_svg]:size-4">{icon}</span>
      {/* min width keeps the copy readable: on narrow panes the actions wrap to their own row */}
      <div className="min-w-48 flex-1">
        <div className="text-sm font-extrabold text-ink">{title}</div>
        {children && <div className="text-xs text-mute">{children}</div>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap justify-end gap-2">{actions}</div>}
    </motion.div>
  );
}

function CompactNote({ icon, text, onRetry }: { icon: ReactNode; text: string; onRetry?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={spring.snappy}
      className="absolute inset-0 grid place-items-center bg-bg-deep/55"
    >
      <button
        type="button"
        disabled={!onRetry}
        onClick={(e) => {
          e.stopPropagation();
          onRetry?.();
        }}
        className="flex items-center gap-1.5 rounded-full bg-tile-3 px-2.5 py-1 text-2xs font-bold text-mute shadow-hairline focus-ring enabled:hover:text-ink [&_svg]:size-3"
      >
        {icon}
        {text}
        {onRetry && <RotateCcw className="opacity-70" />}
      </button>
    </motion.div>
  );
}
