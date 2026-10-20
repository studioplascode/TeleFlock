import { AlertTriangle, Check, CircleSlash, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { cn, Shimmer, Spinner, spring } from "@/design";
import type { DiagReport, DiagStatus, HostKind } from "@/core/gen";

/** Steps hosts.test runs, in order, per host kind (shown as the "probing" sequence while it runs). */
const PLANNED: Record<HostKind, readonly { id: string; label: string }[]> = {
  tailscaleSsh: [
    { id: "resolve", label: "Resolve host name" },
    { id: "tcp", label: "Reach port 22" },
    { id: "ssh", label: "SSH handshake" },
    { id: "auth", label: "Tailscale identity" },
    { id: "shell", label: "Remote shell" },
    { id: "herdr", label: "herdr version" },
    { id: "omp", label: "omp version" },
    { id: "hostd", label: "tf-hostd" },
    { id: "relay", label: "Collab relay" },
  ],
  local: [
    { id: "shell", label: "Local shell" },
    { id: "herdr", label: "herdr version" },
    { id: "omp", label: "omp version" },
    { id: "hostd", label: "tf-hostd" },
    { id: "relay", label: "Collab relay" },
  ],
  wsl: [
    { id: "shell", label: "WSL distro" },
    { id: "herdr", label: "herdr version" },
    { id: "omp", label: "omp version" },
    { id: "hostd", label: "tf-hostd" },
    { id: "relay", label: "Collab relay" },
  ],
  demo: [
    { id: "shell", label: "Demo engine" },
    { id: "herdr", label: "Simulated herdr" },
  ],
};

const STATUS_META: Record<DiagStatus, { cls: string; label: string }> = {
  ok: { cls: "bg-done/18 text-done shadow-[inset_0_0_0_1px_rgb(163_230_53/0.4)]", label: "OK" },
  warn: { cls: "bg-warn/16 text-warn shadow-[inset_0_0_0_1px_rgb(251_191_36/0.4)]", label: "Warning" },
  fail: { cls: "bg-error/16 text-error shadow-[inset_0_0_0_1px_rgb(255_77_94/0.45)]", label: "Failed" },
  skip: { cls: "bg-white/6 text-mute-2", label: "Skipped" },
};

function StatusIcon({ status }: { status: DiagStatus }) {
  const Icon = status === "ok" ? Check : status === "warn" ? AlertTriangle : status === "fail" ? X : CircleSlash;
  return (
    <motion.span
      initial={{ scale: 0.3, rotate: -40, opacity: 0 }}
      animate={{ scale: 1, rotate: 0, opacity: 1 }}
      transition={spring.bouncy}
      className={cn("grid size-6 shrink-0 place-items-center rounded-full", STATUS_META[status].cls)}
      aria-label={STATUS_META[status].label}
      role="img"
    >
      <Icon className="size-3.5" strokeWidth={3} />
    </motion.span>
  );
}

export interface DiagnosticsProps {
  kind: HostKind;
  /** null while the test runs. */
  report: DiagReport | null;
  running: boolean;
}

const PROBE_MS = 650;
const REVEAL_MS = 140;

/**
 * Animated connection diagnostics. While the test runs, the planned steps light up one by one
 * (the active one shimmers); when the report lands the real results cascade in with their timing.
 */
export function Diagnostics({ kind, report, running }: DiagnosticsProps) {
  const planned = PLANNED[kind];
  const [probe, setProbe] = useState(0);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (!running) return;
    setProbe(0);
    const id = window.setInterval(() => setProbe((p) => Math.min(p + 1, planned.length - 1)), PROBE_MS);
    return () => window.clearInterval(id);
  }, [running, planned.length]);

  useEffect(() => {
    if (!report) return;
    setRevealed(0);
    const id = window.setInterval(() => {
      setRevealed((r) => {
        if (r >= report.steps.length) window.clearInterval(id);
        return Math.min(r + 1, report.steps.length);
      });
    }, REVEAL_MS);
    return () => window.clearInterval(id);
  }, [report]);

  if (!running && !report) return null;

  const failed = report?.steps.find((s) => s.status === "fail");
  const done = report !== null && revealed >= report.steps.length;

  return (
    <div className="well rounded-lg p-3" aria-live="polite">
      <ol className="flex flex-col gap-0.5">
        {running &&
          planned.map((s, i) => {
            const state = i < probe ? "passed" : i === probe ? "active" : "pending";
            return (
              <motion.li
                key={s.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: state === "pending" ? 0.4 : 1, x: 0 }}
                transition={{ ...spring.smooth, delay: i * 0.03 }}
                className="flex h-9 items-center gap-3 px-1 text-sm"
              >
                {state === "active" ? (
                  <Spinner size={22} label={`Checking ${s.label}`} />
                ) : (
                  <span className={cn("grid size-6 place-items-center rounded-full", state === "passed" ? "bg-accent/18" : "bg-white/5")}>
                    <span className={cn("size-1.5 rounded-full", state === "passed" ? "bg-accent-hi" : "bg-white/25")} />
                  </span>
                )}
                {state === "active" ? <Shimmer className="font-semibold">{s.label}…</Shimmer> : <span className="font-semibold text-ink-2">{s.label}</span>}
              </motion.li>
            );
          })}
        {!running &&
          report?.steps.slice(0, revealed).map((s) => (
            <motion.li
              key={s.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring.smooth}
              className={cn("flex min-h-9 items-start gap-3 rounded-sm px-1 py-1.5 text-sm", s.status === "fail" && "bg-error/8")}
            >
              <StatusIcon status={s.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={cn("font-semibold", s.status === "skip" ? "text-mute-2" : "text-ink")}>{s.label}</span>
                  {s.ms !== undefined && <span className="ml-auto font-mono text-2xs text-mute-2 tabular">{s.ms} ms</span>}
                </div>
                {s.detail && <p className={cn("mt-0.5 text-xs break-words", s.status === "fail" ? "text-[#ff9aae]" : "text-mute")}>{s.detail}</p>}
              </div>
            </motion.li>
          ))}
      </ol>
      <AnimatePresence>
        {done && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={spring.smooth}
            className={cn("mt-2 border-t border-line px-1 pt-2.5 text-sm font-bold", failed ? "text-error" : "text-done")}
          >
            {failed ? `Stopped at “${failed.label}”.` : "All checks passed. Ready to connect."}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
