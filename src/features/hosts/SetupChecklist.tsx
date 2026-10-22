import { AlertTriangle, Check, ChevronDown, ShieldCheck, Wrench, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Badge, Button, cn, Skeleton, spring, Switch, toast } from "@/design";
import { core, useHostState } from "@/core";
import type { SetupIssue, SetupStatus } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { Term } from "@/features/shell/Term";
import { ExtLink } from "./CopyCommand";
import { OMP_MIN_VERSION, OMP_URL } from "./kinds";

/**
 * One name and one consequence per setup item, shared by the checklist rows and the issue cards so
 * the same thing is never called two names. The consequence leads; config paths stay in "What exactly changes?".
 */
const ITEMS: Record<string, { name: ReactNode; consequence: ReactNode }> = {
  "enable-global-sharing": {
    name: (
      <>
        <Term id="collab">Share sessions</Term> with TeleFlock
      </>
    ),
    consequence: "Without this, omp sessions you start by hand (or that herdr restores) won't appear on the board.",
  },
  "install-herdr-integration": {
    name: "herdr's omp integration",
    consequence: "Without this, herdr can't tell whether an agent is working, blocked or idle, so lanes and needs-you alerts go wrong.",
  },
  "install-global-bridge": {
    name: (
      <>
        TeleFlock <Term id="bridge">bridge</Term> for every session
      </>
    ),
    consequence: "Without this, sessions TeleFlock didn't start get typed slash commands instead of exact model, thinking and plan controls.",
  },
  "omp-missing": {
    name: `omp ≥ ${OMP_MIN_VERSION}`,
    consequence: "Without omp there are no agents for TeleFlock to show on this host.",
  },
};

/**
 * Global opt-ins change files outside TeleFlock's own directory, so each needs explicit consent
 * with a plain explanation of what changes.
 */
const CONSENT: Record<string, { what: string; why: string }> = {
  "enable-global-sharing": {
    what: "Runs `omp config set` to add `collab.autoStart: control` and `collab.relayUrl: ws://127.0.0.1:<relay port>` to your global omp config (~/.omp/agent/config.yml).",
    why: "Every omp session on this host (including ones you start by hand and ones herdr restores) then shares itself on the private TeleFlock relay, so it shows up live in the app. The relay only listens on 127.0.0.1 of this host.",
  },
  "install-global-bridge": {
    what: "Copies the TeleFlock companion extension into ~/.omp/agent/extensions/, where every omp session loads it.",
    why: "Gives TeleFlock precise controls (model, thinking, plan review, rename, compact, fork, follow-up queue, export) in sessions it did not launch, without typing slash commands into the terminal.",
  },
  "install-herdr-integration": {
    what: "Installs herdr's omp integration (~/.omp/agent/extensions/herdr-omp-agent-state.ts) using herdr's own installer.",
    why: "Lets herdr track omp's working / blocked / idle state, which drives the board columns and needs-you alerts.",
  },
};

interface CheckRow {
  id: string;
  label: ReactNode;
  ok: boolean | null;
  detail?: string;
}

function CheckLine({ row, index }: { row: CheckRow; index: number }) {
  return (
    <motion.li
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...spring.smooth, delay: index * 0.04 }}
      className="flex min-h-9 items-center gap-3 text-sm"
    >
      <span
        className={cn(
          "grid size-5.5 shrink-0 place-items-center rounded-full",
          row.ok === true && "bg-done/18 text-done",
          row.ok === false && "bg-warn/16 text-warn",
          row.ok === null && "bg-white/6 text-mute-2",
        )}
      >
        {row.ok === true ? <Check className="size-3" strokeWidth={3} /> : row.ok === false ? <X className="size-3" strokeWidth={3} /> : <span className="size-1 rounded-full bg-current" />}
      </span>
      <span className="shrink-0 font-semibold whitespace-nowrap text-ink-2">{row.label}</span>
      {row.detail && <span className="ml-auto truncate font-mono text-2xs text-mute-2">{row.detail}</span>}
    </motion.li>
  );
}

