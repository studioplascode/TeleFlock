import { ArrowUpCircle, CircleAlert, FolderGit2, Globe2, Package, Puzzle, RefreshCw, RotateCw, Server, Sparkles, Store } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { navigate, useCore, useHostIds, useHosts, useWorkspaces } from "@/core";
import type { ApiError, SkillInfo } from "@/core/gen";
import { Button, cn, EmptyState, formatAge, IconButton, PageHeader, Select, type SelectOption, Skeleton, Spinner, toast, useIsMobile, useNow } from "@/design";
import { ToolUpdatesRow } from "@/features/hosts/ToolUpdates";
import { plural, projectFolders } from "@/features/mcp/model";
import { Banner, OutdatedHost } from "@/features/mcp/parts";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { OmpAreaFrame } from "@/features/shell/OmpArea";
import { VIEWS } from "@/features/shell/vocab";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { basename, tildify } from "@/features/workspace/shared/paths";
import { GetMore, type MoreTab } from "./GetMore";
import { type AnyPlugin, errorLine, groupSkills, isMarketplacePlugin, pendingUpdates, pluginKey, pluginRef, runningSessions, SKILL_GROUPS, type SkillItem } from "./model";
import { GroupHeader } from "./parts";
import { type PluginAction, PluginRow } from "./PluginRow";
import { type SkillAction, SkillRow } from "./SkillRow";
import { type PluginsSection, usePluginsPrefs } from "./store";
import { skillSwitchKey, usePlugins } from "./usePlugins";

const ALL = "__all__";

/** Route host, else the last one shown, else the first online host, else the first host. */
function useHostChoice(routeHost: string | undefined): { hostId?: string; hostName: string; options: SelectOption[] } {
  const ids = useHostIds();
  const { profiles, status } = useHosts();
  const last = usePluginsPrefs((s) => s.hostId);
  const online = ids.filter((id) => status[id]?.phase === "online");
  const hostId = routeHost && ids.includes(routeHost) ? routeHost : last && ids.includes(last) ? last : (online[0] ?? ids[0]);
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const options = ids.map((id) => ({ value: id, label: nameOf(id), hint: status[id]?.phase === "online" ? undefined : "offline" }));
  return { hostId, hostName: hostId ? nameOf(hostId) : "", options };
}

/** One entry of the section rail (desktop) or tab strip (phone): label, count, pending updates. */
function SectionButton({ label, icon, count, updates, active, compact, onClick }: { label: string; icon: ReactNode; count?: number; updates?: number; active: boolean; compact: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-md text-sm font-semibold transition-colors focus-ring [&_svg]:size-3.5",
        compact ? "h-8 px-3" : "h-9 w-full px-3 text-left",
        active ? "bg-accent/16 text-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]" : "text-mute hover:bg-white/6 hover:text-ink",
      )}
    >
      {!compact && icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {updates ? (
        <span className="rounded-full bg-accent/20 px-1.5 text-2xs font-bold text-accent-hi tabular" title={`${plural(updates, "update")} available`}>
          {updates}
        </span>
      ) : null}
      {!compact && count !== undefined && <span className="text-2xs text-mute-2 tabular">{count}</span>}
    </button>
  );
}

/** "Updates checked 5m ago · omp 18.13.3"; while the registry is asked, says so. */
function StatusLine({ checking, checkedAt, ompVersion }: { checking: boolean; checkedAt?: number; ompVersion?: string }) {
  const now = useNow(30_000);
  if (checking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs font-semibold text-mute" aria-live="polite">
        <Spinner size={12} /> Asking the registry for updates…
      </span>
    );
  }
  return (
    <span className="truncate text-2xs font-semibold text-mute-2">
      {checkedAt !== undefined ? `Updates checked ${formatAge(now - checkedAt)}` : "Updates not checked yet"}
      {ompVersion && ` · omp ${ompVersion}`}
    </span>
  );
}

