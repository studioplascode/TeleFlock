import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { apiError, core, type HostClient, navigate, toApiError, useHosts } from "@/core";
import type { ApiError, McpReload, PluginList, PluginsChanged, SkillInfo, SkillList, SkillsChanged } from "@/core/gen";
import { type ToastInput, toast } from "@/design";
import { type AnswerKind, AnswerOrder } from "@/features/mcp/answers";
import { plural, type ReloadChange, reloadNote } from "@/features/mcp/model";
import { toastReload } from "@/features/mcp/useMcp";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { type AnyPlugin, changesLine, errorLine, isMarketplacePlugin, mergeReload, parseScriptListing, pendingUpdates, pluginKey, pluginRef, registryKey, sharePluginList, shareSkillList, updatesText } from "./model";
import { ScriptsConsent } from "./ScriptsConsent";

/** "Ask the registry once after the first list": the same host and folder isn't asked again for this long. */
const UPDATE_CHECK_EVERY_MS = 10 * 60_000;
/** Host + folder → when this device last asked the registry (device clock). */
const updateChecks = new Map<string, number>();

/** A row or button showing that its change runs ("Updating…"). */
export interface Busy {
  key: string;
  label: string;
}

export interface ChangeOptions {
  /** Rows or buttons the change runs on: they show their label meanwhile, the rest of the page stays usable. */
  busy?: readonly Busy[];
  /** The toast's title once it worked ("Installed “@acme/changelog”"). */
  title: string;
  /** What it does to running sessions, for the toast's wording. */
  change: ReloadChange;
  /** The toast's title when it fails ("Couldn't install “…”"). */
  failTitle: string;
  /** Skills: a version that ships scripts asks first (`scripts_need_consent`), with this as the dialog's button. */
  consent?: string;
  /** Errors the caller shows itself (a form, under its input): the promise rejects with them instead of a toast. */
  inline?(e: ApiError): boolean;
  /** Include omp's own lines about the change in the toast (installs, updates, removals; not switches). */
  lines?: boolean;
  /** No success toast: the caller sums several changes up in one. */
  quiet?: boolean;
  /** Plugin changes that can't change the skills (marketplace sources): no fresh skill list after them. */
  skillsUnchanged?: boolean;
  /** The toast's action ("Show"), from the answer. */
  action?(changed: SkillsChanged | PluginsChanged): ToastInput["action"];
}

export interface PluginsQuery {
  skills?: SkillList;
  plugins?: PluginList;
  skillsError?: ApiError;
  pluginsError?: ApiError;
  /** A read is in flight (first load, reload). */
  loading: boolean;
  /** The host's tf-hostd predates skills and plugins (`unknown_method`). */
  outdated: boolean;
  /** The registry is asked about newer versions (after the first list, or "Check for updates"). */
  checkingUpdates: boolean;
  /** "Check for updates" or "Update all" runs (header buttons). */
  running: "check" | "updateAll" | null;
  /** Rows and buttons whose change runs: key → what it shows ("Updating…"). */
  busy: Readonly<Record<string, string>>;
  /** Switches whose change is on its way: `skill:<name>` / plugin key → requested state. */
  pendingEnabled: Readonly<Record<string, boolean>>;
  reload(): void;
  skillChange(run: (host: HostClient, allowScripts: boolean) => Promise<SkillsChanged>, o: ChangeOptions): Promise<SkillsChanged | null>;
  pluginChange(run: (host: HostClient) => Promise<PluginsChanged>, o: ChangeOptions): Promise<PluginsChanged | null>;
  /** Optimistic switch: flips at once, rolls back with a toast when the host refuses. */
  setSkillEnabled(skill: SkillInfo, enabled: boolean): void;
  setPluginEnabled(plugin: AnyPlugin, enabled: boolean): void;
  /** Registry updates and fresh marketplace catalogs; one toast says what is new. */
  checkUpdates(): void;
  /** Every registry skill with an update (one at a time, each asking about its scripts when it ships some), then every marketplace plugin with one. */
  updateAll(): void;
  /** `plugins.reload`: reload running sessions now. */
  reloadSessions(): void;
}

interface ListState<T> {
  key: string | null;
  data?: T;
  error?: ApiError;
  loading: boolean;
}

