import { Copy, ExternalLink, Fingerprint, KeyRound, Plug, RefreshCw, ServerCrash, ShieldCheck, WifiOff, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Button, cn, dismissToast, formatAge, Shimmer, Spinner, spring, toast, useNow } from "@/design";
import { core, navigate, onAppEvent, useHosts } from "@/core";
import type { ConnPhase, ConnStatus, HostKeyInfo } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { PHASE_LABEL } from "@/features/shell/status";

/** The forward path of a connection, shown as a stepper while connecting. */
const PATH: readonly ConnPhase[] = ["connecting", "authenticating", "deploying", "starting", "online"];

/** Fix-it hints for the stable ApiError codes a connection can fail with. */
const CODE_HINTS: Record<string, string> = {
  not_connected: "The host is unreachable. Check that it is on and on your tailnet (`tailscale status`).",
  timeout: "The host took too long to answer. A sleeping laptop or a flaky network is the usual cause.",
  auth_required: "Tailscale wants you to re-authenticate this SSH session.",
  permission_denied: "Tailscale SSH refused the login. Check the `ssh` rules in your tailnet policy for this user.",
  version_mismatch: "tf-hostd on the host is a different version. Reconnecting re-deploys the bundled one.",
  herdr_error: "herdr didn't answer. Is herdr installed and on PATH for this user?",
  io_error: "A local I/O error interrupted the connection. Retrying usually helps.",
};