/** What changes made here do to running sessions, and "Reload them now" for files edited by hand. */
function SessionsNote({ hostId, hostName, cwd, onReload }: { hostId: string; hostName: string; cwd?: string; onReload(): void }) {
  const n = useCore((s) => runningSessions(s.hosts[hostId]?.state.agents, cwd));
  return (
    <p className="px-1 text-2xs text-mute-2">
      {n > 0 ? (
        <>
          {plural(n, "running omp session")} {n === 1 ? "gets" : "get"} installs, updates and switches from here without a restart; a package plugin's code loads when a session starts.
          Changed something by hand?{" "}
          <button type="button" onClick={onReload} className="rounded-xs font-bold text-mute underline-offset-2 focus-ring hover:text-ink hover:underline">
            Reload {n === 1 ? "it" : "them"} now
          </button>
        </>
      ) : (
        `No omp session is running ${cwd ? "in this folder" : `on ${hostName}`}; new ones load these when they start.`
      )}
    </p>
  );
}

/** omp's discovery warnings (an unreadable SKILL.md, a name two skills claim, …): three, then the rest on demand. */
function Warnings({ warnings }: { warnings: readonly string[] }) {
  const [open, setOpen] = useState(false);
  if (warnings.length === 0) return null;
  const shown = open ? warnings : warnings.slice(0, 3);
  return (
    <Banner tone="warn" title={`omp reported ${plural(warnings.length, "problem")}`}>
      <ul className="flex flex-col gap-0.5">
        {shown.map((w) => (
          <li key={w} className="font-mono text-2xs break-words">
            {w}
          </li>
        ))}
      </ul>
      {warnings.length > 3 && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 rounded-xs text-2xs font-bold text-mute focus-ring hover:text-ink">
          {open ? "Show fewer" : `Show all ${warnings.length}`}
        </button>
      )}
    </Banner>
  );
}

/** A list that couldn't be read: omp too old for it (with the host's omp update controls), or the error with Retry. */
function SectionError({ error, what, hostId, hostName, cwd, onRetry, onAllProjects }: { error: ApiError; what: string; hostId: string; hostName: string; cwd?: string; onRetry(): void; onAllProjects(): void }) {
  if (error.code === "unsupported") {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          icon={<ArrowUpCircle />}
          title={`omp on ${hostName} is too old for ${what}`}
          description={`${errorLine(error)} Update omp, then try again.`}
          action={
            <Button variant="secondary" icon={<RotateCw />} onClick={onRetry}>
              Try again
            </Button>
          }
          className="mt-4"
        />
        <ToolUpdatesRow hostId={hostId} />
      </div>
    );
  }
  return (
    <EmptyState
      icon={<CircleAlert />}
      title={`Couldn't read the ${what}`}
      description={errorLine(error)}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" icon={<RotateCw />} onClick={onRetry}>
            Retry
          </Button>
          {cwd && (
            <Button variant="ghost" icon={<Globe2 />} onClick={onAllProjects}>
              Show all projects
            </Button>
          )}
        </div>
      }
      className="mt-4"
    />
  );
}

function RowsSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2" aria-busy aria-label={label}>
      <Skeleton className="mx-1 mb-1 h-3 w-24 rounded-xs" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[62px] rounded-tile" />
      ))}
    </div>
  );
}

