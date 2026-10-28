import { AlertTriangle, Check, ChevronDown, ShieldCheck, Wrench, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, cn, Skeleton, Spinner, spring, Switch, toast } from "@/design";
import { core, useHostState } from "@/core";
import type { SetupFixError, SetupIssue, SetupStatus } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { Term } from "@/features/shell/Term";
import { Ticks } from "@/features/shell/Ticks";
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
    consequence: "Fallback for sessions without the TeleFlock bridge (older bridges, or with the bridge off): without this they won't appear on the board.",
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
    consequence: "Without this, omp sessions TeleFlock didn't start (started by hand, or restored by herdr) don't show up live, and get typed slash commands instead of exact controls.",
  },
  "install-omp": {
    name: `omp ≥ ${OMP_MIN_VERSION}`,
    consequence: "Without a working omp there are no agents for TeleFlock to start or show on this host.",
  },
  /** Sent by tf-hostd before 0.5.1 (not fixable there). */
  "omp-missing": {
    name: `omp ≥ ${OMP_MIN_VERSION}`,
    consequence: "Without omp there are no agents for TeleFlock to show on this host.",
  },
  "install-bun": {
    name: "bun for omp",
    consequence: "omp on this host is a bun script, and without bun it can't start: no agents, updates or settings.",
  },
  "install-herdr": {
    name: "herdr",
    consequence: "Without herdr there are no panes for agents to run in.",
  },
  "install-git": {
    name: "git",
    consequence: "Without git there are no repositories, diffs, worktrees or commits on this host.",
  },
  "install-gh": {
    name: "GitHub CLI (gh)",
    consequence: "Without gh the board shows no pull request status, checks or merges for this host.",
  },
  "install-ffmpeg": {
    name: "ffmpeg",
    consequence: "Without ffmpeg and ffprobe, omp can't read video attachments.",
  },
  "move-herdr-out-of-login-session": {
    name: "herdr outside login sessions",
    consequence: "Without this, every agent on this host dies when the login session that started herdr is torn down (for example when systemd-logind restarts).",
  },
};

/**
 * Global opt-ins change files outside TeleFlock's own directory and installs download and run
 * software on the host, so each needs explicit consent with a plain explanation of what changes.
 */
