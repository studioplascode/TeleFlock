import { AlertTriangle, ArrowRight, Check, ClipboardPaste, Copy, Eye, EyeOff, ExternalLink, KeyRound, Link2, PlugZap, RotateCcw, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useHosts } from "@/core";
import type { AuthFlow } from "@/core/gen";
import { Button, cn, IconButton, Input, popIn, Spinner, spring, useIsMobile, useNow } from "@/design";
import type { RemoteAuth, RemoteAuthTunnel } from "./remoteAuth";

export interface RemoteAuthPanelProps {
  /** From `useRemoteAuth`. */
  auth: RemoteAuth;
  /** What is signed in to, e.g. `ChatGPT` or an MCP server's name (default: the flow's title). */
  name?: string;
  /** Mark shown with the name while starting and once done. */
  icon?: ReactNode;
  /** Dismisses the container: Cancel (after cancelling), Done and Close call it. Without it, no Done / Close buttons are drawn. */
  onClose?(): void;
  /** Success button label (default `Done`). */
  doneLabel?: string;
  /** Line under the success title (default: who signed in, on which host). */
  doneDetail?: ReactNode;
  /** Under the step while the sign-in runs (e.g. another way to sign in). */
  aside?: ReactNode;
  className?: string;
}

/** `login.example.com` for a page address; with its path (`github.com/login/device`) where the
 * user types something in. */
function pageName(url: string | undefined, withPath = false): string {
  if (!url) return "the sign-in page";
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return withPath && path.length <= 24 ? `${u.host}${path}` : u.host;
  } catch {
    return "the sign-in page";
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Host errors are lowercase fragments (`that address is for port 1455 …`): shown as sentences. */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Numbered step with a connector to the next one. */
function Step({ n, done, active, last, title, children }: { n: number; done?: boolean; active?: boolean; last?: boolean; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-full text-xs font-extrabold transition-colors",
            done ? "bg-done/18 text-done" : active ? "bg-accent/20 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.5)]" : "bg-white/6 text-mute",
          )}
          aria-hidden
        >
          {done ? <Check className="size-3.5" strokeWidth={3} /> : n}
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-line-2" aria-hidden />}
      </div>
      <div className={cn("min-w-0 pt-1", !last && "pb-4")}>
        <div className={cn("text-sm font-bold", active || done ? "text-ink" : "text-ink-2")}>{title}</div>
        {children && <div className="mt-1.5 flex flex-col gap-2 text-xs text-mute">{children}</div>}
      </div>
    </li>
  );
}

/** Live progress line: what the host reports it is doing. */
function Progress({ text, className }: { text: ReactNode; className?: string }) {
  return (
    <p className={cn("flex min-w-0 items-center gap-2 text-xs font-semibold text-mute", className)} aria-live="polite">
      <Spinner size={14} label="In progress" />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

function Callout({ tone, icon, children }: { tone: "warn" | "error" | "info"; icon: ReactNode; children: ReactNode }) {
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-xs font-semibold [&>svg]:mt-0.5 [&>svg]:size-3.5 [&>svg]:shrink-0",
        tone === "warn" && "bg-warn/10 text-warn",
        tone === "error" && "bg-error/10 text-error",
        tone === "info" && "bg-white/[0.04] text-mute shadow-[inset_0_0_0_1px_var(--color-line-2)]",
      )}
    >
      {icon}
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/** `localhost:1455 → forge`, with how it stands. */
function TunnelChip({ tunnel, host }: { tunnel: RemoteAuthTunnel; host: string }) {
  if (tunnel.state === "none" || tunnel.port == null) return null;
  const tone = tunnel.state === "open" || tunnel.state === "local" ? "ok" : tunnel.state === "opening" ? "busy" : "bad";
  const label =
    tunnel.state === "local"
      ? `localhost:${tunnel.port} is on ${host} itself`
      : tunnel.state === "open"
        ? `localhost:${tunnel.port} forwarded to ${host}`
        : tunnel.state === "opening"
          ? `Forwarding localhost:${tunnel.port} to ${host}…`
          : `localhost:${tunnel.port} can't be forwarded`;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 self-start rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold",
        tone === "ok" && "bg-done/10 text-done",
        tone === "busy" && "bg-white/6 text-mute",
        tone === "bad" && "bg-warn/10 text-warn",
      )}
      title={tunnel.state === "open" ? "The provider sends your browser back to this address; TeleFlock forwards it to the host's sign-in." : undefined}
    >
      {tone === "busy" ? <Spinner size={11} label="Forwarding" /> : <PlugZap className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** A copy button that confirms in place. */
function CopyButton({ copy, label, size = "sm", variant = "ghost", children }: { copy: () => Promise<boolean>; label: string; size?: "sm" | "md"; variant?: "ghost" | "secondary"; children?: ReactNode }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = () => {
    void copy().then((ok) => {
      setState(ok ? "done" : "failed");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), 1600);
    });
  };
  const icon = state === "done" ? <Check /> : <Copy />;
  if (!children)
    return (
      <IconButton label={state === "done" ? "Copied" : state === "failed" ? "Couldn't copy" : label} size={size} variant={variant} onClick={run}>
        {icon}
      </IconButton>
    );
  return (
    <Button size={size} variant={variant} icon={icon} onClick={run}>
      {state === "done" ? "Copied" : state === "failed" ? "Couldn't copy" : children}
    </Button>
  );
}

