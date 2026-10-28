import { Blocks, CircleAlert, FolderGit2, Globe2, Library, Plus, RefreshCw, RotateCw, Server } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { core, navigate, toApiError, useHostIds, useHosts, useHostState } from "@/core";
import type { McpServer } from "@/core/gen";
import { Button, cn, EmptyState, formatAge, IconButton, PageHeader, Select, type SelectOption, Skeleton, Spinner, toast, useIsMobile, useNow } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { OmpAreaNav } from "@/features/shell/OmpArea";
import { VIEWS } from "@/features/shell/vocab";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { basename, tildify } from "@/features/workspace/shared/paths";
import { groupServers, plural, projectFolders, scopeOf, serverKey, shadowedBy } from "./model";
import { Banner, OutdatedHost } from "./parts";
import { type EditorTab, ServerEditor } from "./ServerEditor";
import { type RowAction, type RowTest, ServerRow } from "./ServerRow";
import { SignInSheet, type SignInTarget } from "./SignIn";
import { useMcpPrefs } from "./store";
import { useMcp } from "./useMcp";

const ALL = "__all__";

/** Route host, else the last one shown, else the first online host, else the first host. */
function useHostChoice(routeHost: string | undefined): { hostId?: string; hostName: string; options: SelectOption[] } {
  const ids = useHostIds();
  const { profiles, status } = useHosts();
  const last = useMcpPrefs((s) => s.hostId);
  const online = ids.filter((id) => status[id]?.phase === "online");
  const hostId = routeHost && ids.includes(routeHost) ? routeHost : last && ids.includes(last) ? last : (online[0] ?? ids[0]);
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const options = ids.map((id) => ({ value: id, label: nameOf(id), hint: status[id]?.phase === "online" ? undefined : "offline" }));
  return { hostId, hostName: hostId ? nameOf(hostId) : "", options };
}

function GroupHeader({ title, detail, count }: { title: string; detail?: ReactNode; count?: number }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-1 pt-1">
      <h2 className="kicker shrink-0">{title}</h2>
      {count !== undefined && <span className="text-2xs font-bold text-mute-2 tabular">{count}</span>}
      {detail && <span className="ml-auto min-w-0 truncate font-mono text-2xs text-mute-2">{detail}</span>}
    </div>
  );
}

function CheckLine({ running, count, finishedAt, ompVersion }: { running: boolean; count: number; finishedAt?: number; ompVersion?: string }) {
  const now = useNow(30_000);
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs font-semibold text-mute" aria-live="polite">
        <Spinner size={12} /> Checking {plural(count, "server")}…
      </span>
    );
  }
  return (
    <span className="truncate text-2xs font-semibold text-mute-2">
      {finishedAt !== undefined ? `Checked ${formatAge(now - finishedAt)}` : "Not checked yet"}
      {ompVersion && ` · omp ${ompVersion}`}
    </span>
  );
}

