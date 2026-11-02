import { AppWindow, Download, Globe, Play, Plus, RotateCw, Settings2, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { navigate, parseAgentKey, useAgent, useBrowser, useHosts } from "@/core";
import type { BrowserStatus } from "@/core/gen";
import { Button, cn, isAndroid, Spinner, toast, useNow } from "@/design";
import { useMultiHost } from "@/features/hosts/HostBadge";
import { browserCall, startBrowser } from "./actions";
import { AgentBar } from "./AgentBar";
import { browserController, type Surface, useBrowserUi } from "./controller";
import { Downloads } from "./Downloads";
import { type ChromeAction, nextZoom } from "./input";
import { groupTabs, ownerOf, userDrives } from "./owners";
import { ChooserBar, CrashedNotice, DialogOverlay, WatchOnly } from "./PageOverlays";
import { TabStrip } from "./TabStrip";
import { Toolbar } from "./Toolbar";
import { Viewport } from "./Viewport";
// Session recording: its Record control joins the toolbar.
import "@/features/recording";

export type PanelMode = "split" | "page" | "fullscreen";

interface BrowserPanelProps {
  mode: PanelMode;
  /** Opened beside this agent's session: the panel offers "Let <agent> use my browser". */
  agentKey?: string;
  fullscreen: boolean;
  onFullscreen(): void;
  className?: string;
}

/**
 * The TeleFlock Browser: tabs grouped by owner, the toolbar, who can control it, the page, and
 * downloads; or what it takes to get it running.
 */
export function BrowserPanel({ mode, agentKey, fullscreen, onFullscreen, className }: BrowserPanelProps) {
  const status = useBrowser();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(t);
  }, []);
  let body;
  if (isAndroid) body = <Notice icon={<Globe />} title="The browser runs on a computer" text="TeleFlock's browser runs on a Windows, macOS or Linux computer with TeleFlock. Agents ask you there, and you can answer their requests here." />;
  else if (!status) body = waited ? <Notice icon={<Globe />} title="No browser in this TeleFlock" text="This TeleFlock app core has no browser (it came with 0.9.0). Update the app, or open TeleFlock on a computer where it is up to date." /> : <Loading text="Looking for the browser…" />;
  else if (status.state === "running") body = <Running status={status} mode={mode} agentKey={agentKey} fullscreen={fullscreen} onFullscreen={onFullscreen} />;
  else body = <NotRunning status={status} />;
  return <div className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-tile-1", className)}>{body}</div>;
}

function Running({ status, mode, agentKey, fullscreen, onFullscreen }: { status: BrowserStatus } & Omit<BrowserPanelProps, "className">) {
  const ctl = browserController();
  const phase = useBrowserUi((s) => s.phase);
  const error = useBrowserUi((s) => s.error);
  const tabs = useBrowserUi((s) => s.tabs);
  const dialogs = useBrowserUi((s) => s.dialogs);
  const chooser = useBrowserUi((s) => s.chooser);
  const now = useNow(status.attachments.length > 0 ? 1000 : null);
  const profiles = useHosts((h) => h.profiles);
  const multiHost = useMultiHost();
  const hostName = (hostId: string) => (multiHost ? (profiles.find((p) => p.id === hostId)?.name ?? hostId) : null);
  const besideKey = agentKey ?? "";
  const besideAgent = useAgent(besideKey);
  const beside = besideAgent && agentKey ? { ...parseAgentKey(agentKey), name: besideAgent.name } : null;
  const surface = useRef<Surface | null>(null);
  const compact = mode === "split";

  useEffect(() => {
    const s = ctl.addSurface();
    surface.current = s;
    return () => {
      s.release();
      surface.current = null;
    };
  }, [ctl]);

  const groups = groupTabs(tabs, status, status.attachments.length > 0 ? now : 0);
  const active = tabs.active ? tabs.byId[tabs.active] : undefined;
  const owner = ownerOf(status.tabs, active?.id ?? "");
  const drives = !!active && userDrives(owner);
  const dialog = active ? dialogs[active.id] : undefined;
  const zoom = useBrowserUi((s) => (active ? (s.zoom[active.id] ?? 1) : 1));
  const stale = useBrowserUi((s) => !!active && s.staleFrame === active.id);

  const onChrome = (action: ChromeAction) => {
    const id = active?.id;
    switch (action) {
      case "focusAddress":
        ctl.focusAddress();
        break;
      case "newTab":
        void ctl.newTab();
        break;
      case "closeTab":
        if (id) ctl.closeTab(id);
        break;
      case "reopenTab":
        ctl.reopenClosed();
        break;
      case "nextTab":
        ctl.cycle(1);
        break;
      case "prevTab":
        ctl.cycle(-1);
        break;
      case "reload":
      case "hardReload":
        if (id) ctl.reload(id, action === "hardReload");
        break;
      case "back":
      case "forward":
        if (id) void ctl.history(id, action === "back" ? -1 : 1);
        break;
      case "zoomIn":
      case "zoomOut":
        if (id && !status.headed) ctl.zoom(id, nextZoom(zoom, action === "zoomIn" ? 1 : -1));
        break;
      case "zoomReset":
        if (id) ctl.zoom(id, 1);
        break;
      case "fullscreen":
        onFullscreen();
        break;
      case "devtools":
        toast({ title: "No developer tools in the panel", description: "Open the browser in its own window (the ⋯ menu) to use Chrome's developer tools." });
        break;
    }
  };

  return (
    <>
      {status.headed && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-tile-2 px-3 text-[13px] text-ink-2">
          <AppWindow className="size-4 shrink-0 text-mute" />
          <span className="min-w-0 flex-1 truncate">The browser is open in its own window; this panel mirrors it.</span>
          <Button size="sm" variant="ghost" onClick={() => void startBrowser(false)}>
            Show it only here
          </Button>
        </div>
      )}
      <TabStrip groups={groups} active={tabs.active} hostName={hostName} compact={compact} />
      <Toolbar tab={active ?? null} owner={owner} drives={drives} headed={status.headed} compact={compact} attachments={status.attachments} fullscreen={fullscreen} onFullscreen={onFullscreen} />
      <AgentBar status={status} groups={groups} now={now} hostName={hostName} beside={beside} compact={compact} />
      <div className="relative flex min-h-0 flex-1">
        {phase !== "open" ? (
          <Loading text={phase === "lost" ? `Reconnecting to the browser…${error ? ` (${error})` : ""}` : "Connecting to the browser…"} action={phase === "lost" ? <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => ctl.reconnect()}>Retry now</Button> : undefined} />
        ) : !active ? (
          <Notice icon={<Globe />} title="No tabs open" text="Open a tab to browse, signed in as you." action={<Button size="sm" variant="primary" icon={<Plus />} onClick={() => void ctl.newTab()}>New tab</Button>} />
        ) : (
          <>
            <Viewport tabId={active.id} drives={drives && !active.crashed} stale={stale} onChrome={onChrome} onSize={(size) => surface.current?.setSize(size)} />
            {active.crashed && <CrashedNotice tabId={active.id} />}
            {dialog && <DialogOverlay dialog={dialog} drives={drives} agentName={owner.kind === "agent" ? owner.agentName : undefined} />}
            {chooser?.tabId === active.id && drives && <ChooserBar chooser={chooser} />}
            {owner.kind === "agent" && !drives && <WatchOnly tabId={active.id} owner={owner} />}
          </>
        )}
      </div>
      <Downloads compact={compact} />
    </>
  );
}

