import { Blocks, CircleAlert, FolderGit2, Globe2, Library, Plus, RefreshCw, RotateCw, Server } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { core, navigate, toApiError, useHostIds, useHosts, useHostState } from "@/core";
import type { McpServer } from "@/core/gen";
import { Button, cn, EmptyState, formatAge, IconButton, PageHeader, Select, type SelectOption, Skeleton, Spinner, toast, useIsMobile, useNow } from "@/design";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { OmpAreaFrame } from "@/features/shell/OmpArea";
import { VIEWS } from "@/features/shell/vocab";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { basename, tildify } from "@/features/workspace/shared/paths";
import { groupServers, lastGoodCheck, plural, projectFolders, type RowTest, scopeOf, serverKey, shadowedBy } from "./model";
import { Banner, OutdatedHost } from "./parts";
import { type EditorTab, ServerEditor } from "./ServerEditor";
import { type RowAction, ServerRow } from "./ServerRow";
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

/** "Checked 2m ago · omp 18.13.2"; after a failed check, when it failed and when the last good one was. */
function CheckLine({ running, count, finishedAt, failed, lastGood, ompVersion }: { running: boolean; count: number; finishedAt?: number; failed: boolean; lastGood?: number; ompVersion?: string }) {
  const now = useNow(30_000);
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs font-semibold text-mute" aria-live="polite">
        <Spinner size={12} /> Checking {plural(count, "server")}…
      </span>
    );
  }
  const version = ompVersion && ` · omp ${ompVersion}`;
  if (failed) {
    return (
      <span className="truncate text-2xs font-semibold text-mute-2">
        <span className="text-[#ff8aa5]">Check failed{finishedAt !== undefined && ` ${formatAge(now - finishedAt)}`}</span>
        {lastGood !== undefined && ` · last good one ${formatAge(now - lastGood)}`}
        {version}
      </span>
    );
  }
  return (
    <span className="truncate text-2xs font-semibold text-mute-2">
      {finishedAt !== undefined ? `Checked ${formatAge(now - finishedAt)}` : "Not checked yet"}
      {version}
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
  const forgetFolder = useMcpPrefs((s) => s.forgetFolder);
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

  // A remembered folder that is gone from the host (a deleted worktree): back to All projects.
  const goneError = q.error?.code === "not_found" ? q.error : undefined;
  useEffect(() => {
    if (!goneError || !hostId || !cwd) return;
    forgetFolder(hostId, cwd);
    toast({ title: `${basename(cwd)} is gone from ${hostName}`, description: "Showing the MCP servers of all projects." });
  }, [goneError, hostId, cwd, hostName, forgetFolder]);

  // Rows, tests and sheets belong to one host and folder.
  const viewKey = `${hostId ?? ""}\u0000${cwd ?? ""}`;
  const [shownKey, setShownKey] = useState(viewKey);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [tests, setTests] = useState<Record<string, RowTest>>({});
  /** The row just shown (saved, or opened from the add sheet): it scrolls into view and lights up. */
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const [editor, setEditor] = useState<{ n: number; server?: McpServer; tab?: EditorTab; open: boolean } | null>(null);
  const [signIn, setSignIn] = useState<{ n: number; target: SignInTarget; open: boolean } | null>(null);
  if (shownKey !== viewKey) {
    setShownKey(viewKey);
    setExpanded(new Set());
    setTests({});
    setFlash(null);
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
  const reveal = useCallback((key: string) => {
    setExpanded((x) => (x.has(key) ? x : new Set(x).add(key)));
    setFlash((f) => ({ key, n: (f?.n ?? 0) + 1 }));
  }, []);
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
        case "test": {
          // The outcome stands in for the row's status until a check that ends later replaces it.
          const since = s.checkedAt;
          setExpanded((x) => (x.has(key) ? x : new Set(x).add(key)));
          setTests((t) => ({ ...t, [key]: { startedAt: Date.now(), since } }));
          core
            .host(hostId)
            .call("mcp.test", ref)
            .then(
              (result) => setTests((t) => ({ ...t, [key]: { result, at: Date.now(), since } })),
              (e: unknown) => {
                const err = toApiError(e);
                setTests((t) => ({ ...t, [key]: { error: [err.message, err.hint].filter(Boolean).join(" — ") } }));
              },
            );
          return;
        }
        case "signOut":
          mutate((h) => h.call("mcp.signOut", ref), `Signed out of “${s.name}”`, "change").catch((e: unknown) => {
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
            mutate((h) => h.call("mcp.remove", ref), `Removed “${s.name}”`, "remove").catch((e: unknown) => {
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
  // A failed check's banner carries "Check again": the header leaves it out meanwhile (one button),
  // and so does an empty list (nothing to check).
  const checkFailed = !!data?.check.error && online && !q.outdated;
  const canCheck = canAdd && !checkFailed && !!data?.servers.length;
  const lastGood = data ? lastGoodCheck(data.servers) : undefined;

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
      <div className="flex flex-col gap-3">
        {scopePicker && <div className={cn("flex", mobile && "flex-col items-stretch")}>{scopePicker}</div>}
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't read the MCP servers"
          description={[q.error.message, q.error.hint].filter(Boolean).join(" — ")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" icon={<RotateCw />} onClick={reload}>
                Retry
              </Button>
              {cwd && (
                <Button variant="ghost" icon={<Globe2 />} onClick={() => setFolder(hostId, undefined)}>
                  Show all projects
                </Button>
              )}
            </div>
          }
          className="mt-5"
        />
      </div>
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
          flash={flash?.key === k ? flash.n : undefined}
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
                {plural(data.liveSessions, "running omp session")} {data.liveSessions === 1 ? "gets" : "get"} the changes you make here without a restart. Changed a config file by hand?{" "}
                <button type="button" onClick={q.reloadSessions} className="rounded-xs font-bold text-mute underline-offset-2 focus-ring hover:text-ink hover:underline">
                  Reload {data.liveSessions === 1 ? "it" : "them"} now
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
          title={lastGood !== undefined ? "The last check failed: statuses may be out of date" : "The check failed: no server has a status yet"}
          action={
            <Button size="sm" variant="secondary" icon={<RefreshCw className={cn(checking && "animate-spin tf-keep")} />} onClick={q.refresh} disabled={checking}>
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

  const toolbar = data && online && !q.outdated && (scopePicker || data.servers.length > 0) && (
    <div className={cn("flex items-center gap-3", mobile && "flex-col items-stretch gap-2")}>
      {scopePicker}
      {data.servers.length > 0 && (
        <div className={cn("flex min-w-0 items-center gap-2", !mobile && "ml-auto")}>
          <CheckLine
            running={checking}
            count={data.servers.filter((s) => s.status === "checking").length || data.servers.filter((s) => s.enabled && !s.shadowed && s.status !== "skipped").length}
            finishedAt={data.check.finishedAt}
            failed={!!data.check.error}
            lastGood={lastGood}
            ompVersion={data.ompVersion}
          />
        </div>
      )}
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
          onReveal={reveal}
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
                {canCheck && (
                  <IconButton label="Check every server again" size="lg" onClick={q.refresh} disabled={checking}>
                    <RefreshCw className={cn(checking && "animate-spin tf-keep")} />
                  </IconButton>
                )}
                <IconButton label="Add a server" size="lg" variant="primary" onClick={() => openEditor(undefined, "popular")}>
                  <Plus />
                </IconButton>
              </>
            ) : undefined
          }
        />
        <OmpAreaFrame current="mcp" hostId={hostId} mobile>
          {hostPicker}
          {toolbar}
          {banners}
          {body}
        </OmpAreaFrame>
        {sheets}
      </div>
    );
  }

  return (
    <OmpAreaFrame current="mcp" hostId={hostId} mobile={false}>
      <PageHeader
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <Blocks className="size-3" /> {hostName || "Host"}
          </span>
        }
        title={VIEWS.mcp.label}
        description="Tool servers omp can use on this host: add them, sign in, test them, switch them on or off."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {hostPicker}
            {canCheck && refreshButton("Check again")}
            {canAdd && (
              <Button variant="primary" icon={<Plus />} onClick={() => openEditor(undefined, "popular")}>
                Add server
              </Button>
            )}
          </div>
        }
      />
      {toolbar}
      {banners}
      {body}
      {sheets}
    </OmpAreaFrame>
  );
}