function IssueRow({
  issue,
  selected,
  onToggle,
}: {
  issue: SetupIssue;
  selected: boolean;
  onToggle: (on: boolean) => void;
}) {
  const consent = CONSENT[issue.id];
  const item = ITEMS[issue.id];
  const [open, setOpen] = useState(false);
  return (
    <motion.li layout transition={spring.smooth} className={cn("rounded-lg p-3 transition-colors", selected ? "bg-accent/10 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.03] shadow-hairline")}>
      <div className="flex items-start gap-3">
        <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", issue.severity === "error" ? "text-error" : issue.severity === "warn" ? "text-warn" : "text-mute")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-ink">{item?.name ?? issue.title}</span>
            {item && /^update\b/i.test(issue.title) && <Badge>Update</Badge>}
            {issue.recommended && <Badge tone="accent">Recommended</Badge>}
          </div>
          <p className={cn("mt-0.5 text-xs", item ? "text-ink-2" : "text-mute")}>{item?.consequence ?? issue.detail}</p>
          {item && <p className="mt-0.5 text-xs text-mute">{issue.detail}</p>}
          {issue.id === "omp-missing" && (
            <ExtLink href={OMP_URL} className="mt-1 inline-block text-xs">
              Install omp
            </ExtLink>
          )}
          {consent && (
            <>
              <button
                type="button"
                className="mt-1.5 inline-flex items-center gap-1 text-xs font-bold text-accent-hi focus-ring rounded-xs"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
              >
                What exactly changes?
                <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
              </button>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={spring.smooth}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 flex flex-col gap-1.5 rounded-md well p-2.5 text-xs">
                      <p>
                        <span className="font-bold text-ink-2">Changes: </span>
                        <span className="text-mute">{consent.what}</span>
                      </p>
                      <p>
                        <span className="font-bold text-ink-2">Why: </span>
                        <span className="text-mute">{consent.why}</span>
                      </p>
                      <p className="text-mute-2">You can undo it at any time by removing the setting or the file.</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
        {issue.fixable && <Switch checked={selected} onCheckedChange={onToggle} label={`Fix: ${issue.title}`} />}
      </div>
    </motion.li>
  );
}

/**
 * Host setup checklist (`host.setup` / `host.setupApply`): what is in place on the host, and the
 * one-tap fixes for what is not. Global opt-ins require ticking an explicit consent box.
 */
export function SetupChecklist({ hostId }: { hostId: string }) {
  const state = useHostState(hostId);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [consented, setConsented] = useState(false);
  const [applying, setApplying] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    core
      .host(hostId)
      .call("host.setup", {})
      .then(
        (s) => {
          setStatus(s);
          setSelected(new Set(s.issues.filter((i) => i.fixable && i.recommended).map((i) => i.id)));
        },
        (err: unknown) => setError(errorMessage(err)),
      )
      .finally(() => setLoading(false));
  }, [hostId]);

  useEffect(load, [load]);

  const info = state?.info;
  const rows: CheckRow[] = [
    { id: "reach", label: "Host reachable", ok: info ? true : null, detail: info ? `${info.hostname} · ${info.os}/${info.arch}` : undefined },
    {
      id: "hostd",
      label: (
        <>
          <Term id="hostd">tf-hostd</Term> running
        </>
      ),
      ok: info ? true : null,
      detail: info?.hostdVersion,
    },
    { id: "herdr", label: "herdr version", ok: info?.herdr ? info.herdr.ok : info ? false : null, detail: info?.herdr?.version ?? (info ? "not found" : undefined) },
    { id: "omp", label: `omp ≥ ${OMP_MIN_VERSION}`, ok: info?.omp ? info.omp.ok : info ? false : null, detail: info?.omp?.version ?? (info ? "not found" : undefined) },
    { id: "integration", label: ITEMS["install-herdr-integration"]?.name, ok: status ? status.herdrIntegration : null },
    { id: "relay", label: <Term id="collab">Collab relay</Term>, ok: status ? status.relay : null, detail: info ? `127.0.0.1:${info.relayPort}` : undefined },
    { id: "sharing", label: ITEMS["enable-global-sharing"]?.name, ok: status ? status.globalSharing : null },
    { id: "bridge", label: ITEMS["install-global-bridge"]?.name, ok: status ? status.globalBridge : null },
  ];

  const chosen = status?.issues.filter((i) => selected.has(i.id)) ?? [];
  const needsConsent = chosen.some((i) => CONSENT[i.id]);

  const apply = () => {
    setApplying(true);
    core
      .host(hostId)
      .call("host.setupApply", { fixes: chosen.map((i) => i.id) })
      .then(
        (s) => {
          setStatus(s);
          setSelected(new Set());
          setConsented(false);
          haptic("success");
          toast({ title: "Host setup updated", description: s.issues.length ? `${s.issues.length} item(s) still open.` : "Everything is in place.", status: "done" });
        },
        (err: unknown) => {
          haptic("warning");
          toast({ title: `Setup failed: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
        },
      )
      .finally(() => setApplying(false));
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Host setup">
      <ul className="grid gap-x-6 sm:grid-cols-2">
        {rows.map((r, i) => (
          <CheckLine key={r.id} row={r} index={i} />
        ))}
      </ul>
      {loading && !status && <Skeleton className="h-16 rounded-lg" />}
      {error && (
        <div className="flex items-center gap-3 rounded-md bg-error/8 p-2.5 text-sm text-[#ffb1c1]">
          <span className="min-w-0 flex-1">Couldn't read the setup status: {error}</span>
          <Button size="sm" variant="secondary" onClick={load}>
            Retry
          </Button>
        </div>
      )}
      {status && status.issues.length === 0 && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 rounded-md bg-done/10 p-2.5 text-sm font-bold text-done">
          <ShieldCheck className="size-4" /> Everything TeleFlock needs is in place.
        </motion.div>
      )}
      {status && status.issues.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {status.issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                selected={selected.has(issue.id)}
                onToggle={(on) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(issue.id);
                    else next.delete(issue.id);
                    return next;
                  })
                }
              />
            ))}
          </ul>
          <AnimatePresence initial={false}>
            {needsConsent && (
              <motion.label
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex cursor-pointer items-start gap-2.5 overflow-hidden rounded-md bg-warn/8 p-2.5 text-xs text-ink-2 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)]"
              >
                <input type="checkbox" className="mt-0.5 size-4 accent-[#a35cf0]" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
                <span>
                  I understand that the selected global changes affect <b>every</b> omp session on this host, not just the ones TeleFlock starts, and I want them.
                </span>
              </motion.label>
            )}
          </AnimatePresence>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
              Re-check
            </Button>
            <Button size="sm" variant="primary" icon={<Wrench />} loading={applying} disabled={chosen.length === 0 || (needsConsent && !consented)} onClick={apply}>
              Apply {chosen.length > 0 ? `${chosen.length} fix${chosen.length > 1 ? "es" : ""}` : "fixes"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