function NotRunning({ status }: { status: BrowserStatus }) {
  const [busy, setBusy] = useState(false);
  const start = (headed?: boolean) => {
    setBusy(true);
    void startBrowser(headed).finally(() => setBusy(false));
  };
  const install = status.install;
  if (status.state === "starting") return <Loading text={status.message ?? "Starting the browser…"} />;
  if (install && install.error == null) {
    return (
      <Notice
        icon={<Download />}
        title={`Downloading Chrome for Testing ${install.version}`}
        text={install.progress != null ? `${install.progress} %` : "Starting the download…"}
        action={<progress max={100} value={install.progress ?? undefined} className="h-1.5 w-56 overflow-hidden rounded-full accent-[var(--color-accent)]" />}
      />
    );
  }
  if (status.state === "unavailable") {
    return (
      <Notice
        icon={<Globe />}
        title="No browser found"
        text={install?.error ? `The download failed: ${install.error}` : (status.message ?? "TeleFlock needs Chrome, Chromium, Edge or Brave on this computer, or its own Chrome for Testing.")}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="primary" icon={<Download />} onClick={() => void browserCall("browser.installEngine", {}, "Couldn't download Chrome for Testing")}>
              Download Chrome for Testing
            </Button>
            <Button size="sm" variant="ghost" icon={<Settings2 />} onClick={() => navigate({ name: "settings" })}>
              Browser settings
            </Button>
          </div>
        }
      />
    );
  }
  const failed = status.state === "error";
  return (
    <Notice
      icon={failed ? <TriangleAlert /> : <Globe />}
      title={failed ? "The browser stopped" : "Your browser"}
      text={
        failed
          ? (status.message ?? "It failed to start or kept crashing.")
          : `A browser of your own inside TeleFlock: sign in to the sites you use, and let an agent use it when a task needs your logins. ${status.engine ? `It runs ${status.engine.name}` : "It runs your Chrome"} with its own profile, kept between restarts.`
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="primary" icon={failed ? <RotateCw /> : <Play />} loading={busy} onClick={() => start()}>
            {failed ? "Start it again" : "Start the browser"}
          </Button>
          <Button size="sm" variant="ghost" icon={<AppWindow />} disabled={busy} onClick={() => start(true)}>
            Start in its own window
          </Button>
        </div>
      }
    />
  );
}

function Loading({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="flex flex-col items-center gap-3 text-center text-sm text-mute">
        <Spinner size={22} />
        <span>{text}</span>
        {action}
      </div>
    </div>
  );
}

function Notice({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center overflow-y-auto p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="grid size-11 place-items-center rounded-full bg-ink/6 text-mute [&_svg]:size-5">{icon}</span>
        <p className="text-base font-bold text-ink">{title}</p>
        <p className="text-sm leading-relaxed text-mute">{text}</p>
        {action && <div className="mt-1">{action}</div>}
      </div>
    </div>
  );
}
