import { Globe, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { core, useBrowser } from "@/core";
import type { BrowserClearWhat, BrowserConfig, BrowserStatus } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, cn, isAndroid, Select, Spinner, Switch } from "@/design";
import { CommitInput, Row, Section } from "@/features/settings/parts";
import { browserCall, cancelInstall, chooseOwnBrowser, clearBrowsingDataConfirmed, installEngine, ownBrowserLabel, revealProfile, startBrowser, stopBrowser } from "./actions";

type ConfigPatch = Partial<Pick<BrowserConfig, "enginePath" | "headed" | "cap">>;

const AUTO = "__auto";
const OTHER = "__other";
const CAPS = Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

/**
 * The saved browser config. `configSet` replaces it (absent fields reset), so `save` always sends
 * all three fields with the one change merged in. Not pushed by events: refetched on mount, when a
 * download ends, when the running engine changes and when a start finds an engine blocked (the
 * engines' marks, a switch to TeleFlock's own browser).
 */
function useBrowserConfig(status: BrowserStatus) {
  const [config, setConfig] = useState<BrowserConfig | null>(null);
  const latest = useRef<BrowserConfig | null>(null);
  const seq = useRef(0);
  const installing = !!status.install && !status.install.error;
  const enginePath = status.engine?.path;
  const blockedAt = status.blocked?.at;

  const apply = useCallback((c: BrowserConfig) => {
    latest.current = c;
    setConfig(c);
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const c = await core.app("browser.config", {});
      if (mine === seq.current) apply(c);
    } catch {
      // Keep what is shown; the next trigger asks again.
    }
  }, [apply]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `installing` / `enginePath` / `blockedAt` are the refetch triggers.
  useEffect(() => {
    void refresh();
  }, [refresh, installing, enginePath, blockedAt]);

  const save = useCallback(
    async (patch: ConfigPatch): Promise<boolean> => {
      const cur = latest.current;
      if (!cur) return false;
      const next = { enginePath: cur.enginePath, headed: cur.headed, cap: cur.cap, ...patch };
      const saved = await browserCall("browser.configSet", { enginePath: next.enginePath, headed: next.headed, cap: next.cap }, "Couldn't save the browser settings");
      if (!saved) return false;
      seq.current++;
      apply(saved);
      return true;
    },
    [apply],
  );

  return { config, save };
}

/** Settings → Browser: the TeleFlock Browser's engine, profile, window and agent limit. Desktop only. */
export function BrowserSettings({ index }: { index: number }) {
  const status = useBrowser();
  if (isAndroid) return null;
  return (
    <Section index={index} icon={<Globe />} title="Browser" description="Your own browser inside TeleFlock, signed in as you. Agents use it only when you let them.">
      {status ? (
        <BrowserRows status={status} />
      ) : (
        <Row label="No browser in this app core" description="This TeleFlock app core came before the browser (it arrived with 0.9.0). Update TeleFlock to use it.">
          {null}
        </Row>
      )}
    </Section>
  );
}

function BrowserRows({ status }: { status: BrowserStatus }) {
  const { config, save } = useBrowserConfig(status);
  return (
    <>
      <StateRow status={status} headedByDefault={config?.headed ?? false} />
      {config && (
        <>
          <EngineRow status={status} config={config} save={save} />
          <DownloadRow status={status} config={config} />
        </>
      )}
      <PathRow label="Profile" path={status.profileDir} description="Cookies, logins and history live here." action={<ShowProfile />} />
      {status.downloadDir && <PathRow label="Downloads" path={status.downloadDir} description="Where files downloaded in the browser go." />}
      {config && (
        <>
          <Row label="Open in its own window" htmlFor="tf-browser-headed" description="Start the browser in a window of its own instead of only inside TeleFlock. Some sign-ins and passkeys need it. Applies the next time the app starts it.">
            <Switch id="tf-browser-headed" label="Open in its own window" checked={config.headed} onCheckedChange={(headed) => void save({ headed })} />
          </Row>
          <Row label="Agents at once" htmlFor="tf-browser-cap" description="How many agents can use the browser together. More wait until one is detached, or until you allow them anyway.">
            <Select id="tf-browser-cap" className="w-24" value={String(config.cap)} onValueChange={(v) => void save({ cap: Number(v) })} options={CAPS} />
          </Row>
        </>
      )}
      <ClearRow />
    </>
  );
}