/** A pasted code / landed address, or an answer; shows the host's verdict under the field. */
function AnswerForm({
  auth,
  label,
  hideLabel,
  description,
  placeholder,
  secret,
  allowEmpty,
  submitLabel,
  autoFocus,
}: {
  auth: RemoteAuth;
  label: ReactNode;
  /** The step's title already says it (screen readers still get the label). */
  hideLabel?: boolean;
  description?: ReactNode;
  placeholder?: string;
  secret?: boolean;
  allowEmpty?: boolean;
  submitLabel: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [shown, setShown] = useState(false);
  const id = useId();
  const mobile = useIsMobile();
  const ready = allowEmpty || text.trim().length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || auth.submitting) return;
    void auth.submit(text.trim()).then((ok) => ok && setText(""));
  };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) {
        setText(t.trim());
        auth.clearSubmitError();
      }
    } catch {
      /* clipboard read refused: the user pastes by hand */
    }
  };
  const err = auth.submitError;
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor={id} className={cn("text-xs font-bold text-ink-2", hideLabel && "sr-only")}>
        {label}
      </label>
      {description && <p className="text-xs text-mute">{description}</p>}
      <div className={cn("flex gap-2", mobile && "flex-col")}>
        <Input
          id={id}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            auth.clearSubmitError();
          }}
          placeholder={placeholder}
          type={secret && !shown ? "password" : "text"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          invalid={!!err}
          aria-describedby={err ? `${id}-err` : undefined}
          boxClassName="min-w-0 flex-1"
          className="font-mono text-xs"
          trailing={
            secret ? (
              <IconButton size="sm" label={shown ? "Hide" : "Show"} onClick={() => setShown((s) => !s)}>
                {shown ? <EyeOff /> : <Eye />}
              </IconButton>
            ) : typeof navigator !== "undefined" && navigator.clipboard && "readText" in navigator.clipboard ? (
              <IconButton size="sm" label="Paste from clipboard" onClick={() => void paste()}>
                <ClipboardPaste />
              </IconButton>
            ) : undefined
          }
        />
        <Button type="submit" variant="primary" disabled={!ready} loading={auth.submitting} icon={<ArrowRight />} className={cn(mobile && "w-full")}>
          {submitLabel}
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {err && (
          <motion.p
            id={`${id}-err`}
            key={`${err.code}:${err.message}`}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={spring.snappy}
            className="text-xs font-semibold text-error"
            role="alert"
          >
            {sentence(err.message)}
            {err.hint && <span className="block font-medium text-mute">{err.hint}</span>}
          </motion.p>
        )}
      </AnimatePresence>
    </form>
  );
}

function OpenButton({ auth, label, primary = true }: { auth: RemoteAuth; label: string; primary?: boolean }) {
  const mobile = useIsMobile();
  return (
    <div className={cn("flex flex-wrap items-center gap-2", mobile && "flex-col items-stretch")}>
      <Button variant={primary && !auth.opened ? "primary" : "secondary"} icon={<ExternalLink />} onClick={auth.openUrl} className={cn(mobile && "w-full")}>
        {auth.opened ? "Open again" : label}
      </Button>
      <CopyButton copy={auth.copyUrl} label="Copy the link (open it on another device)" variant="ghost">
        Copy link
      </CopyButton>
    </div>
  );
}