const CONSENT: Record<string, { kind: "global" | "install"; what: string; why: string; undo?: string }> = {
  "enable-global-sharing": {
    kind: "global",
    what: "Runs `omp config set` to add `collab.autoStart: control` and `collab.relayUrl: ws://127.0.0.1:<relay port>` to your global omp config (~/.omp/agent/config.yml).",
    why: "Every omp session on this host (including ones you start by hand and ones herdr restores) then shares itself on the private TeleFlock relay, so it shows up live in the app. The relay only listens on 127.0.0.1 of this host.",
  },
  "install-global-bridge": {
    kind: "global",
    what: "Copies the TeleFlock bridge (TeleFlock's omp extension, teleflock-bridge.ts) into ~/.omp/agent/extensions/, where every omp session loads it. TeleFlock keeps that copy up to date when it updates itself.",
    why: "Every omp session on this host then streams itself to TeleFlock natively (transcript, questions, subagents) and gets precise controls (model, thinking, plan review, rename, compact, fork, follow-up queue, export), including sessions it did not launch, without typing slash commands into the terminal.",
  },
  "install-herdr-integration": {
    kind: "global",
    what: "Installs herdr's omp integration (~/.omp/agent/extensions/herdr-omp-agent-state.ts) using herdr's own installer.",
    why: "Lets herdr track omp's working / blocked / idle state, which drives the board columns and needs-you alerts.",
  },
  "move-herdr-out-of-login-session": {
    kind: "global",
    what: "Asks systemd (as root) to move the running herdr server and every process under it (pane shells, omp agents and their tools) out of its login-session scope into a new scope of its own, teleflock-herdr-<session>-….scope. Nothing is stopped or restarted.",
    why: "systemd stops a login-session scope, killing everything in it, when logind tears the session down: on logout with KillUserProcesses=yes, or when a restarted logind cleans up sessions that already ended. In their own scope the agents keep running until herdr exits.",
    undo: "Nothing to undo: the scope ends by itself when herdr exits, and herdr servers TeleFlock starts get their own scope anyway.",
  },
  "install-omp": {
    kind: "install",
    what: "Downloads omp's official installer from omp.sh and runs it on the host in binary mode (`curl -fsSL https://omp.sh/install | sh -s -- --binary`; Windows: `install.ps1 -Binary` in PowerShell). It puts a standalone omp in ~/.local/bin, as your user, without root.",
    why: "TeleFlock starts and controls every agent through omp. The standalone binary needs no bun or Node.js.",
    undo: "To uninstall, delete ~/.local/bin/omp.",
  },
  "install-bun": {
    kind: "install",
    what: "Downloads bun's official installer from bun.sh and runs it on the host (`curl -fsSL https://bun.sh/install | bash`). It puts bun in ~/.bun/bin, as your user, and adds that folder to your shell's startup file (~/.bashrc, ~/.zshrc or fish's config).",
    why: "omp on this host was installed as a bun script, so it can't start without bun.",
    undo: "To uninstall, delete ~/.bun and the lines bun's installer added to your shell's startup file.",
  },
  "install-herdr": {
    kind: "install",
    what: "Downloads herdr's official installer from herdr.dev and runs it on the host (`curl -fsSL https://herdr.dev/install.sh | sh`; Windows: `irm https://herdr.dev/install.ps1 | iex`). It checks the download's checksum and puts herdr in ~/.local/bin, as your user; then TeleFlock starts the herdr server for this session.",
    why: "Every agent TeleFlock starts runs in a herdr pane.",
    undo: "To uninstall, stop herdr and delete ~/.local/bin/herdr.",
  },
  "install-gh": {
    kind: "install",
    what: "Downloads the latest GitHub CLI release for this host from github.com, checks it against the release's published checksums and copies gh into ~/.local/bin, as your user. No root, no package manager.",
    why: "The board reads pull request status, checks and merges through gh. Sign in once on the host afterwards: `gh auth login`.",
    undo: "To uninstall, delete ~/.local/bin/gh.",
  },
  "install-git": {
    kind: "install",
    what: "Runs the host's package manager with the command shown above (as root or with passwordless sudo; Homebrew as your user). It installs git for the whole system.",
    why: "Repositories, diffs, worktrees and commits all go through git.",
    undo: "To uninstall, remove the package with the same package manager.",
  },
  "install-ffmpeg": {
    kind: "install",
    what: "Runs the host's package manager with the command shown above (as root or with passwordless sudo; Homebrew as your user). It installs ffmpeg and ffprobe for the whole system.",
    why: "omp reads video attachments with ffmpeg and ffprobe.",
    undo: "To uninstall, remove the package with the same package manager.",
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
  running,
  failure,
  onToggle,
}: {
  issue: SetupIssue;
  selected: boolean;
  /** The fix runs (or waits its turn) on the host right now. */
  running: boolean;
  /** Why the last attempt at this fix failed. */
  failure?: SetupFixError;
  onToggle: (on: boolean) => void;
}) {
  const consent = CONSENT[issue.id];
  const item = ITEMS[issue.id];
  const install = consent?.kind === "install";
  const [open, setOpen] = useState(false);
  return (
    <motion.li layout transition={spring.smooth} className={cn("rounded-lg p-3 transition-colors", selected ? "bg-accent/10 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.03] shadow-hairline")}>
      <div className="flex items-start gap-3">
        <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", issue.severity === "error" ? "text-error" : issue.severity === "warn" ? "text-warn" : "text-mute")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-ink">{item?.name ?? issue.title}</span>
            {item && /^update\b/i.test(issue.title) && <Badge>Update</Badge>}
            {install && issue.fixable && <Badge>Install</Badge>}
            {issue.recommended && <Badge tone="accent">Recommended</Badge>}
          </div>
          <p className={cn("mt-0.5 text-xs", item ? "text-ink-2" : "text-mute")}>{item?.consequence ?? <Ticks text={issue.detail} />}</p>
          {item && (
            <p className="mt-0.5 text-xs text-mute">
              <Ticks text={issue.detail} />
            </p>
          )}
          {issue.id === "omp-missing" && (
            <ExtLink href={OMP_URL} className="mt-1 inline-block text-xs">
              Install omp
            </ExtLink>
          )}
          {running && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-accent-ink" role="status">
              <Spinner size={12} label={install ? "Installing" : "Applying"} />
              {install ? "Installing on the host… this can take a few minutes; you can leave this page." : "Applying…"}
            </p>
          )}
          {failure && !running && (
            <div className="mt-1.5 rounded-md bg-error/8 p-2 text-xs text-[#ffb1c1]" role="alert">
              <span className="font-bold">Last attempt failed: </span>
              <Ticks text={failure.error.message} />
              {failure.error.hint && (
                <p className="mt-0.5 text-mute">
                  <Ticks text={failure.error.hint} />
                </p>
              )}
            </div>
          )}
          {consent && (
            <>
              <button
                type="button"
                className="mt-1.5 inline-flex items-center gap-1 text-xs font-bold text-accent-hi focus-ring rounded-xs"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
              >
                {consent.kind === "install" ? "What exactly runs?" : "What exactly changes?"}
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
                        <span className="font-bold text-ink-2">{consent.kind === "install" ? "Runs: " : "Changes: "}</span>
                        <span className="text-mute">
                          <Ticks text={consent.what} />
                        </span>
                      </p>
                      <p>
                        <span className="font-bold text-ink-2">Why: </span>
                        <span className="text-mute">
                          <Ticks text={consent.why} />
                        </span>
                      </p>
                      <p className="text-mute-2">{consent.undo ?? "You can undo it at any time by removing the setting or the file."}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
        {issue.fixable && !running && <Switch checked={selected} onCheckedChange={onToggle} label={`Fix: ${issue.title}`} />}
      </div>
    </motion.li>
  );
}

/**
 * Host setup checklist (`host.setup` / `host.setupApply`): what is in place on the host, and the
 * one-tap fixes for what is not. Global opt-ins and installs require ticking an explicit consent box.
 * Fixes run one by one on the host, each on its own: the reply (or, for installs that outlast it,
 * `HostInfo.setup` as tf-hostd republishes it) says which are still running and which failed.
 */
export function SetupChecklist({ hostId }: { hostId: string }) {
  const state = useHostState(hostId);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [consented, setConsented] = useState(false);
  const [applying, setApplying] = useState(false);
  /** Fixes the last apply requested, until their outcome has been reported. */
  const requested = useRef<string[] | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    core
      .host(hostId)
      .call("host.setup", {})
      .then(
        (s) => {
          setStatus(s);
          setSelected(new Set(s.issues.filter((i) => i.fixable && i.recommended && !s.applying?.includes(i.id)).map((i) => i.id)));
        },
        (err: unknown) => setError(errorMessage(err)),
      )
      .finally(() => setLoading(false));
  }, [hostId]);

  useEffect(load, [load]);

  const info = state?.info;
  const live = info?.setup;
  // While fixes run on the host, follow the checklist tf-hostd republishes after each one.
  useEffect(() => {
    if (live) setStatus((prev) => (prev?.applying?.length ? live : prev));
  }, [live]);

  // Report the outcome once nothing the last apply asked for is still running.
  useEffect(() => {
    const ids = requested.current;
    if (!ids || !status || status.applying?.some((id) => ids.includes(id))) return;
    requested.current = null;
    const failed = (status.failed ?? []).filter((f) => ids.includes(f.id));
    if (failed.length === 0) {
      haptic("success");
      toast({ title: "Host setup updated", description: status.issues.length ? `${status.issues.length} item(s) still open.` : "Everything is in place.", status: "done" });
      return;
    }
    haptic("warning");
    toast({
      title: failed.length === ids.length ? (ids.length === 1 ? "The fix failed" : "The fixes failed") : `${ids.length - failed.length} of ${ids.length} fixes applied`,
      description: failed.map((f) => `${status.issues.find((i) => i.id === f.id)?.title ?? f.id}: ${f.error.message}`).join(" · "),
      status: "error",
    });
  }, [status]);

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

  const running = new Set(status?.applying ?? []);
  const chosen = status?.issues.filter((i) => selected.has(i.id) && !running.has(i.id)) ?? [];
  const consentKinds = new Set(chosen.flatMap((i) => (CONSENT[i.id] ? [CONSENT[i.id]!.kind] : [])));
  const needsConsent = consentKinds.size > 0;

  const apply = () => {
    const fixes = chosen.map((i) => i.id);
    setApplying(true);
    core
      .host(hostId)
      .call("host.setupApply", { fixes })
      .then(
        (s) => {
          requested.current = fixes;
          setStatus(s);
          setSelected(new Set());
          setConsented(false);
          if (s.applying?.length) toast({ title: "Installing on the host…", description: "Each fix runs on its own; this checklist updates as they finish.", status: "running" });
        },
        (err: unknown) => {
          // Older tf-hostd: the first failing fix fails the whole call (and stops the rest).
          haptic("warning");
          toast({ title: `Setup failed: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
          load();
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
                running={running.has(issue.id)}
                failure={status.failed?.find((f) => f.id === issue.id)}
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
                <span className="flex flex-col gap-1">
                  {consentKinds.has("global") && (
                    <span>
                      I understand that the selected global changes affect <b>every</b> omp session on this host, not just the ones TeleFlock starts, and I want them.
                    </span>
                  )}
                  {consentKinds.has("install") && (
                    <span>
                      I want TeleFlock to <b>download and run</b> the selected installers on this host, as described under "What exactly runs?".
                    </span>
                  )}
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