/** The pending switch key of a skill: omp switches skills by name. */
export function skillSwitchKey(name: string): string {
  return `skill:${name}`;
}

function failToast(title: string, e: ApiError, hostName: string, retry?: () => void): void {
  if (e.code === "unsupported") {
    toast({ title, description: e.hint ? errorLine(e) : `${e.message} — update omp on ${hostName}.`, status: "error", duration: 8000, action: { label: "Update omp", onClick: () => navigate({ name: "hosts" }) } });
  } else {
    // `busy` (another change runs on the host) and lost connections can simply be tried again.
    const again = e.code === "busy" || e.retryable;
    toast({ title, description: errorLine(e), status: "error", duration: 8000, action: again && retry ? { label: "Try again", onClick: retry } : undefined });
  }
}

/** The dialog before installing a version that ships scripts: what they are and with whose rights they run. */
function askScripts(e: ApiError, verb: string, hostName: string): Promise<boolean> {
  const listing = parseScriptListing(e.message);
  const what = listing[0]?.title.replace(/ ships scripts$/, "") || "This skill";
  return confirmAction({ title: `${what} ships scripts`, body: createElement(ScriptsConsent, { listing, hostName }), confirmLabel: verb, danger: true });
}

function failed<T>(key: string, e: unknown): (s: ListState<T>) => ListState<T> {
  return (s) => (s.key === key ? { ...s, error: toApiError(e), loading: false } : { key, error: toApiError(e), loading: false });
}

/**
 * `skills.list` and `plugins.list` of one host and folder (`cwd` absent: user level), the registry's
 * update check once after the first list, and every change: busy rows, the scripts consent, one
 * quiet toast, optimistic switches. Answers are ordered per list by {@link AnswerOrder}: a slow
 * answer never replaces a newer one, and a change's (or the update check's) answer that lost to a
 * newer read is followed by a fresh read.
 */