function Expiry({ flow }: { flow: AuthFlow | null }) {
  const now = useNow(1000);
  if (!flow?.expiresAt) return null;
  const left = flow.expiresAt - now;
  if (left <= 0 || left > 60 * 60_000) return null;
  return <span className="tabular">times out in {clock(left)}</span>;
}

/** The redirect target, as the browser will show it: `http://localhost:8085/oauth2callback?code=…`. */
function landedExample(flow: AuthFlow): string {
  const base = flow.redirectUri ?? (flow.callbackPort ? `http://localhost:${flow.callbackPort}/` : "");
  return base ? `${base}${base.includes("?") ? "&" : "?"}code=…` : "Paste the code";
}

function Running({ auth, name, host }: { auth: RemoteAuth; name: string; host: string }) {
  const { flow, stage, tunnel } = auth;
  const [fallbackOpen, setFallbackOpen] = useState(false);
  if (!flow || stage === "starting") return null;
  const message = flow.message?.trim();
  const page = pageName(flow.url, stage === "device");
  switch (stage) {
    case "browser": {
      const callback = flow.callbackPort != null;
      return (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col">
            <Step n={1} active={!auth.opened} done={auth.opened} title={`Sign in to ${name} in your browser`}>
              <span>
                {auth.opened ? `${page} opened in your browser.` : `Opens ${page} on this device.`}
                {flow.instructions && !callback ? ` ${flow.instructions}` : ""}
              </span>
              <OpenButton auth={auth} label="Open sign-in page" />
            </Step>
            <Step n={2} last active={auth.opened} title={callback ? "Come back here" : "Approve it there"}>
              <span>{callback ? `TeleFlock hands the answer to ${host} by itself, then this finishes.` : `This finishes by itself once you approved it.`}</span>
              {callback && <TunnelChip tunnel={tunnel} host={host} />}
            </Step>
          </ol>
          {auth.opened && <Progress text={message || "Waiting for you to finish in the browser…"} />}
          {auth.paste === "fallback" && (
            <div className="rounded-lg bg-white/[0.025] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-xs text-left text-xs font-bold text-ink-2 focus-ring"
                aria-expanded={fallbackOpen}
                onClick={() => setFallbackOpen((o) => !o)}
              >
                <ClipboardPaste className="size-3.5 text-mute" />
                The browser showed an error page instead?
                <span className="ml-auto text-mute">{fallbackOpen ? "Hide" : "Paste its address"}</span>
              </button>
              <AnimatePresence initial={false}>
                {fallbackOpen && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="overflow-hidden">
                    <div className="pt-3">
                      <AnswerForm
                        auth={auth}
                        autoFocus
                        label="Address from the browser's address bar"
                        description={`It starts with http://localhost:${flow.callbackPort ?? ""}. ${host} finishes the sign-in with it.`}
                        placeholder={landedExample(flow)}
                        submitLabel="Finish sign-in"
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      );
    }
    case "paste": {
      const landed = flow.callbackPort != null;
      // tf-client: "port 8085 is not free on this device: another program on this device uses it".
      const why = tunnel.message?.match(/not free on this device: (.+)$/)?.[1];
      return (
        <div className="flex flex-col gap-4">
          {(tunnel.state === "busy" || tunnel.state === "failed") && (
            <Callout tone="warn" icon={<PlugZap />}>
              {tunnel.state === "busy"
                ? `Port ${tunnel.port} is taken on this device${why ? ` (${why})` : ""}, so the browser can't hand the sign-in back to ${host} by itself.`
                : (tunnel.message ?? `The sign-in can't come back to ${host} by itself.`)}
              <span className="mt-0.5 block font-medium text-mute">Pasting the address it lands on works just as well.</span>
            </Callout>
          )}
          <ol className="flex flex-col">
            <Step n={1} active={!auth.opened} done={auth.opened} title={`Sign in to ${name} in your browser`}>
              {flow.instructions && !landed && <span>{flow.instructions}</span>}
              <OpenButton auth={auth} label="Open sign-in page" />
            </Step>
            <Step n={2} last active={auth.opened} title={landed ? "Paste the address you land on" : "Paste the code it shows"}>
              <AnswerForm
                auth={auth}
                hideLabel
                label={landed ? "Address from the browser's address bar" : "Code"}
                description={
                  landed
                    ? `After you approve, the browser shows an error page at localhost:${flow.callbackPort}. That's expected: copy the full address from its address bar.`
                    : "Copy the code the page shows after you approve."
                }
                placeholder={landed ? landedExample(flow) : "Paste the code"}
                submitLabel="Finish sign-in"
              />
            </Step>
          </ol>
          {message && auth.opened && <p className="text-xs text-mute-2">{message}</p>}
        </div>
      );
    }
    case "device": {
      const code = flow.userCode ?? "";
      return (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col">
            <Step n={1} active title="Your one-time code">
              <div className="flex items-center gap-2">
                <code className="rounded-lg bg-[rgb(10_10_16/0.7)] px-4 py-2.5 font-mono text-2xl font-bold tracking-[0.18em] text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] select-all max-md:text-xl">
                  {code}
                </code>
                <CopyButton copy={auth.copyCode} label="Copy code" variant="secondary" size="md" />
              </div>
            </Step>
            <Step n={2} last active title={`Enter it at ${page}`}>
              <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
                <Button
                  variant={auth.opened ? "secondary" : "primary"}
                  icon={<ExternalLink />}
                  onClick={() => {
                    // Both inside the click: clipboard writes and new tabs need the gesture.
                    void auth.copyCode();
                    auth.openUrl();
                  }}
                  className="max-md:w-full"
                >
                  {auth.opened ? "Open again" : "Copy code & open"}
                </Button>
                <CopyButton copy={auth.copyUrl} label="Copy the link (open it on another device)">
                  Copy link
                </CopyButton>
              </div>
            </Step>
          </ol>
          <Progress text={message || "Waiting for you to enter the code…"} />
        </div>
      );
    }
    case "prompt": {
      const p = flow.prompt;
      if (!p) return null;
      const keyish = p.secret;
      return (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col">
            {flow.url && (
              <Step n={1} done={auth.opened} title={keyish ? "Get your key" : `Open ${page}`}>
                {flow.instructions && <span>{flow.instructions}</span>}
                <OpenButton auth={auth} label={`Open ${page}`} primary={false} />
              </Step>
            )}
            <Step n={flow.url ? 2 : 1} last active title={p.message}>
              <AnswerForm
                auth={auth}
                autoFocus
                label={keyish ? "Key" : "Answer"}
                description={keyish ? `Sent to omp on ${host}, which stores it. TeleFlock keeps no copy.` : undefined}
                placeholder={p.placeholder}
                secret={p.secret}
                allowEmpty={!p.secret}
                submitLabel={keyish ? "Save key" : "Continue"}
              />
            </Step>
          </ol>
        </div>
      );
    }
    default:
      return <Progress text={message || "Finishing the sign-in…"} className="py-6" />;
  }
}

function Final({ auth, name, icon, host, onClose, doneLabel, doneDetail }: { auth: RemoteAuth; name: string; icon?: ReactNode; host: string; onClose?: () => void; doneLabel: string; doneDetail?: ReactNode }) {
  const mobile = useIsMobile();
  const { flow, stage, error } = auth;
  if (stage === "done") {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <motion.div {...popIn} className="relative grid size-16 place-items-center rounded-full bg-done/14 text-done shadow-[inset_0_0_0_1px_rgb(163_230_53/0.35),0_0_40px_-8px_rgb(163_230_53/0.55)]">
          <Check className="size-8" strokeWidth={2.6} />
          {icon && <span className="absolute -right-1 -bottom-1">{icon}</span>}
        </motion.div>
        <div>
          <h3 className="font-display text-xl font-bold text-ink">{flow?.kind === "account" ? `${name} linked` : `Signed in to ${name}`}</h3>
          <p className="mt-1 text-sm text-mute">{doneDetail ?? (flow?.account ? <>{flow.account} · on {host}</> : `Ready on ${host}.`)}</p>
        </div>
        {onClose && (
          <Button variant="primary" onClick={onClose} className={cn("mt-1 min-w-32", mobile && "w-full")} autoFocus>
            {doneLabel}
          </Button>
        )}
      </div>
    );
  }
  const title = stage === "expired" ? "The sign-in timed out" : stage === "cancelled" ? "Sign-in cancelled" : "The sign-in didn't finish";
  const reason = stage === "cancelled" ? undefined : (error?.message ?? flow?.message);
  const hint = stage === "cancelled" ? undefined : error?.hint;
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <motion.div
        {...popIn}
        data-status={stage === "cancelled" ? "idle" : "error"}
        className="grid size-14 place-items-center rounded-full st-soft [&_svg]:size-6"
      >
        {stage === "cancelled" ? <RotateCcw /> : <AlertTriangle />}
      </motion.div>
      <div className="max-w-md">
        <h3 className="font-display text-lg font-bold text-ink">{title}</h3>
        {reason && <p className="mt-1 text-sm break-words text-mute">{sentence(reason)}</p>}
        {hint && <p className="mt-1 text-xs break-words text-mute-2">{hint}</p>}
      </div>
      <div className={cn("mt-1 flex flex-wrap justify-center gap-2", mobile && "w-full flex-col")}>
        {auth.canRetry && (
          <Button variant="primary" icon={<RotateCcw />} onClick={auth.retry} className={cn(mobile && "w-full")}>
            {stage === "cancelled" ? "Start again" : "Try again"}
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" onClick={onClose} className={cn(mobile && "w-full")}>
            Close
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The whole sign-in for one `useRemoteAuth` flow: start, the step the host asks for (page to open
 * with its same-port tunnel, device code, pasted code or landed address, a question), progress,
 * success and failure with retry. The container (sheet, dialog) supplies only the frame and title.
 */
export function RemoteAuthPanel({ auth, name, icon, onClose, doneLabel = "Done", doneDetail, aside, className }: RemoteAuthPanelProps) {
  const host = useHosts((s) => s.profiles.find((p) => p.id === auth.hostId)?.name ?? auth.hostId);
  const mobile = useIsMobile();
  const label = name ?? auth.flow?.title ?? "the service";
  const final = auth.stage === "done" || auth.stage === "failed" || auth.stage === "cancelled" || auth.stage === "expired";
  const cancel = () => {
    auth.cancel();
    onClose?.();
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)} data-stage={auth.stage}>
      <AnimatePresence initial={false}>
        {auth.reconnecting && !final && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring.smooth} className="overflow-hidden">
            <Callout tone="info" icon={<WifiOff />}>
              Reconnecting to {host}… the sign-in keeps running there.
            </Callout>
          </motion.div>
        )}
      </AnimatePresence>
      {auth.openError && !final && (
        <Callout tone="warn" icon={<Link2 />}>
          Couldn't open the browser: {auth.openError}
          <span className="mt-0.5 block font-medium text-mute">Copy the link and open it yourself.</span>
        </Callout>
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={final ? "final" : auth.stage === "starting" ? "starting" : "running"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={spring.smooth}
        >
          {final ? (
            <Final auth={auth} name={label} icon={icon} host={host} onClose={onClose} doneLabel={doneLabel} doneDetail={doneDetail} />
          ) : auth.stage === "starting" ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="relative grid size-14 place-items-center">
                <Spinner size={56} label="Starting" className="absolute inset-0" />
                <span className="grid size-9 place-items-center text-mute [&_svg]:size-5">{icon ?? <KeyRound />}</span>
              </div>
              <div>
                <p className="text-sm font-bold text-ink">Starting the sign-in on {host}…</p>
                <p className="mt-0.5 text-xs text-mute">{auth.flow?.message ?? "omp prepares the sign-in page."}</p>
              </div>
            </div>
          ) : (
            <Running auth={auth} name={label} host={host} />
          )}
        </motion.div>
      </AnimatePresence>
      {!final && auth.stage !== "starting" && aside}
      {!final && (
        <div className={cn("flex items-center gap-3 border-t border-line pt-3 text-2xs font-semibold text-mute-2", mobile && "flex-col-reverse items-stretch")}>
          <span className={cn("min-w-0 flex-1", mobile && "text-center")}>
            Runs on {host}
            {auth.flow?.expiresAt ? " · " : ""}
            <Expiry flow={auth.flow} />
          </span>
          <Button variant="ghost" size="sm" onClick={cancel} className={cn(mobile && "w-full")}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
