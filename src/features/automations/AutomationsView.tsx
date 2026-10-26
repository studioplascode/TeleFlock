import { Clock3, Plus, RotateCw, Server, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { navigate, useHostIds, useHostState, useHosts } from "@/core";
import type { Automation } from "@/core/gen";
import { Button, EmptyState, IconButton, PageHeader, Skeleton, useIsMobile, useNow } from "@/design";
import { HostPicker } from "@/features/dispatch/RepoBar";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { AutomationCard } from "./AutomationCard";
import { AutomationEditor } from "./AutomationEditor";
import { OutdatedHost, SchedulerBanner } from "./parts";
import { RunsList } from "./RunsList";
import { useAutomationsPrefs } from "./store";
import { useAutomations } from "./useAutomations";

/** Route `#/automations[/:hostId]`: one host's scheduled agents, its scheduler status and run history. */
export function AutomationsView({ hostId: routeHost }: { hostId?: string }) {
  const mobile = useIsMobile();
  const hostIds = useHostIds();
  const status = useHosts((s) => s.status);
  const profiles = useHosts((s) => s.profiles);
  const lastHost = useAutomationsPrefs((s) => s.lastHost);
  const setLastHost = useAutomationsPrefs((s) => s.setLastHost);
  const hostId =
    routeHost && hostIds.includes(routeHost)
      ? routeHost
      : lastHost && hostIds.includes(lastHost)
        ? lastHost
        : (hostIds.find((id) => status[id]?.phase === "online") ?? hostIds[0]);
  const hostName = profiles.find((p) => p.id === hostId)?.name ?? hostId ?? "";
  const home = useHostState(hostId ?? "")?.info.home;
  const phase = hostId ? (status[hostId]?.phase ?? "idle") : "idle";

  useEffect(() => {
    if (routeHost && routeHost === hostId) setLastHost(routeHost);
  }, [routeHost, hostId, setLastHost]);
  const pickHost = (id: string) => {
    setLastHost(id);
    navigate({ name: "automations", hostId: id }, { replace: true });
  };

  const q = useAutomations(hostId);
  const now = useNow(15_000);
  const [editor, setEditor] = useState<{ key: number; automation?: Automation; open: boolean } | null>(null);
  const [runFilter, setRunFilter] = useState("all");
  // Filters and the editor belong to one host.
  const [filterHost, setFilterHost] = useState(hostId);
  if (filterHost !== hostId) {
    setFilterHost(hostId);
    setRunFilter("all");
    setEditor(null);
  }
  const openEditor = (automation?: Automation) => setEditor((e) => ({ key: (e?.key ?? 0) + 1, automation, open: true }));
  const showRuns = (id: string) => {
    setRunFilter(id);
    requestAnimationFrame(() => document.getElementById("automation-runs")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const data = q.data;
  const canCreate = !!hostId && !!data;
  // Automations live on one host: the picker offers hosts only (no Auto groups).
  const hostPicker = hostId && hostIds.length > 1 ? <HostPicker target={hostId} hostIds={hostIds} groups={[]} onChange={pickHost} /> : null;

  let body;
  if (!hostId) {
    body = (
      <EmptyState
        icon={<Server />}
        title="No hosts yet"
        description="Automations run on a host. Add one first."
        action={<Button onClick={() => navigate({ name: "hosts" })}>Add a host</Button>}
        className="mt-6"
      />
    );
  } else if (q.outdated) {
    body = <OutdatedHost hostName={hostName} />;
  } else if (!data && (q.waiting || (q.error && phase !== "online"))) {
    body = (
      <EmptyState
        icon={<WifiOff />}
        title={`Waiting for ${hostName}`}
        description={`The host is ${phase}. Its automations keep running there; they show up here once it's connected.`}
        action={
          <Button variant="secondary" onClick={() => navigate({ name: "hosts" })}>
            Hosts
          </Button>
        }
        className="mt-6"
      />
    );
  } else if (!data && q.error) {
    body = (
      <EmptyState
        icon={<Clock3 />}
        title="Couldn't load automations"
        description={q.error.hint ? `${q.error.message} · ${q.error.hint}` : q.error.message}
        action={
          <Button variant="secondary" icon={<RotateCw />} onClick={q.reload}>
            Retry
          </Button>
        }
        className="mt-6"
      />
    );
  } else if (!data) {
    body = (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-[92px] rounded-tile" />
        <Skeleton className="h-[112px] rounded-tile" />
        <Skeleton className="h-[112px] rounded-tile" />
      </div>
    );
  } else {
    body = (
      <>
        <SchedulerBanner scheduler={data.scheduler} />
        <section aria-label="Automations" className="flex flex-col gap-3">
          {data.automations.length === 0 ? (
            <EmptyState
              icon={<Clock3 />}
              title="No automations yet"
              description="Have this host start an omp agent on a schedule: a nightly dependency audit, a weekday standup summary, a weekly flaky-test triage."
              action={
                <Button variant="primary" icon={<Plus />} onClick={() => openEditor()}>
                  New automation
                </Button>
              }
              className="py-8"
            />
          ) : (
            data.automations.map((a) => (
              <AutomationCard key={a.id} hostId={hostId} automation={a} home={home} now={now} onEdit={() => openEditor(a)} onHistory={() => showRuns(a.id)} onChanged={q.reload} />
            ))
          )}
        </section>
        {(data.automations.length > 0 || data.runs.length > 0) && (
          <RunsList hostId={hostId} runs={data.runs} automations={data.automations} filter={runFilter} onFilter={setRunFilter} className="mt-3" />
        )}
      </>
    );
  }

  const editorEl = hostId && editor && (
    <AutomationEditor
      key={editor.key}
      hostId={hostId}
      automation={editor.automation}
      timezone={data?.scheduler.timezone}
      open={editor.open}
      onOpenChange={(open) => setEditor((e) => e && { ...e, open })}
      onSaved={() => {
        setEditor((e) => e && { ...e, open: false });
        q.reload();
      }}
    />
  );

  if (mobile) {
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader
          title="Automations"
          subtitle={data ? `${hostName} · ${data.scheduler.timezone}` : hostName}
          back
          actions={
            canCreate && !q.outdated ? (
              <IconButton label="New automation" size="lg" variant="primary" onClick={() => openEditor()}>
                <Plus />
              </IconButton>
            ) : undefined
          }
        />
        {hostPicker && <div className="px-3 pt-1 pb-1">{hostPicker}</div>}
        <div className="flex flex-col gap-3 px-3 pt-1 pb-6">{body}</div>
        {editorEl}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-8 pt-7 pb-12">
      <PageHeader
        kicker="Schedules"
        title="Automations"
        meta={hostPicker}
        description={`omp agents ${hostName || "a host"} starts on a schedule, in a fresh worktree or in place, whether or not an app is connected.`}
        actions={
          canCreate && !q.outdated ? (
            <Button variant="primary" icon={<Plus />} onClick={() => openEditor()}>
              New automation
            </Button>
          ) : undefined
        }
        className="mb-1"
      />
      {body}
      {editorEl}
    </div>
  );
}
