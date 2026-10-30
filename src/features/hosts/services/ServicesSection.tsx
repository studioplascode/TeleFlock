import { ChevronDown, FileText, Octagon, RotateCw, Server, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { agentKey, core, navigate, toApiError, useAgent } from "@/core";
import type { Service, ServiceList, ServiceLogs, ServiceScope } from "@/core/gen";
import { Badge, Button, cn, Elapsed, EmptyState, formatAge, Spinner, toast, useWindowActive } from "@/design";
import { PreviewButton } from "@/features/preview";

/** The Services list re-reads `omp ps` every 5 s while open (hostd shares one run per 2 s). */
const SERVICES_POLL_MS = 5_000;
const LIVE = (s: Service) => s.state !== "exited" && s.state !== "failed";
const STATE_DOT: Record<string, string> = { ready: "bg-done", running: "bg-done", starting: "bg-sun", restarting: "bg-sun", stopping: "bg-sun", failed: "bg-error", exited: "bg-mute-2" };

const scopeName = (s: ServiceScope) => (s.kind === "global" ? `global · ${s.service ?? "?"}` : (s.projectDir ?? s.runtimeDir));
/** `services.*` names a service by its scope's folder (project) or name (global). */
const ref = (scope: ServiceScope, name: string) => (scope.kind === "global" ? { global: scope.service, name } : { dir: scope.projectDir, name });

/**
 * A host's services (`services.*`, architecture §3.18): what agents started under omp's daemon
 * broker (`omp ps`): dev servers, the shared browser, omp's global services. Logs, restart, stop,
 * kill, and one-click Preview of the ports each one listens on.
 */
export function ServicesSection({ hostId, open, onOpenChange }: { hostId: string; open: boolean; onOpenChange(open: boolean): void }) {
  const active = useWindowActive();
  const [list, setList] = useState<ServiceList>();
  const [error, setError] = useState<{ title: string; hint?: string }>();
  const [showEnded, setShowEnded] = useState(false);
  const load = async (refresh = false) => {
    try {
      setList(await core.host(hostId).call("services.list", { refresh }));
      setError(undefined);
    } catch (e) {
      const err = toApiError(e);
      setError({ title: err.message, hint: err.hint });
    }
  };
  useEffect(() => {
    if (!open || !active) return;
    void load();
    const t = window.setInterval(() => void load(), SERVICES_POLL_MS);
    return () => clearInterval(t);
  }, [open, active, hostId]);
  const running = list?.scopes.reduce((n, s) => n + s.services.filter(LIVE).length, 0);
  const ended = list?.scopes.reduce((n, s) => n + s.services.filter((d) => !LIVE(d)).length, 0) ?? 0;
  return (
    <div className="border-t border-line pt-3 max-md:pt-1" data-section="services">
      <button type="button" className="flex w-full items-center gap-2 rounded-sm text-left text-sm font-bold text-ink-2 focus-ring max-md:min-h-10" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <Server className="size-4 text-accent-hi" />
        Services
        {running !== undefined && <Badge tone={running > 0 ? "running" : undefined}>{running} running</Badge>}
        <ChevronDown className={cn("ml-auto size-4 text-mute transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 pt-3">
          {error ? (
            <EmptyState compact title={error.title} description={error.hint} />
          ) : !list ? (
            <div className="flex items-center gap-2 text-xs text-mute">
              <Spinner size={12} /> Asking omp…
            </div>
          ) : list.scopes.every((s) => !s.services.some((d) => showEnded || LIVE(d))) ? (
            <EmptyState compact icon={<Server />} title="No services running" description="Dev servers and other named services agents start under omp (bash with a name), and the shared browser, show up here." />
          ) : (
            list.scopes.map((scope) => {
              const shown = scope.services.filter((d) => showEnded || LIVE(d));
              if (shown.length === 0) return null;
              return (
                <div key={scope.runtimeDir} className="min-w-0">
                  <div className="mb-1 truncate font-mono text-2xs text-mute-2" title={scope.runtimeDir}>
                    {scopeName(scope)}
                    {scope.brokerPid === undefined && " · no broker"}
                  </div>
                  <ul className="flex flex-col gap-1">
                    {shown.map((s) => (
                      <ServiceRow key={s.id || s.name} hostId={hostId} scope={scope} service={s} onChanged={() => void load(true)} />
                    ))}
                  </ul>
                </div>
              );
            })
          )}
          {ended > 0 && (
            <button type="button" className="self-start text-2xs font-bold text-mute hover:text-ink focus-ring" onClick={() => setShowEnded((v) => !v)}>
              {showEnded ? "Hide exited" : `Show exited (${ended})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ServiceRow({ hostId, scope, service: s, onChanged }: { hostId: string; scope: ServiceScope; service: Service; onChanged(): void }) {
  const [busy, setBusy] = useState<string>();
  const [logs, setLogs] = useState<ServiceLogs | "loading">();
  const owner = useAgent(s.agentId ? agentKey(hostId, s.agentId) : "");
  const live = LIVE(s);
  const act = async (verb: "stop" | "kill" | "restart") => {
    setBusy(verb);
    try {
      const after = await core.host(hostId).call(`services.${verb}`, ref(scope, s.name));
      toast({ title: `${s.name}: ${after.state}`, status: "done", duration: 2600 });
      onChanged();
    } catch (e) {
      const err = toApiError(e);
      toast({ title: `Couldn't ${verb} ${s.name}`, description: err.hint ? `${err.message} — ${err.hint}` : err.message, status: "error" });
    } finally {
      setBusy(undefined);
    }
  };
  const readLogs = async () => {
    setLogs((l) => l ?? "loading");
    try {
      setLogs(await core.host(hostId).call("services.logs", { ...ref(scope, s.name), lines: 200 }));
    } catch (e) {
      setLogs(undefined);
      toast({ title: `Couldn't read ${s.name}'s log`, description: toApiError(e).message, status: "error" });
    }
  };
  return (
    <li className="rounded-md well px-2.5 py-2" data-service={s.name}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[s.state] ?? "bg-mute-2")} aria-hidden />
        <span className="min-w-0 truncate font-mono text-xs font-bold text-ink" title={s.command}>
          {s.name}
        </span>
        <span className="text-2xs text-mute">{s.state}</span>
        <span className="font-mono text-2xs text-mute-2 tabular">
          {live ? <Elapsed since={s.startedAt} /> : s.exitedAt ? `${formatAge(Date.now() - s.exitedAt)}${s.exitCode !== undefined ? ` · exit ${s.exitCode}` : ""}` : null}
        </span>
        {s.restartCount > 0 && <span className="text-2xs text-sun-2">↻{s.restartCount}</span>}
        {owner && (
          <button type="button" className="truncate text-2xs font-bold text-accent-ink hover:underline focus-ring" onClick={() => navigate({ name: "agent", hostId, agentId: owner.id })}>
            {owner.name}
          </button>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {live && s.ports.map((port) => <PreviewButton key={port} hostId={hostId} port={port} />)}
          <Button size="sm" variant="ghost" icon={<FileText />} onClick={() => (logs ? setLogs(undefined) : void readLogs())} aria-label={`Logs of ${s.name}`}>
            Logs
          </Button>
          <Button size="sm" variant="ghost" icon={<RotateCw />} loading={busy === "restart"} disabled={!!busy} onClick={() => void act("restart")} aria-label={`Restart ${s.name}`}>
            Restart
          </Button>
          {live && (
            <>
              <Button size="sm" variant="ghost" icon={<Square />} loading={busy === "stop"} disabled={!!busy} onClick={() => void act("stop")} aria-label={`Stop ${s.name}`}>
                Stop
              </Button>
              <Button size="sm" variant="ghost" icon={<Octagon />} loading={busy === "kill"} disabled={!!busy} onClick={() => void act("kill")} aria-label={`Kill ${s.name}`} title="SIGKILL after 100 ms instead of a 5 s graceful stop">
                Kill
              </Button>
            </>
          )}
        </span>
      </div>
      {s.cwd && <div className="mt-0.5 truncate font-mono text-[10px] text-mute-2">{s.cwd}</div>}
      {logs && (
        <div className="mt-2">
          {logs === "loading" ? (
            <div className="flex items-center gap-2 text-2xs text-mute">
              <Spinner size={11} /> Reading the log…
            </div>
          ) : (
            <>
              <pre className="max-h-56 overflow-auto rounded-sm bg-[rgb(6_6_10/0.6)] px-2 py-1.5 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-ink-2" aria-label={`${s.name} log`}>
                {logs.text || "(empty)"}
              </pre>
              <button type="button" className="mt-1 text-2xs font-bold text-mute hover:text-ink focus-ring" onClick={() => void readLogs()}>
                Refresh log
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