export function connect(hostId: string): Promise<void> {
  haptic("select");
  return core.app("hosts.connect", { hostId }).then(
    () => undefined,
    (err: unknown) => {
      toast({ title: `Couldn't connect: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
    },
  );
}

export function disconnect(hostId: string): Promise<void> {
  haptic("tick");
  return core.app("hosts.disconnect", { hostId }).then(
    () => undefined,
    (err: unknown) => {
      toast({ title: `Couldn't disconnect: ${errorMessage(err)}`, status: "error" });
    },
  );
}

/** Open a URL in the system browser (Tauri) or a new tab (web). */
export function openExternal(url: string): void {
  core.app("app.openExternal", { url }).catch((err: unknown) => {
    toast({ title: `Couldn't open the browser: ${errorMessage(err)}`, description: url, status: "error" });
  });
}

/** Give up following a connection after this long (it stays visible on the host card). */
const FOLLOW_MS = 120_000;

/**
 * Connect a freshly saved host and narrate it in one toast: "Connecting…" while in flight, then
 * swapped for the outcome (online, needs sign-in / key check, or the error with its hint).
 */
export function connectAndFollow(hostId: string, name: string): void {
  let id = toast({ title: `Connecting to ${name}…`, description: "Deploying and starting tf-hostd if needed.", status: "running", duration: Number.POSITIVE_INFINITY });
  let done = false;
  const finish = (phase: ConnPhase, status: ConnStatus | undefined) => {
    if (done) return;
    done = true;
    unsub();
    window.clearTimeout(timer);
    dismissToast(id);
    const open = { label: "Open hosts", onClick: () => navigate({ name: "hosts" }) };
    if (phase === "online") {
      haptic("success");
      id = toast({ title: `${name} is online`, description: status?.latencyMs !== undefined ? `${Math.round(status.latencyMs)} ms` : undefined, status: "done" });
    } else if (phase === "authRequired" || phase === "hostKey") {
      id = toast({ title: `${name}: ${PHASE_LABEL[phase]}`, description: "Finish it on the host card.", status: "needs-you", action: open, duration: 12_000 });
    } else if (phase === "error") {
      const err = status?.error;
      id = toast({ title: `Couldn't connect ${name}: ${err?.message ?? "connection failed"}`, description: err?.hint ?? (err ? CODE_HINTS[err.code] : undefined), status: "error", action: open });
    }
  };
  const settle = (status: ConnStatus | undefined) => {
    const phase = status?.phase;
    if (phase === "online" || phase === "authRequired" || phase === "hostKey" || phase === "error") finish(phase, status);
  };
  const unsub = onAppEvent((e) => {
    if (e.type === "hostStatus" && e.hostId === hostId) settle(e.status);
  });
  const timer = window.setTimeout(() => finish("reconnecting", undefined), FOLLOW_MS);
  core.app("hosts.connect", { hostId }).then(
    () => settle(useHosts.getState().status[hostId]),
    (err: unknown) => finish("error", { phase: "error", since: Date.now(), attempt: 0, error: { code: "connect", message: errorMessage(err), hint: errorHint(err), retryable: true } }),
  );
}

function Stepper({ phase, message }: { phase: ConnPhase; message?: string }) {
  const at = Math.max(0, PATH.indexOf(phase));
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={PATH.length - 1} aria-valuenow={at} aria-valuetext={PHASE_LABEL[phase]}>
        {PATH.slice(0, -1).map((p, i) => (
          <span key={p} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
            <motion.span
              className={cn("absolute inset-0 origin-left rounded-full bg-run", i === at && "tf-loop animate-pulse")}
              initial={false}
              animate={{ scaleX: i < at ? 1 : i === at ? 0.55 : 0 }}
              transition={spring.gentle}
            />
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Spinner size={14} />
        <Shimmer className="font-semibold">{message ?? `${PHASE_LABEL[phase]}…`}</Shimmer>
      </div>
    </div>
  );
}

function AuthRequired({ hostId, url }: { hostId: string; url?: string }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring.bouncy}
      className="sun-pulse relative overflow-hidden rounded-xl p-4 text-white [background:radial-gradient(120%_130%_at_100%_0%,rgb(255_61_119/0.95)_0%,transparent_60%),radial-gradient(90%_120%_at_0%_100%,#ff7a18_0%,transparent_70%),linear-gradient(135deg,#ff7a18,#ff3d77)]"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-white/20 [&_svg]:size-4.5">
          <KeyRound />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-display text-lg font-bold">Sign in to continue</h4>
          <p className="mt-0.5 text-sm text-white/85">
            Tailscale SSH is in check mode for this host. Approve the login in your browser; TeleFlock keeps waiting and finishes on its own.
          </p>
        </div>
      </div>
      {url && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-black/25 py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>
            {url}
          </code>
          <button
            type="button"
            className="grid size-7 place-items-center rounded-sm text-white/80 pressable focus-ring hover:bg-white/15 hover:text-white"
            aria-label="Copy sign-in link"
            title="Copy link"
            onClick={() => {
              navigator.clipboard.writeText(url).then(
                () => toast({ title: "Sign-in link copied" }),
                () => toast({ title: "Couldn't copy the link", status: "error" }),
              );
            }}
          >
            <Copy className="size-3.5" />
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="bg-white text-[#c2185b] shadow-none hover:bg-white/90"
          icon={<ExternalLink />}
          disabled={!url}
          onClick={() => url && openExternal(url)}
        >
          Open browser
        </Button>
        <Button size="sm" variant="ghost" className="text-white/90 hover:bg-white/15 hover:text-white" icon={<RefreshCw />} onClick={() => connect(hostId)}>
          I've approved it
        </Button>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-white/80">
          <span className="size-1.5 animate-pulse rounded-full bg-white tf-loop" />
          Waiting for approval
        </span>
      </div>
    </motion.div>
  );
}

/** `SHA256:AbCd…` → hash label + 4-char groups, so a fingerprint can be compared at a glance. */
function fingerprintGroups(fp: string): { hash: string; groups: string[] } {
  const at = fp.indexOf(":");
  const hash = at > 0 ? fp.slice(0, at) : "";
  return { hash, groups: fp.slice(at + 1).match(/.{1,4}/g) ?? [] };
}

/** Unknown SSH host key: show it and require an explicit Trust before the connection continues. */
function HostKey({ hostId, info }: { hostId: string; info?: HostKeyInfo }) {
  const [busy, setBusy] = useState<"trust" | "cancel" | null>(null);
  const fp = info ? fingerprintGroups(info.fingerprint) : null;
  const trust = () => {
    if (!info) return;
    haptic("select");
    setBusy("trust");
    core.app("hosts.trustKey", { hostId, fingerprint: info.fingerprint }).then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        toast({ title: `Couldn't trust the key: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
      },
    );
  };
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring.bouncy}
      className="rounded-xl bg-warn/8 p-4 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)]"
      role="alert"
      aria-label="Verify the host key"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-warn/16 text-warn [&_svg]:size-4.5">
          <Fingerprint />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="font-display text-lg font-bold text-ink">Verify the host key</h4>
          <p className="mt-0.5 text-sm text-mute">
            This is the first connection to a host outside your tailnet, so its identity isn't vouched for. Compare the fingerprint with{" "}
            <code className="font-mono text-xs text-ink-2">ssh-keygen -lf</code> on the host before trusting it.
          </p>
        </div>
      </div>
      {info && fp ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 rounded-md bg-black/25 px-3 py-2.5 text-xs">
          <dt className="text-mute-2">Address</dt>
          <dd className="min-w-0 truncate font-mono text-ink-2" title={info.address}>
            {info.address}
          </dd>
          <dt className="text-mute-2">Key type</dt>
          <dd className="font-mono text-ink-2">{info.algorithm}</dd>
          <dt className="text-mute-2">Fingerprint</dt>
          <dd className="flex min-w-0 items-start gap-2">
            <code className="flex min-w-0 flex-1 flex-wrap gap-x-1.5 gap-y-0.5 font-mono text-[12.5px] leading-5 text-ink" aria-label={info.fingerprint} data-fingerprint={info.fingerprint}>
              {fp.hash && <span className="text-mute">{fp.hash}:</span>}
              {fp.groups.map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </code>
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded-sm text-mute pressable focus-ring hover:bg-white/10 hover:text-ink"
              aria-label="Copy fingerprint"
              title="Copy fingerprint"
              onClick={() => {
                navigator.clipboard.writeText(info.fingerprint).then(
                  () => toast({ title: "Fingerprint copied" }),
                  () => toast({ title: "Couldn't copy the fingerprint", status: "error" }),
                );
              }}
            >
              <Copy className="size-3.5" />
            </button>
          </dd>
        </dl>
      ) : (
        <div className="mt-3 flex items-center gap-2 text-sm text-mute">
          <Spinner size={14} /> Reading the host key…
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon={<X />}
          disabled={busy !== null}
          onClick={() => {
            setBusy("cancel");
            void disconnect(hostId).finally(() => setBusy(null));
          }}
        >
          Cancel
        </Button>
        <Button size="sm" variant="primary" icon={busy === "trust" ? <Spinner size={14} /> : <ShieldCheck />} disabled={!info || busy !== null} onClick={trust}>
          Trust and connect
        </Button>
      </div>
    </motion.div>
  );
}

function Reconnecting({ hostId, status }: { hostId: string; status: ConnStatus }) {
  const now = useNow(250);
  const [first] = useState(() => ({ at: Date.now(), next: status.nextRetryAt }));
  const next = status.nextRetryAt;
  const left = next ? Math.max(0, next - now) : 0;
  const total = next && first.next === next ? Math.max(1, next - first.at) : Math.max(1, left);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-md bg-accent/16 text-accent-hi">
          <RefreshCw className={cn("size-4", left === 0 && "animate-spin tf-keep")} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-ink">{left > 0 ? `Retrying in ${Math.ceil(left / 1000)}s` : "Retrying now…"}</div>
          <div className="text-xs text-mute">
            Attempt {status.attempt}
            {status.error && <> · {status.error.message}</>}
          </div>
        </div>
        <Button size="sm" variant="primary" onClick={() => connect(hostId)}>
          Retry now
        </Button>
      </div>
      {next && (
        <div className="h-1 overflow-hidden rounded-full bg-white/8">
          <motion.div className="h-full origin-left rounded-full bg-run" animate={{ scaleX: left / total }} transition={{ type: "tween", duration: 0.25, ease: "linear" }} />
        </div>
      )}
    </div>
  );
}

function Failed({ hostId, status }: { hostId: string; status: ConnStatus }) {
  const err = status.error;
  const hint = err?.hint ?? (err ? CODE_HINTS[err.code] : undefined);
  return (
    <div className="rounded-lg bg-error/8 p-3 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.3)]" role="alert">
      <div className="flex items-start gap-2.5">
        <ServerCrash className="mt-0.5 size-4 shrink-0 text-error" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-[#ffb1c1]">{err?.message ?? status.message ?? "The connection failed."}</div>
          {hint && <p className="mt-1 text-xs text-mute">{hint}</p>}
          {err?.code && <code className="mt-1.5 inline-block rounded-xs bg-black/30 px-1.5 py-0.5 font-mono text-2xs text-mute-2">{err.code}</code>}
        </div>
      </div>
      <div className="mt-2.5 flex justify-end">
        <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={() => connect(hostId)}>
          Try again
        </Button>
      </div>
    </div>
  );
}

function Offline({ hostId, status }: { hostId: string; status: ConnStatus }) {
  const now = useNow(30_000);
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-md bg-white/6 text-mute">
        {status.phase === "offline" ? <WifiOff className="size-4" /> : <Plug className="size-4" />}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-bold text-ink-2">{PHASE_LABEL[status.phase]}</div>
        <div className="text-xs text-mute">
          {status.lastOnlineAt ? `Last online ${formatAge(now - status.lastOnlineAt)}` : (status.message ?? "Connect to see this host's agents.")}
        </div>
      </div>
      <Button size="sm" variant="primary" icon={<Plug />} onClick={() => connect(hostId)}>
        Connect
      </Button>
    </div>
  );
}

/**
 * Everything the user needs to know about a host connection that is not simply "online":
 * a stepper while connecting, the Tailscale sign-in card, a retry countdown, or the error with a hint.
 * Renders nothing when online.
 */
export function ConnStatusCard({ hostId, status, className }: { hostId: string; status: ConnStatus | undefined; className?: string }) {
  const phase = status?.phase ?? "idle";
  let body: React.ReactNode = null;
  if (!status || phase === "idle" || phase === "offline") body = <Offline hostId={hostId} status={status ?? { phase: "idle", since: 0, attempt: 0 }} />;
  else if (phase === "authRequired") body = <AuthRequired hostId={hostId} url={status.authUrl} />;
  else if (phase === "hostKey") body = <HostKey hostId={hostId} info={status.hostKey} />;
  else if (phase === "reconnecting") body = <Reconnecting hostId={hostId} status={status} />;
  else if (phase === "error") body = <Failed hostId={hostId} status={status} />;
  else if (phase !== "online") body = <Stepper phase={phase} message={status.message} />;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {body && (
        <motion.div
          key={phase === "connecting" || phase === "authenticating" || phase === "deploying" || phase === "starting" ? "path" : phase}
          className={className}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
          transition={spring.smooth}
        >
          {body}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