export function usePlugins(hostId: string | undefined, cwd: string | undefined, hostName: string): PluginsQuery {
  const online = useHosts((h) => (hostId ? h.status[hostId]?.phase === "online" : false));
  const key = hostId ? `${hostId}\u0000${cwd ?? ""}` : null;
  const [skills, setSkills] = useState<ListState<SkillList>>({ key: null, loading: false });
  const [plugins, setPlugins] = useState<ListState<PluginList>>({ key: null, loading: false });
  const [skillsRequest, setSkillsRequest] = useState(0);
  const [pluginsRequest, setPluginsRequest] = useState(0);
  const [checking, setChecking] = useState<string | null>(null);
  const [running, setRunning] = useState<PluginsQuery["running"]>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const orders = useRef({ skills: new AnswerOrder(), plugins: new AnswerOrder() });
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const rereadSkills = useCallback(() => setSkillsRequest((n) => n + 1), []);
  const rereadPlugins = useCallback(() => setPluginsRequest((n) => n + 1), []);
  const reload = useCallback(() => {
    rereadSkills();
    rereadPlugins();
  }, [rereadSkills, rereadPlugins]);

  /** Shows a skill list unless a newer answer is shown or the page moved on; true when it lost and a fresh read should follow. */
  const acceptSkills = useCallback((k: string, n: number, kind: AnswerKind, list: SkillList): boolean => {
    if (keyRef.current !== k) return false;
    const { show, next } = orders.current.skills.answer(n, kind, false);
    if (show) setSkills((s) => ({ key: k, data: shareSkillList(s.key === k ? s.data : undefined, list), loading: false }));
    return next === "read";
  }, []);
  const acceptPlugins = useCallback((k: string, n: number, kind: AnswerKind, list: PluginList): boolean => {
    if (keyRef.current !== k) return false;
    const { show, next } = orders.current.plugins.answer(n, kind, false);
    if (show) setPlugins((s) => ({ key: k, data: sharePluginList(s.key === k ? s.data : undefined, list), loading: false }));
    return next === "read";
  }, []);

  // Read on open, on host / folder change, when the host comes online, on reload. `skills.list`
  // runs a throwaway omp on the host (1.5–3 s); `plugins.list` reads files.
  useEffect(() => {
    if (!key || !hostId || !online) return;
    let live = true;
    const n = orders.current.skills.start();
    setSkills((s) => ({ key, data: s.key === key ? s.data : undefined, loading: true }));
    core
      .host(hostId)
      .call("skills.list", cwd ? { cwd } : {})
      .then(
        (list) => {
          if (!live) return;
          acceptSkills(key, n, "read", list);
          setSkills((s) => (s.key === key && s.loading ? { ...s, loading: false } : s));
        },
        (e: unknown) => live && setSkills(failed<SkillList>(key, e)),
      );
    return () => {
      live = false;
    };
  }, [key, hostId, cwd, online, skillsRequest, acceptSkills]);

  useEffect(() => {
    if (!key || !hostId || !online) return;
    let live = true;
    const n = orders.current.plugins.start();
    setPlugins((s) => ({ key, data: s.key === key ? s.data : undefined, loading: true }));
    core
      .host(hostId)
      .call("plugins.list", cwd ? { cwd } : {})
      .then(
        (list) => {
          if (!live) return;
          acceptPlugins(key, n, "read", list);
          setPlugins((s) => (s.key === key && s.loading ? { ...s, loading: false } : s));
        },
        (e: unknown) => live && setPlugins(failed<PluginList>(key, e)),
      );
    return () => {
      live = false;
    };
  }, [key, hostId, cwd, online, pluginsRequest, acceptPlugins]);

  /** `skills.list { updates: true }` (network, up to ~10 s on top); its answer is never just dropped. */
  const askRegistry = useCallback(
    (k: string, id: string): Promise<SkillList> => {
      updateChecks.set(k, Date.now());
      setChecking(k);
      const n = orders.current.skills.start();
      return core
        .host(id)
        .call("skills.list", { ...(cwd ? { cwd } : {}), updates: true })
        .then((list) => {
          if (acceptSkills(k, n, "change", list)) rereadSkills();
          return list;
        })
        .finally(() => setChecking((c) => (c === k ? null : c)));
    },
    [cwd, acceptSkills, rereadSkills],
  );

  // The registry is asked once after the first list of a host and folder (not again for 10 min).
  const firstShown = skills.key === key && !!skills.data;
  useEffect(() => {
    if (!firstShown || !key || !hostId || !online) return;
    const last = updateChecks.get(key);
    if (last !== undefined && Date.now() - last < UPDATE_CHECK_EVERY_MS) return;
    askRegistry(key, hostId).catch(() => {
      // A failed check leaves the list as it was; "Check for updates" says why.
      updateChecks.delete(key);
    });
  }, [firstShown, key, hostId, online, askRegistry]);

  const markBusy = useCallback((items: readonly Busy[] | undefined, on: boolean) => {
    if (!items?.length) return;
    setBusy((b) => {
      const next = { ...b };
      for (const i of items) {
        if (on) next[i.key] = i.label;
        else delete next[i.key];
      }
      return next;
    });
  }, []);

  const toastChanged = useCallback((o: ChangeOptions, changed: SkillsChanged | PluginsChanged) => {
    if (o.quiet) return;
    const lines = [changed.note, o.lines ? changesLine(changed.changes) : undefined];
    const action = o.action?.(changed);
    // A change always says that it worked (installs take a while), also when no session ran.
    if (!reloadNote(changed.reload, o.change) && changed.reload.errors.length === 0 && !lines.some(Boolean)) toast({ title: o.title, duration: 3500, action });
    else toastReload(o.title, changed, o.change, { lines, action });
  }, []);

  const skillChange = useCallback(
    async (run: (host: HostClient, allowScripts: boolean) => Promise<SkillsChanged>, o: ChangeOptions): Promise<SkillsChanged | null> => {
      if (!hostId || !key) return Promise.reject(apiError("not_connected", "No host selected"));
      const host = core.host(hostId);
      const n = orders.current.skills.start();
      markBusy(o.busy, true);
      try {
        let changed: SkillsChanged;
        try {
          changed = await run(host, false);
        } catch (raw) {
          const e = toApiError(raw);
          if (e.code !== "scripts_need_consent" || !o.consent) throw raw;
          markBusy(o.busy, false);
          if (!(await askScripts(e, o.consent, hostName))) return null;
          markBusy(o.busy, true);
          changed = await run(host, true);
        }
        if (acceptSkills(key, n, "change", changed.list)) rereadSkills();
        toastChanged(o, changed);
        return changed;
      } catch (raw) {
        const e = toApiError(raw);
        if (o.inline?.(e)) throw e;
        failToast(o.failTitle, e, hostName, () => void skillChange(run, o));
        return null;
      } finally {
        markBusy(o.busy, false);
      }
    },
    [hostId, key, hostName, acceptSkills, rereadSkills, markBusy, toastChanged],
  );

  const pluginChange = useCallback(
    async (run: (host: HostClient) => Promise<PluginsChanged>, o: ChangeOptions): Promise<PluginsChanged | null> => {
      if (!hostId || !key) return Promise.reject(apiError("not_connected", "No host selected"));
      const n = orders.current.plugins.start();
      markBusy(o.busy, true);
      try {
        const changed = await run(core.host(hostId));
        if (acceptPlugins(key, n, "change", changed.list)) rereadPlugins();
        // Plugins bring skills: the skill list changes with them.
        if (!o.skillsUnchanged) rereadSkills();
        toastChanged(o, changed);
        return changed;
      } catch (raw) {
        const e = toApiError(raw);
        if (o.inline?.(e)) throw e;
        failToast(o.failTitle, e, hostName, () => void pluginChange(run, o));
        return null;
      } finally {
        markBusy(o.busy, false);
      }
    },
    [hostId, key, hostName, acceptPlugins, rereadPlugins, rereadSkills, markBusy, toastChanged],
  );

  const settle = useCallback(
    (k: string) =>
      setPendingEnabled((p) => {
        const { [k]: _done, ...rest } = p;
        return rest;
      }),
    [],
  );

  const setSkillEnabled = useCallback(
    (skill: SkillInfo, enabled: boolean) => {
      const k = skillSwitchKey(skill.name);
      setPendingEnabled((p) => ({ ...p, [k]: enabled }));
      void skillChange((h) => h.call("skills.setEnabled", { ...(cwd ? { cwd } : {}), name: skill.name, enabled }), {
        title: `Switched “${skill.name}” ${enabled ? "on" : "off"}`,
        failTitle: `Couldn't switch “${skill.name}” ${enabled ? "on" : "off"}`,
        change: enabled ? "add" : "remove",
      }).finally(() => settle(k));
    },
    [cwd, skillChange, settle],
  );

  const setPluginEnabled = useCallback(
    (plugin: AnyPlugin, enabled: boolean) => {
      const k = pluginKey(plugin);
      const name = isMarketplacePlugin(plugin) ? plugin.id : plugin.name;
      setPendingEnabled((p) => ({ ...p, [k]: enabled }));
      void pluginChange((h) => h.call("plugins.setEnabled", { ...(cwd ? { cwd } : {}), ...pluginRef(plugin), enabled }), {
        busy: [{ key: k, label: enabled ? "Switching on…" : "Switching off…" }],
        title: `Switched “${name}” ${enabled ? "on" : "off"}`,
        failTitle: `Couldn't switch “${name}” ${enabled ? "on" : "off"}`,
        change: enabled ? "add" : "remove",
      }).finally(() => settle(k));
    },
    [cwd, pluginChange, settle],
  );

  const shownPlugins = plugins.key === key ? plugins.data : undefined;
  const shownSkills = skills.key === key ? skills.data : undefined;

  const checkUpdates = useCallback(() => {
    if (!hostId || !key) return;
    setRunning("check");
    let catalogs: Promise<PluginsChanged | null> = Promise.resolve(null);
    if (shownPlugins?.marketplaces.length) {
      const n = orders.current.plugins.start();
      catalogs = core
        .host(hostId)
        .call("plugins.marketplaceUpdate", cwd ? { cwd } : {})
        .then((changed) => {
          if (acceptPlugins(key, n, "change", changed.list)) rereadPlugins();
          return changed;
        });
    }
    void Promise.allSettled([askRegistry(key, hostId), catalogs]).then(([s, p]) => {
      setRunning(null);
      if (keyRef.current !== key) return;
      const problems = [s.status === "rejected" && `Couldn't ask the registry: ${errorLine(toApiError(s.reason))}`, p.status === "rejected" && `Couldn't refresh the marketplaces: ${errorLine(toApiError(p.reason))}`].filter(
        (x): x is string => !!x,
      );
      const list = s.status === "fulfilled" ? s.value : undefined;
      const unasked = list?.registry.filter((r) => r.updateError).length ?? 0;
      if (unasked > 0) problems.unshift(`The registry couldn't be asked about ${plural(unasked, "skill")}.`);
      const text = updatesText(pendingUpdates(list, p.status === "fulfilled" ? (p.value?.list ?? shownPlugins) : shownPlugins));
      const description = problems.join(" ") || undefined;
      if (s.status === "rejected" && p.status === "rejected") toast({ title: "Couldn't check for updates", description, status: "error", duration: 8000 });
      else if (text) toast({ title: `${text.charAt(0).toUpperCase()}${text.slice(1)} available`, description, status: "review", duration: 6000 });
      else toast({ title: "Skills and plugins are up to date", description, status: problems.length ? "error" : "done", duration: problems.length ? 8000 : 3000 });
    });
  }, [hostId, key, cwd, shownPlugins, askRegistry, acceptPlugins, rereadPlugins]);

  const updateAll = useCallback(() => {
    if (!hostId || !key) return;
    const todo = pendingUpdates(shownSkills, shownPlugins);
    if (todo.total === 0) return;
    setRunning("updateAll");
    void (async () => {
      let sum: McpReload | undefined;
      const changes: string[] = [];
      const notes: string[] = [];
      let skillsDone = 0;
      let pluginsDone = 0;
      for (const r of todo.skills) {
        const changed = await skillChange((h, allowScripts) => h.call("skills.update", { ...(cwd ? { cwd } : {}), id: r.id, scope: r.scope, ...(allowScripts ? { allowScripts } : {}) }), {
          busy: [{ key: registryKey(r), label: "Updating…" }],
          title: `Updated “${r.id}”`,
          failTitle: `Couldn't update “${r.id}”`,
          change: "change",
          consent: "Update anyway",
          quiet: true,
        });
        if (!changed) continue;
        skillsDone += 1;
        sum = mergeReload(sum, changed.reload);
        changes.push(...changed.changes);
      }
      if (todo.plugins.length > 0) {
        const changed = await pluginChange((h) => h.call("plugins.upgrade", cwd ? { cwd } : {}), {
          busy: todo.plugins.map((p) => ({ key: pluginKey(p), label: "Upgrading…" })),
          title: "Upgraded plugins",
          failTitle: `Couldn't upgrade ${plural(todo.plugins.length, "plugin")}`,
          change: "change",
          quiet: true,
        });
        if (changed) {
          pluginsDone = todo.plugins.length;
          sum = mergeReload(sum, changed.reload);
          changes.push(...changed.changes);
          if (changed.note) notes.push(changed.note);
        }
      }
      setRunning(null);
      if (!sum) return;
      const what = [skillsDone > 0 && plural(skillsDone, "skill"), pluginsDone > 0 && plural(pluginsDone, "plugin")].filter(Boolean).join(" and ");
      toastReload(`Updated ${what}`, { reload: sum }, "change", { lines: [...notes, changesLine(changes)] });
    })();
  }, [hostId, key, cwd, shownSkills, shownPlugins, skillChange, pluginChange]);

  const reloadSessions = useCallback(() => {
    if (!hostId) return;
    core
      .host(hostId)
      .call("plugins.reload", cwd ? { cwd } : {})
      .then(
        (r) => {
          if (reloadNote(r, "change") || r.errors.length) toastReload("Reloaded running sessions", { reload: r }, "change");
          else toast({ title: "No running omp sessions to reload", duration: 3000 });
        },
        (e: unknown) => failToast("Couldn't reload running sessions", toApiError(e), hostName),
      );
  }, [hostId, cwd, hostName]);

  const skillsError = skills.key === key ? skills.error : undefined;
  const pluginsError = plugins.key === key ? plugins.error : undefined;
  const loadingOf = (s: ListState<unknown>) => (s.key === key ? s.loading : !!key && online);
  return {
    skills: shownSkills,
    plugins: shownPlugins,
    skillsError,
    pluginsError,
    loading: loadingOf(skills) || loadingOf(plugins),
    outdated: skillsError?.code === "unknown_method" || pluginsError?.code === "unknown_method",
    checkingUpdates: checking !== null && checking === key,
    running,
    busy,
    pendingEnabled,
    reload,
    skillChange,
    pluginChange,
    setSkillEnabled,
    setPluginEnabled,
    checkUpdates,
    updateAll,
    reloadSessions,
  };
}