function StateRow({ status, headedByDefault }: { status: BrowserStatus; headedByDefault: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const { state, engine, blocked } = status;
  // The organization's policy blocked the engine at the last start: what is left (the core's message).
  const block = blocked && (state === "error" || (state === "running" && blocked.fallback === "switched")) ? blocked : undefined;
  const installing = !!status.install && !status.install.error;
  const label =
    state === "off"
      ? "Off"
      : state === "starting"
        ? "Starting…"
        : state === "running"
          ? status.headed
            ? "Running in its own window"
            : "Running"
          : block
            ? "Blocked by your organization"
            : `Stopped${status.message ? `: ${status.message}` : ""}`;
  const engineText = engine ? `${engine.builtin ? "TeleFlock's browser, Chrome for Testing" : engine.name}${engine.version ? ` ${engine.version}` : ""}` : "No browser engine found yet. Pick or download one below.";
  const description = block ? (
    <>
      {state === "running" && <span className="block">{engineText}</span>}
      <span className="block">{status.message}</span>
    </>
  ) : (
    engineText
  );
  return (
    <Row label={label} description={description}>
      {state === "starting" && <Spinner size={16} label="Starting" />}
      {state === "off" && (
        <>
          <Button variant="primary" size="sm" loading={busy} onClick={() => void run(() => startBrowser())}>
            Start
          </Button>
          {!headedByDefault && (
            <Button size="sm" disabled={busy} onClick={() => void run(() => startBrowser(true))}>
              Start in its own window
            </Button>
          )}
        </>
      )}
      {(state === "running" || state === "starting") && (
        <Button size="sm" loading={busy} onClick={() => void run(stopBrowser)}>
          Stop
        </Button>
      )}
      {state === "error" && block?.fallback === "offer" && !installing && (
        <Button variant="primary" size="sm" loading={busy} onClick={() => void run(chooseOwnBrowser)}>
          {ownBrowserLabel(block.download)}
        </Button>
      )}
      {state === "error" && block?.fallback !== "offer" && (
        <Button variant="primary" size="sm" loading={busy} onClick={() => void run(() => startBrowser())}>
          Start it again
        </Button>
      )}
    </Row>
  );
}

function EngineRow({ status, config, save }: { status: BrowserStatus; config: BrowserConfig; save: (p: ConfigPatch) => Promise<boolean> }) {
  const { engines, enginePath } = config;
  const known = enginePath != null && engines.some((e) => e.path === enginePath);
  const [other, setOther] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const custom = enginePath != null && !known;
  const picked = other || custom ? OTHER : enginePath == null ? AUTO : enginePath;
  // As the core's Automatic picks: the first one found that the organization's policy didn't block.
  const first = engines.find((e) => !e.blocked) ?? engines[0];
  const effective = enginePath ?? first?.path;
  const effectiveBlocked = engines.some((e) => e.path === effective && e.blocked) || (status.engine?.path === effective && status.engine?.blocked === true);
  const someBlocked = engines.some((e) => e.blocked);

  const options = [
    {
      value: AUTO,
      label: first ? `Automatic (${first.builtin ? "TeleFlock's browser" : first.name})` : "Automatic",
      hint: first ? (someBlocked ? "The first one found that isn't blocked" : "The first one found") : "No engine found",
    },
    ...engines.map((e) => ({
      value: e.path,
      label: e.builtin ? "TeleFlock's browser" : e.name,
      hint: e.blocked ? "Blocked by your organization" : e.builtin ? `Chrome for Testing${e.version ? ` ${e.version}` : ""}` : (e.version ?? e.path),
    })),
    { value: OTHER, label: "Other program…", hint: "Any Chromium-based browser" },
  ];

  const choose = async (v: string) => {
    if (v === OTHER) {
      setOther(true);
      return;
    }
    setOther(false);
    await save({ enginePath: v === AUTO ? undefined : v });
  };

  const commitPath = async (v: string) => {
    const path = v.trim();
    if (!(await save({ enginePath: path || undefined })) && path) return;
    if (!path) setOther(false);
  };

  const differs = status.state === "running" && effective != null && status.engine?.path !== effective;
  const restart = async () => {
    setRestarting(true);
    try {
      if (await stopBrowser()) await startBrowser(status.headed);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <Row
        label="Engine"
        htmlFor="tf-browser-engine"
        wide
        description={
          <>
            <span className="block">{differs ? "Applies when the browser restarts." : "Applies the next time the browser starts."}</span>
            {effectiveBlocked && <span className="block">Your organization blocked remote control of it when it last started; starting it tries again.</span>}
            {effective ? (
              <span className="block truncate font-mono text-2xs text-mute-2" title={effective}>
                {effective}
              </span>
            ) : (
              <span className="block">No Chromium-based browser found on this computer. Download TeleFlock's browser below or pick another program.</span>
            )}
          </>
        }
      >
        {differs && (
          <Button size="sm" loading={restarting} onClick={() => void restart()}>
            Restart now
          </Button>
        )}
        <Select id="tf-browser-engine" className="w-60" value={picked} onValueChange={(v) => void choose(v)} options={options} />
      </Row>
      {picked === OTHER && (
        <Row label="Program path" htmlFor="tf-browser-engine-path" description="The full path of a Chromium-based browser. Saved when you leave the field or press Enter." wide>
          <CommitInput id="tf-browser-engine-path" className="w-80 font-mono" value={custom ? (enginePath ?? "") : ""} placeholder="/usr/bin/chromium" onCommit={(v) => void commitPath(v)} />
        </Row>
      )}
    </>
  );
}

function DownloadRow({ status, config }: { status: BrowserStatus; config: BrowserConfig }) {
  const { download } = config;
  const install = status.install;
  const [starting, setStarting] = useState(false);
  const download_ = async () => {
    setStarting(true);
    try {
      await installEngine();
    } finally {
      setStarting(false);
    }
  };

  if (!download.available) return <Row label="TeleFlock's browser" description="There is no Chrome for Testing build for this computer. Pick an installed browser above." children={null} />;
  if (install && !install.error) {
    const pct = install.progress == null ? null : Math.max(0, Math.min(100, Math.round(install.progress)));
    return (
      <Row
        label="Downloading TeleFlock's browser"
        description={
          <span className="mt-1.5 flex items-center gap-2">
            <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="h-1.5 flex-1 overflow-hidden rounded-full bg-tile-4">
              <span className={cn("block h-full rounded-full bg-omp transition-[width] duration-300", pct == null && "w-1/4 animate-pulse")} style={pct == null ? undefined : { width: `${pct}%` }} />
            </span>
            <span className="w-9 shrink-0 text-right tabular-nums">{pct == null ? "" : `${pct}%`}</span>
          </span>
        }
      >
        <Spinner size={16} label="Downloading" />
        <Button size="sm" variant="ghost" icon={<X />} onClick={() => void cancelInstall()}>
          Cancel
        </Button>
      </Row>
    );
  }
  if (install?.error) {
    return (
      <Row label="Couldn't download TeleFlock's browser" description={install.error}>
        <Button size="sm" loading={starting} onClick={() => void download_()}>
          Retry
        </Button>
      </Row>
    );
  }
  if (download.installed) return <Row label="TeleFlock's browser is downloaded" description={`Chrome for Testing ${download.version}, in the engine list above.`} children={null} />;
  return (
    <Row
      label="TeleFlock's browser"
      description={`Chrome for Testing ${download.version}, a browser made for automation that TeleFlock keeps: for when your organization blocks remote control of your browser, or you have none. ${download.size != null ? formatBytes(download.size) : "About 200 MB"}; it appears in the engine list once downloaded.`}
    >
      <Button size="sm" loading={starting} onClick={() => void download_()}>
        Download
      </Button>
    </Row>
  );
}

function PathRow({ label, path, description, action }: { label: string; path: string; description: string; action?: React.ReactNode }) {
  return (
    <Row
      label={label}
      description={
        <>
          <span className="block">{description}</span>
          <span className="block truncate font-mono text-2xs text-mute-2" title={path}>
            {path}
          </span>
        </>
      }
    >
      {action}
    </Row>
  );
}

function ShowProfile() {
  return (
    <Button size="sm" onClick={() => void revealProfile()}>
      Show in folder
    </Button>
  );
}

function ClearRow() {
  const [busy, setBusy] = useState<BrowserClearWhat | null>(null);
  const clear = async (what: BrowserClearWhat) => {
    setBusy(what);
    try {
      await clearBrowsingDataConfirmed(what);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Row label="Clear browsing data" description="Cookies sign you out of every site here. The cache is only cached files; logins stay. Everything removes logins, history, site data and settings." wide>
      <Button size="sm" loading={busy === "cookies"} disabled={busy != null} onClick={() => void clear("cookies")}>
        Cookies
      </Button>
      <Button size="sm" loading={busy === "cache"} disabled={busy != null} onClick={() => void clear("cache")}>
        Cache
      </Button>
      <Button variant="danger" size="sm" loading={busy === "everything"} disabled={busy != null} onClick={() => void clear("everything")}>
        Everything
      </Button>
    </Row>
  );
}
