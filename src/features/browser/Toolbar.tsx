import { ArrowLeft, ArrowRight, AppWindow, Globe, Hand, Lock, Maximize2, Minimize2, MoreHorizontal, PanelRightOpen, Plus, RotateCcw, RotateCw, Settings2, Square, Undo2, X, ZoomIn, ZoomOut } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { navigate } from "@/core";
import type { BrowserAttachment } from "@/core/gen";
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Tooltip } from "@/design";
import { handBack, lendTab, startBrowser, stopBrowser, takeOver } from "./actions";
import { browserController, useBrowserUi } from "./controller";
import { addressToUrl, nextZoom } from "./input";
import { useToolbarItems } from "./observe";
import type { TabOwner } from "./owners";
import type { Tab } from "./tabs";

interface ToolbarProps {
  tab: Tab | null;
  owner: TabOwner;
  /** The user may drive the shown tab. */
  drives: boolean;
  headed: boolean;
  compact: boolean;
  /** Agents attached now (Let <agent> use this tab). */
  attachments: BrowserAttachment[];
  fullscreen: boolean;
  onFullscreen(): void;
}

/** Back, Forward, Reload/Stop, the address bar, zoom, the owner's controls, other features' items and the menu. */
export function Toolbar({ tab, owner, drives, headed, compact, attachments, fullscreen, onFullscreen }: ToolbarProps) {
  const ctl = browserController();
  const zoom = useBrowserUi((s) => (tab ? (s.zoom[tab.id] ?? 1) : 1));
  const items = useToolbarItems((s) => s.items);
  const id = tab?.id ?? null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-tile-3 px-1.5">
      <IconButton label="Back (Alt+Left)" size="sm" disabled={!tab?.canGoBack || !drives} onClick={() => id && void ctl.history(id, -1)}>
        <ArrowLeft />
      </IconButton>
      <IconButton label="Forward (Alt+Right)" size="sm" disabled={!tab?.canGoForward || !drives} onClick={() => id && void ctl.history(id, 1)}>
        <ArrowRight />
      </IconButton>
      {tab?.loading ? (
        <IconButton label="Stop loading" size="sm" disabled={!id} onClick={() => id && ctl.stop(id)}>
          <X />
        </IconButton>
      ) : (
        <IconButton label="Reload (Ctrl+R)" size="sm" disabled={!id || !drives} onClick={() => id && ctl.reload(id)}>
          <RotateCw />
        </IconButton>
      )}
      <AddressBar tab={tab} drives={drives} />
      {zoom !== 1 && id && (
        <Tooltip content="Reset zoom (Ctrl+0)">
          <button type="button" onClick={() => ctl.zoom(id, 1)} className="h-6 shrink-0 rounded-full bg-ink/8 px-2 text-[11px] font-bold text-ink-2 tabular-nums hover:bg-ink/14">
            {Math.round(zoom * 100)} %
          </button>
        </Tooltip>
      )}
      <OwnerControls tab={tab} owner={owner} compact={compact} />
      {items.map(({ id: key, component: Item }) => (
        <Item key={key} tabId={id} compact={compact} />
      ))}
      <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} size="sm" onClick={onFullscreen}>
        {fullscreen ? <Minimize2 /> : <Maximize2 />}
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="Browser menu" size="sm">
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Plus />} shortcut="Ctrl T" onSelect={() => void ctl.newTab()}>
            New tab
          </DropdownMenuItem>
          <DropdownMenuItem icon={<RotateCcw />} shortcut="Ctrl ⇧ T" onSelect={() => ctl.reopenClosed()}>
            Reopen closed tab
          </DropdownMenuItem>
          {id && drives && !headed && (
            <>
              <DropdownMenuItem icon={<ZoomIn />} shortcut="Ctrl +" onSelect={() => ctl.zoom(id, nextZoom(zoom, 1))}>
                Zoom in
              </DropdownMenuItem>
              <DropdownMenuItem icon={<ZoomOut />} shortcut="Ctrl −" onSelect={() => ctl.zoom(id, nextZoom(zoom, -1))}>
                Zoom out
              </DropdownMenuItem>
            </>
          )}
          {id && owner.kind === "user" && attachments.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Let an agent use this tab</DropdownMenuLabel>
              {attachments.map((a) => (
                <DropdownMenuItem key={`${a.hostId}::${a.agentId}`} icon={<Hand />} onSelect={() => void lendTab(id, a.hostId, a.agentId, a.agentName)}>
                  {a.agentName}
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          {headed ? (
            <DropdownMenuItem icon={<PanelRightOpen />} onSelect={() => void startBrowser(false)}>
              Show it here instead of its own window
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem icon={<AppWindow />} onSelect={() => void startBrowser(true)}>
              Open in its own window
            </DropdownMenuItem>
          )}
          <DropdownMenuItem icon={<Settings2 />} onSelect={() => navigate({ name: "settings" })}>
            Browser settings
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Square />} danger onSelect={() => void stopBrowser()}>
            Stop the browser
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The shown tab is an agent's: watch it, take it over, hand it back, take a lent tab back. */
function OwnerControls({ tab, owner, compact }: { tab: Tab | null; owner: TabOwner; compact: boolean }) {
  if (!tab || owner.kind !== "agent" || owner.detached) return null;
  if (owner.takenOver) {
    return (
      <Button size="sm" variant="secondary" icon={<Undo2 />} onClick={() => void handBack(tab.id)} title={`${owner.agentName} can drive this tab again`}>
        {compact ? "Hand back" : `Hand back to ${owner.agentName}`}
      </Button>
    );
  }
  return (
    <Button size="sm" variant="secondary" icon={<Hand />} onClick={() => void takeOver(tab.id)} title={owner.lent ? `Take this tab back from ${owner.agentName}` : `Use this tab yourself; ${owner.agentName} can't drive it until you hand it back`}>
      {owner.lent ? "Take back" : "Take over"}
    </Button>
  );
}

/** The shown tab's address; typing opens an address or searches. */
function AddressBar({ tab, drives }: { tab: Tab | null; drives: boolean }) {
  const ctl = browserController();
  const focusSignal = useBrowserUi((s) => s.addressFocus);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const url = tab?.url === "about:blank" ? "" : (tab?.url ?? "");
  const secure = url.startsWith("https://");

  useEffect(() => {
    if (focusSignal === 0) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusSignal]);

  // Switching tabs drops what was typed for the other one.
  useEffect(() => {
    setDraft(null);
  }, [tab?.id]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const target = addressToUrl(draft ?? url, ctl.searchUrl);
    if (!tab || !target) return;
    setDraft(null);
    ctl.navigate(tab.id, target);
    inputRef.current?.blur();
    // Keys go back to the page.
    document.querySelector<HTMLTextAreaElement>("[data-browser-viewport] textarea")?.focus({ preventScroll: true });
  };

  return (
    <form onSubmit={submit} className="flex h-7.5 min-w-0 flex-1 items-center gap-2 rounded-full bg-well px-3 shadow-[inset_0_0_0_1px_var(--color-line)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-accent)]">
      {secure ? <Lock className="size-3.5 shrink-0 text-mute" aria-label="Secure connection" /> : <Globe className="size-3.5 shrink-0 text-mute-2" />}
      <input
        ref={inputRef}
        value={draft ?? url}
        disabled={!tab || !drives}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          if (draft === url) setDraft(null);
        }}
        placeholder={tab ? "Search or type an address" : ""}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Address"
        className={cn("min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-mute-2 disabled:text-mute")}
      />
    </form>
  );
}