/** Route `#/plugins[/:hostId]`: omp's skills and plugins on one host, per project folder or for all projects. */
export function PluginsView({ hostId: routeHost }: { hostId?: string }) {
  const mobile = useIsMobile();
  const { hostId, hostName, options } = useHostChoice(routeHost);
  const setLastHost = usePluginsPrefs((s) => s.setHost);
  const phase = useHosts((s) => (hostId ? s.status[hostId]?.phase : undefined));
  const online = phase === "online";
  const home = useCore((s) => (hostId ? s.hosts[hostId]?.state.info.home : undefined));
  const workspaces = useWorkspaces(hostId ?? "");
  const picked = usePluginsPrefs((s) => (hostId ? s.folders[hostId] : undefined));
  const setFolder = usePluginsPrefs((s) => s.setFolder);
  const forgetFolder = usePluginsPrefs((s) => s.forgetFolder);
  const section = usePluginsPrefs((s) => s.section);
  const setSection = usePluginsPrefs((s) => s.setSection);
  const folders = useMemo(() => {
    const list = projectFolders(workspaces, home);
    // A folder picked earlier stays offered while its workspace is closed.
    if (picked && !list.some((f) => f.path === picked)) list.push({ path: picked, label: basename(picked), hint: tildify(picked, home) });
    return list;
  }, [workspaces, home, picked]);
  const cwd = picked;
  const projectName = cwd ? basename(cwd) : undefined;
  const q = usePlugins(hostId, cwd, hostName);
  const { skills, plugins } = q;

  useEffect(() => {
    if (routeHost && routeHost === hostId) setLastHost(routeHost);
  }, [routeHost, hostId, setLastHost]);

  // A remembered folder that is gone from the host (a deleted worktree): back to All projects.
  const gone = q.skillsError?.code === "not_found" || q.pluginsError?.code === "not_found";
  useEffect(() => {
    if (!gone || !hostId || !cwd) return;
    forgetFolder(hostId, cwd);
    toast({ title: `${basename(cwd)} is gone from ${hostName}`, description: "Showing the skills and plugins of all projects." });
  }, [gone, hostId, cwd, hostName, forgetFolder]);

  // Expanded rows and the lit-up row belong to one host and folder.
  const viewKey = `${hostId ?? ""}\u0000${cwd ?? ""}`;
  const [shownKey, setShownKey] = useState(viewKey);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const [moreTab, setMoreTab] = useState<MoreTab>("marketplaces");
  if (shownKey !== viewKey) {
    setShownKey(viewKey);
    setExpanded(new Set());
    setFlash(null);
  }
  const toggle = useCallback(
    (key: string) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  /** Opens a row (just installed): its section, expanded, scrolled to and lit up. */
  const show = useCallback(
    (to: "skills" | "plugins", key: string) => {
      setSection(to);
      setExpanded((x) => (x.has(key) ? x : new Set(x).add(key)));
      setFlash((f) => ({ key, n: (f?.n ?? 0) + 1 }));
    },
    [setSection],
  );

  const { skillChange, pluginChange, setSkillEnabled, setPluginEnabled } = q;
  const onSkillAction = useCallback(
    (action: SkillAction, item: SkillItem) => {
      const r = item.registry;
      if (!r) return;
      const where = { ...(cwd ? { cwd } : {}), id: r.id, scope: r.scope };
      if (action === "remove") {
        void confirmAction({
          title: `Remove “${r.id}”?`,
          body: r.scope === "project" ? "It leaves this project's skills.json; sessions here drop the skill." : "It leaves your skills.json; running sessions drop the skill.",
          confirmLabel: "Remove",
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          void skillChange((h) => h.call("skills.remove", where), {
            busy: [{ key: item.key, label: "Removing…" }],
            title: `Removed “${r.id}”`,
            failTitle: `Couldn't remove “${r.id}”`,
            change: "remove",
            lines: true,
          });
        });
        return;
      }
      const restore = action === "restore";
      void skillChange((h, allowScripts) => h.call("skills.update", { ...where, ...(allowScripts ? { allowScripts } : {}) }), {
        busy: [{ key: item.key, label: restore ? "Restoring…" : "Updating…" }],
        title: restore ? `Restored “${r.id}”` : `Updated “${r.id}”`,
        failTitle: restore ? `Couldn't restore “${r.id}”` : `Couldn't update “${r.id}”`,
        change: restore ? "add" : "change",
        consent: restore ? "Restore anyway" : "Update anyway",
        lines: true,
      });
    },
    [cwd, skillChange],
  );
  const onPluginAction = useCallback(
    (action: PluginAction, p: AnyPlugin) => {
      const name = isMarketplacePlugin(p) ? p.id : p.name;
      const key = pluginKey(p);
      const where = { ...(cwd ? { cwd } : {}), ...pluginRef(p) };
      if (action === "upgrade") {
        void pluginChange((h) => h.call("plugins.upgrade", where), { busy: [{ key, label: "Upgrading…" }], title: `Upgraded “${name}”`, failTitle: `Couldn't upgrade “${name}”`, change: "change", lines: true });
        return;
      }
      const linked = !isMarketplacePlugin(p) && p.linked;
      void confirmAction({
        title: `${linked ? "Unlink" : "Remove"} “${name}”?`,
        body: isMarketplacePlugin(p)
          ? `Its commands, agents, hooks, skills and MCP servers leave ${p.scope === "project" ? "this project's" : "running"} sessions.`
          : linked
            ? "omp stops loading the folder; the folder itself stays. Running sessions keep its code until they restart."
            : "Running sessions keep its code until they restart.",
        confirmLabel: linked ? "Unlink" : "Remove",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        void pluginChange((h) => h.call("plugins.remove", where), { busy: [{ key, label: "Removing…" }], title: `${linked ? "Unlinked" : "Removed"} “${name}”`, failTitle: `Couldn't remove “${name}”`, change: "remove", lines: true });
      });
    },
    [cwd, pluginChange],
  );
  const onSkillEnabled = useCallback((skill: SkillInfo, enabled: boolean) => setSkillEnabled(skill, enabled), [setSkillEnabled]);
  const onPluginEnabled = useCallback((p: AnyPlugin, enabled: boolean) => setPluginEnabled(p, enabled), [setPluginEnabled]);

  const groups = useMemo(() => (skills ? groupSkills(skills) : null), [skills]);
  const updates = useMemo(() => pendingUpdates(skills, plugins), [skills, plugins]);
  const skillCount = groups ? groups.registry.length + groups.omp.length + groups.plugins.length + groups.other.length : undefined;
  const pluginCount = plugins ? plugins.packages.length + plugins.marketplace.length : undefined;

  const pickHost = (id: string) => {
    setLastHost(id);
    navigate({ name: "plugins", hostId: id }, { replace: true });
  };
  const hostPicker = options.length > 1 && hostId && (
    <Select aria-label="Host" className={cn("h-10", mobile ? "w-full" : "w-44")} value={hostId} onValueChange={pickHost} options={options} />
  );
  const scopeOptions: SelectOption[] = [
    { value: ALL, label: "All projects", hint: "omp's user level", icon: <Globe2 /> },
    ...folders.map((f) => ({ value: f.path, label: f.label, hint: f.hint, icon: <FolderGit2 /> })),
  ];
  const ready = !!hostId && online && !q.outdated;
  const scopePicker = ready && folders.length > 0 && (
    <Select aria-label="Project" value={cwd ?? ALL} onValueChange={(v) => setFolder(hostId, v === ALL ? undefined : v)} options={scopeOptions} className={cn("h-9", mobile ? "w-full" : "w-60")} />
  );
  const allProjects = () => hostId && setFolder(hostId, undefined);
  const bothFailed = !!q.skillsError && !!q.pluginsError && !skills && !plugins;
  const working = q.running !== null;

  let body: ReactNode;
  if (!hostId) {
    body = (
      <EmptyState
        icon={<Server />}
        title="No hosts yet"
        description="Skills and plugins are set up per host. Add a host first."
        action={<Button onClick={() => navigate({ name: "hosts" })}>Add a host</Button>}
        className="mt-8"
      />
    );
  } else if (!online) {
    body = (
      <EmptyState
        icon={<Server />}
        title={`${hostName} is offline`}
        description="Skills and plugins are read from the host's omp. Connect it first."
        action={
          <Button variant="secondary" onClick={() => navigate({ name: "hosts" })}>
            Open Hosts
          </Button>
        }
        className="mt-8"
      />
    );
  } else if (q.outdated) {
    body = <OutdatedHost onRetry={q.reload} what="skills and plugins" />;
  } else if (bothFailed && q.skillsError && q.skillsError.code !== "unsupported") {
    body = <SectionError error={q.skillsError} what="skills and plugins" hostId={hostId} hostName={hostName} cwd={cwd} onRetry={q.reload} onAllProjects={allProjects} />;
  } else {
    const skillRow = (item: SkillItem) => (
      <SkillRow
        key={item.key}
        item={item}
        enabled={item.skill ? (q.pendingEnabled[skillSwitchKey(item.skill.name)] ?? item.skill.enabled) : false}
        busy={q.busy[item.key]}
        expanded={expanded.has(item.key)}
        flash={flash?.key === item.key ? flash.n : undefined}
        home={home}
        onToggle={toggle}
        onAction={onSkillAction}
        onEnabled={onSkillEnabled}
      />
    );
    const pluginRow = (p: AnyPlugin) => {
      const k = pluginKey(p);
      return (
        <PluginRow
          key={k}
          plugin={p}
          enabled={q.pendingEnabled[k] ?? p.enabled}
          busy={q.busy[k]}
          expanded={expanded.has(k)}
          flash={flash?.key === k ? flash.n : undefined}
          home={home}
          onToggle={toggle}
          onAction={onPluginAction}
          onEnabled={onPluginEnabled}
        />
      );
    };
    const note = <SessionsNote hostId={hostId} hostName={hostName} cwd={cwd} onReload={q.reloadSessions} />;
    let content: ReactNode;
    if (section === "skills") {
      content = q.skillsError ? (
        <SectionError error={q.skillsError} what="skills" hostId={hostId} hostName={hostName} cwd={cwd} onRetry={q.reload} onAllProjects={allProjects} />
      ) : !skills || !groups ? (
        <RowsSkeleton label="Loading skills" />
      ) : skillCount === 0 ? (
        <EmptyState
          icon={<Sparkles />}
          title="No skills yet"
          description="A skill tells omp how to do one kind of task your way: a folder with a SKILL.md in ~/.omp/agent/skills, a package from the registry, or one that comes with a plugin."
          action={
            <Button
              variant="primary"
              icon={<Package />}
              onClick={() => {
                setMoreTab("registry");
                setSection("more");
              }}
            >
              Find skills
            </Button>
          }
          className="mt-4"
        />
      ) : (
        <div className="flex flex-col gap-5">
          <Warnings warnings={skills.warnings} />
          {SKILL_GROUPS.map(
            (g) =>
              groups[g.id].length > 0 && (
                <section key={g.id} aria-label={g.title} className="flex flex-col gap-2">
                  <GroupHeader title={g.title} count={groups[g.id].length} detail={!mobile && g.detail} />
                  {groups[g.id].map(skillRow)}
                </section>
              ),
          )}
          {note}
        </div>
      );
    } else if (section === "plugins") {
      content = q.pluginsError ? (
        <SectionError error={q.pluginsError} what="plugins" hostId={hostId} hostName={hostName} cwd={cwd} onRetry={q.reload} onAllProjects={allProjects} />
      ) : !plugins ? (
        <RowsSkeleton label="Loading plugins" />
      ) : pluginCount === 0 ? (
        <EmptyState
          icon={<Puzzle />}
          title="No plugins yet"
          description="Plugins add commands, agents, hooks, skills and MCP servers to omp: from a marketplace (Claude Code's format), npm, git or a folder."
          action={
            <Button
              variant="primary"
              icon={<Store />}
              onClick={() => {
                setMoreTab("marketplaces");
                setSection("more");
              }}
            >
              Browse marketplaces
            </Button>
          }
          className="mt-4"
        />
      ) : (
        <div className="flex flex-col gap-5">
          <Warnings warnings={plugins.warnings} />
          {plugins.marketplace.length > 0 && (
            <section aria-label="From marketplaces" className="flex flex-col gap-2">
              <GroupHeader title="From marketplaces" count={plugins.marketplace.length} detail={!mobile && "Claude Code–format plugins"} />
              {plugins.marketplace.map(pluginRow)}
            </section>
          )}
          {plugins.packages.length > 0 && (
            <section aria-label="Packages" className="flex flex-col gap-2">
              <GroupHeader title="Packages" count={plugins.packages.length} detail={!mobile && "npm, git and linked folders · every project"} />
              {plugins.packages.map(pluginRow)}
            </section>
          )}
          {note}
        </div>
      );
    } else {
      content = <GetMore hostId={hostId} cwd={cwd} projectName={projectName} q={q} tab={moreTab} onTab={setMoreTab} onShow={show} />;
    }
    const sections: { id: PluginsSection; label: string; icon: ReactNode; count?: number; updates?: number }[] = [
      { id: "skills", label: "Skills", icon: <Sparkles />, count: skillCount, updates: updates.skills.length },
      { id: "plugins", label: "Plugins", icon: <Puzzle />, count: pluginCount, updates: updates.plugins.length },
      { id: "more", label: "Get more", icon: <Store /> },
    ];
    const nav = (
      <nav aria-label="Skills and plugins sections" className={cn(mobile ? "-mx-3 flex gap-1 overflow-x-auto px-3 pb-1 no-scrollbar" : "sticky top-4 flex flex-col gap-0.5 self-start")}>
        {sections.map((s) => (
          <SectionButton key={s.id} label={s.label} icon={s.icon} count={s.count} updates={s.updates} active={section === s.id} compact={mobile} onClick={() => setSection(s.id)} />
        ))}
      </nav>
    );
    body = mobile ? (
      <>
        {nav}
        {content}
      </>
    ) : (
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-6">
        {nav}
        <div className="flex min-w-0 flex-col gap-5">{content}</div>
      </div>
    );
  }

  const toolbar = ready && (scopePicker || skills) && (
    <div className={cn("flex items-center gap-3", mobile && "flex-col items-stretch gap-2")}>
      {scopePicker}
      {skills && (
        <div className={cn("flex min-w-0 items-center gap-2", !mobile && "ml-auto")}>
          <StatusLine checking={q.checkingUpdates} checkedAt={skills.updatesCheckedAt} ompVersion={skills.ompVersion ?? plugins?.ompVersion} />
        </div>
      )}
    </div>
  );

  const checkButton = (
    <Button variant="secondary" icon={<RefreshCw />} loading={q.running === "check"} disabled={working || !ready || (!skills && !plugins)} onClick={q.checkUpdates}>
      Check for updates
    </Button>
  );
  const updateAllButton = updates.total > 0 && (
    <Button variant="primary" icon={<ArrowUpCircle />} loading={q.running === "updateAll"} disabled={working} onClick={q.updateAll}>
      Update all ({updates.total})
    </Button>
  );

  if (mobile) {
    return (
      <div className="flex min-h-full flex-col">
        <MobileHeader
          title={VIEWS.plugins.label}
          subtitle={hostName}
          back
          actions={
            ready ? (
              <>
                <IconButton label="Check for updates" size="lg" onClick={q.checkUpdates} disabled={working || (!skills && !plugins)}>
                  {q.running === "check" ? <Spinner size={18} /> : <RefreshCw />}
                </IconButton>
                {updates.total > 0 && (
                  <IconButton label={`Update all (${updates.total})`} size="lg" variant="primary" onClick={q.updateAll} disabled={working} badge={updates.total}>
                    {q.running === "updateAll" ? <Spinner size={18} /> : <ArrowUpCircle />}
                  </IconButton>
                )}
              </>
            ) : undefined
          }
        />
        <OmpAreaFrame current="plugins" hostId={hostId} mobile>
          {hostPicker}
          {toolbar}
          {body}
        </OmpAreaFrame>
      </div>
    );
  }

  return (
    <OmpAreaFrame current="plugins" hostId={hostId} mobile={false}>
      <PageHeader
        kicker={
          <span className="inline-flex items-center gap-1.5">
            <Puzzle className="size-3" /> {hostName || "Host"}
          </span>
        }
        title={VIEWS.plugins.label}
        description="What omp sessions on this host load: skills, plugins from marketplaces, npm and git. Install, update, switch on or off."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {hostPicker}
            {ready && (
              <Button variant="ghost" icon={<RotateCw />} onClick={q.reloadSessions} title="Run /reload-plugins in the running omp sessions">
                Reload sessions
              </Button>
            )}
            {ready && checkButton}
            {ready && updateAllButton}
          </div>
        }
      />
      {toolbar}
      {body}
    </OmpAreaFrame>
  );
}