/** Route `#/mcp[/:hostId]`: omp's MCP servers on one host, per project folder or for all projects. */
export function McpView({ hostId: routeHost }: { hostId?: string }) {
  const mobile = useIsMobile();
  const { hostId, hostName, options } = useHostChoice(routeHost);
  const setLastHost = useMcpPrefs((s) => s.setHost);
  const phase = useHosts((s) => (hostId ? s.status[hostId]?.phase : undefined));
  const online = phase === "online";
  const hostState = useHostState(hostId ?? "");
  const home = hostState?.info.home;
  const workspaces = hostState?.workspaces;
  const picked = useMcpPrefs((s) => (hostId ? s.folders[hostId] : undefined));
  const setFolder = useMcpPrefs((s) => s.setFolder);
  const folders = useMemo(() => {
    const list = projectFolders(workspaces ?? [], home);
    // A folder picked earlier stays offered while its workspace is closed.
    if (picked && !list.some((f) => f.path === picked)) list.push({ path: picked, label: basename(picked), hint: tildify(picked, home) });
    return list;
  }, [workspaces, home, picked]);
  const cwd = picked;
  const q = useMcp(hostId, cwd);
  const data = q.data;

  useEffect(() => {
    if (routeHost && routeHost === hostId) setLastHost(routeHost);
  }, [routeHost, hostId, setLastHost]);

  // Rows, tests and sheets belong to one host and folder.
  const viewKey = `${hostId ?? ""}\u0000${cwd ?? ""}`;
  const [shownKey, setShownKey] = useState(viewKey);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [tests, setTests] = useState<Record<string, RowTest>>({});
  const [editor, setEditor] = useState<{ n: number; server?: McpServer; tab?: EditorTab; open: boolean } | null>(null);
  const [signIn, setSignIn] = useState<{ n: number; target: SignInTarget; open: boolean } | null>(null);
  if (shownKey !== viewKey) {
    setShownKey(viewKey);
    setExpanded(new Set());
    setTests({});
    setEditor(null);
    setSignIn(null);
  }

  const openEditor = useCallback((server?: McpServer, tab?: EditorTab) => setEditor((e) => ({ n: (e?.n ?? 0) + 1, server, tab, open: true })), []);
  const toggle = useCallback(
    (key: string) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const { mutate, setEnabled, reload } = q;

  const onAction = useCallback(
    (action: RowAction, s: McpServer) => {
      if (!hostId) return;
      const ref = { ...(cwd ? { cwd } : {}), name: s.name, scope: scopeOf(s) };
      const key = serverKey(s);
      switch (action) {
        case "edit":
          openEditor(s);
          return;
        case "signIn":
          setSignIn((x) => ({ n: (x?.n ?? 0) + 1, target: { name: s.name, scope: scopeOf(s), cwd }, open: true }));
          return;
        case "test":
          setExpanded((x) => (x.has(key) ? x : new Set(x).add(key)));
          setTests((t) => ({ ...t, [key]: { startedAt: Date.now() } }));
          core
            .host(hostId)
            .call("mcp.test", ref)
            .then(
              (result) => setTests((t) => ({ ...t, [key]: { result } })),
              (e: unknown) => {
                const err = toApiError(e);
                setTests((t) => ({ ...t, [key]: { error: [err.message, err.hint].filter(Boolean).join(" — ") } }));
              },
            );
          return;
        case "signOut":
          mutate((h) => h.call("mcp.signOut", ref), "Signed out").catch((e: unknown) => {
            toast({ title: `Couldn't sign out of “${s.name}”`, description: toApiError(e).message, status: "error" });
          });
          return;
        case "remove":
          void confirmAction({
            title: `Remove “${s.name}” from ${tildify(s.path ?? "omp's config", home)}?`,
            body: "Running sessions drop its tools.",
            confirmLabel: "Remove",
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            mutate((h) => h.call("mcp.remove", ref), "Removed").catch((e: unknown) => {
              const err = toApiError(e);
              toast({ title: `Couldn't remove “${s.name}”`, description: [err.message, err.hint].filter(Boolean).join(" — "), status: "error" });
            });
          });
          return;
      }
    },
    [hostId, cwd, home, mutate, openEditor],
  );

  const groups = useMemo(() => (data ? groupServers(data.servers) : null), [data]);
  const shadowNotes = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of data?.servers ?? []) if (s.shadowed) m.set(serverKey(s), shadowedBy(s, data?.servers ?? []));
    return m;
  }, [data]);

  const pickHost = (id: string) => {
    setLastHost(id);
    navigate({ name: "mcp", hostId: id }, { replace: true });
  };
  const hostPicker = options.length > 1 && hostId && (
    <Select aria-label="Host" className={cn("h-10", mobile ? "w-full" : "w-44")} value={hostId} onValueChange={pickHost} options={options} />
  );
  const scopeOptions: SelectOption[] = [
    { value: ALL, label: "All projects", hint: data ? tildify(data.userPath, home) : "omp's user config", icon: <Globe2 /> },
    ...folders.map((f) => ({ value: f.path, label: f.label, hint: f.hint, icon: <FolderGit2 /> })),
  ];
  const scopePicker = hostId && online && !q.outdated && folders.length > 0 && (
    <Select
      aria-label="Project"
      value={cwd ?? ALL}
      onValueChange={(v) => setFolder(hostId, v === ALL ? undefined : v)}
      options={scopeOptions}
      className={cn("h-9", mobile ? "w-full" : "w-60")}
    />
  );
  const checking = !!data?.check.running;
  const canAdd = !!hostId && online && !!data;

  let body: ReactNode;
  if (!hostId) {
    body = (
      <EmptyState
        icon={<Server />}
        title="No hosts yet"
        description="MCP servers are set up per host. Add a host first."
        action={<Button onClick={() => navigate({ name: "hosts" })}>Add a host</Button>}
        className="mt-8"
      />
    );
  } else if (!online) {
    body = (
      <EmptyState
        icon={<Server />}
        title={`${hostName} is offline`}
        description="MCP servers are read from the host's omp config. Connect it first."
        action={
          <Button variant="secondary" onClick={() => navigate({ name: "hosts" })}>
            Open Hosts
          </Button>
        }
        className="mt-8"
      />
    );
  } else if (q.outdated) {
    body = <OutdatedHost onRetry={reload} />;
  } else if (q.error && !data) {
    body = (
      <EmptyState
        icon={<CircleAlert />}
        title="Couldn't read the MCP servers"
        description={[q.error.message, q.error.hint].filter(Boolean).join(" — ")}
        action={
          <Button variant="secondary" icon={<RotateCw />} onClick={reload}>
            Retry
          </Button>
        }
        className="mt-8"
      />
    );
  } else if (!data || !groups) {
    body = (
      <div className="flex flex-col gap-2" aria-busy aria-label="Loading MCP servers">
        <Skeleton className="mx-1 mb-1 h-3 w-24 rounded-xs" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[62px] rounded-tile" />
        ))}
      </div>
    );
  } else {
    const intro = "MCP servers give omp extra tools — GitHub, docs, databases, your own scripts.";
    const addButtons = (
      <>
        <Button variant="primary" icon={<Plus />} onClick={() => openEditor(undefined, "popular")}>
          Add a server
        </Button>
        <Button variant="secondary" icon={<Library />} onClick={() => openEditor(undefined, "registry")}>
          Browse the registry
        </Button>
      </>
    );
    const row = (s: McpServer) => {
      const k = serverKey(s);
      return (
        <ServerRow
          key={k}
          server={s}
          enabled={q.pendingEnabled[k] ?? s.enabled}
          expanded={expanded.has(k)}
          shadowNote={shadowNotes.get(k) ?? null}
          test={tests[k]}
          home={home}
          onToggle={toggle}
          onAction={onAction}
          onEnabled={setEnabled}
        />
      );
    };
    body =
      data.servers.length === 0 ? (
        <EmptyState icon={<Blocks />} title="No MCP servers yet" description={intro} action={addButtons} className="mt-4" />
      ) : (
        <div className="flex flex-col gap-5">
          <section aria-label="omp's servers" className="flex flex-col gap-2">
            <GroupHeader title="omp" count={groups.omp.length} detail={!mobile && tildify(cwd && data.projectPath ? `${data.projectPath} · ${data.userPath}` : data.userPath, home)} />
            {groups.omp.length === 0 ? (
              <EmptyState compact icon={<Blocks />} title="None of omp's own yet" description={intro} action={addButtons} className="rounded-tile bg-white/[0.018] shadow-hairline" />
            ) : (
              groups.omp.map(row)
            )}
          </section>
          {groups.imported.length > 0 && (
            <section aria-label="From other tools" className="flex flex-col gap-2">
              <GroupHeader title="From other tools" count={groups.imported.length} detail={!mobile && "Read-only here · switch them off for omp"} />
              {groups.imported.map(row)}
            </section>
          )}
          <p className="px-1 text-2xs text-mute-2">
            {data.liveSessions > 0 ? (
              <>
                Changes reach {plural(data.liveSessions, "running omp session")} automatically.{" "}
                <button type="button" onClick={q.reloadSessions} className="rounded-xs font-bold text-mute underline-offset-2 focus-ring hover:text-ink hover:underline">
                  Reload them now
                </button>
              </>
            ) : (
              `No omp session is running ${cwd ? "in this folder" : `on ${hostName}`}; new ones load these servers when they start.`
            )}
          </p>
        </div>
      );
  }

  const banners = data && online && !q.outdated && (data.check.error || data.fileErrors.length > 0) && (
    <div className="flex flex-col gap-2">
      {data.check.error && (
        <Banner
          tone="error"
          title="The last check failed: statuses may be out of date"
          action={
            <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={q.refresh} disabled={checking}>
              Check again
            </Button>
          }
        >
          <span className="font-mono text-2xs break-words">{data.check.error}</span>
        </Banner>
      )}
      {data.fileErrors.map((f) => (
        <Banner key={f.path} tone="warn" title={`omp can't read ${tildify(f.path, home)}`}>
          {f.message}. Its servers are missing until you fix the file; TeleFlock won't overwrite it.
        </Banner>
      ))}
    </div>
  );

  const toolbar = data && online && !q.outdated && (
    <div className={cn("flex items-center gap-3", mobile && "flex-col items-stretch gap-2")}>
      {scopePicker}
      <div className={cn("flex min-w-0 items-center gap-2", !mobile && "ml-auto")}>
        <CheckLine
          running={checking}
          count={data.servers.filter((s) => s.status === "checking").length || data.servers.filter((s) => s.enabled && !s.shadowed && s.status !== "skipped").length}
          finishedAt={data.check.finishedAt}
          ompVersion={data.ompVersion}
        />
      </div>
    </div>
  );

  const sheets = hostId && (
    <>
      {editor && (
        <ServerEditor
          key={editor.n}
          hostId={hostId}
          hostName={hostName}
          home={home}
          cwd={cwd}
          list={data}
          server={editor.server}
          tab={editor.tab}
          open={editor.open}
          onOpenChange={(open) => setEditor((e) => e && { ...e, open })}
          mutate={mutate}
          enabled={editor.server ? (q.pendingEnabled[serverKey(editor.server)] ?? data?.servers.find((x) => serverKey(x) === serverKey(editor.server as McpServer))?.enabled) : undefined}
          setEnabled={setEnabled}
          onSignedIn={reload}
        />
      )}
      {signIn && (
        <SignInSheet key={signIn.n} hostId={hostId} target={signIn.target} open={signIn.open} onOpenChange={(open) => setSignIn((x) => x && { ...x, open })} onDone={reload} />
      )}
    </>
  );

  const refreshButton = (label: string) => (
    <Button variant="secondary" icon={<RefreshCw className={cn(checking && "animate-spin tf-keep")} />} onClick={q.refresh} disabled={checking || !canAdd}>
      {label}
    </Button>
  );

  if (mobile) {
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader
          title={VIEWS.mcp.label}
          subtitle={hostName}
          back
          actions={
            canAdd ? (
              <>
                <IconButton label="Check every server again" size="lg" onClick={q.refresh} disabled={checking}>
                  <RefreshCw className={cn(checking && "animate-spin tf-keep")} />
                </IconButton>
                <IconButton label="Add a server" size="lg" variant="primary" onClick={() => openEditor(undefined, "popular")}>
                  <Plus />
                </IconButton>
              </>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-3 px-3 pt-1 pb-6">
          <OmpAreaNav current="mcp" hostId={hostId} />
          {hostPicker}
          {toolbar}
          {banners}
          {body}
        </div>
        {sheets}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-8 pt-7 pb-12">
      <OmpAreaNav current="mcp" hostId={hostId} className="-mb-2" />
      <PageHeader
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <Blocks className="size-3" /> {hostName || "Host"}
          </span>
        }
        title={VIEWS.mcp.label}
        description="Tool servers omp can use on this host: add them, sign in, test them, switch them on or off. Running sessions pick up every change."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {hostPicker}
            {canAdd && refreshButton("Check again")}
            {canAdd && (
              <Button variant="primary" icon={<Plus />} onClick={() => openEditor(undefined, "popular")}>
                Add server
              </Button>
            )}
          </div>
        }
        className="mb-1"
      />
      {toolbar}
      {banners}
      {body}
      {sheets}
    </div>
  );
}
