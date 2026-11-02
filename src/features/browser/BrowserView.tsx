import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "@/core";
import { Button, isTauri } from "@/design";
import { BrowserPanel, type PanelMode } from "./BrowserPanel";

/**
 * The browser over the whole window, and the window over the whole screen: Tauri's own full
 * screen in the desktop app, the Fullscreen API in a browser tab. Leaving the screen's full screen
 * (Esc in a browser tab, the OS) leaves it too.
 */
function Fullscreen({ agentKey, onExit }: { agentKey?: string; onExit(): void }) {
  const exit = useRef(onExit);
  useEffect(() => {
    exit.current = onExit;
  });
  useEffect(() => {
    if (isTauri()) {
      const win = getCurrentWindow();
      void win.setFullscreen(true).catch(() => {});
      return () => void win.setFullscreen(false).catch(() => {});
    }
    if (!document.fullscreenEnabled) return;
    const onChange = () => {
      if (!document.fullscreenElement) exit.current();
    };
    void document.documentElement
      .requestFullscreen()
      .then(() => document.addEventListener("fullscreenchange", onChange))
      .catch(() => {});
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-modal flex flex-col bg-tile-1">
      <BrowserPanel mode="fullscreen" agentKey={agentKey} fullscreen onFullscreen={onExit} />
    </div>,
    document.body,
  );
}

/**
 * The browser where it is shown (the split beside a session, the Browser page), with its own
 * fullscreen: while fullscreen, the place keeps a note instead of a second live copy of the page.
 */
export function BrowserSurface({ mode, agentKey }: { mode: Exclude<PanelMode, "fullscreen">; agentKey?: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  if (fullscreen) {
    return (
      <>
        <div className="grid h-full place-items-center bg-tile-1 p-6 text-center text-sm text-mute">
          <div className="flex flex-col items-center gap-3">
            <span>The browser is shown full screen.</span>
            <Button size="sm" variant="secondary" icon={<Maximize2 />} onClick={() => setFullscreen(false)}>
              Show it here
            </Button>
          </div>
        </div>
        <Fullscreen agentKey={agentKey} onExit={() => setFullscreen(false)} />
      </>
    );
  }
  return <BrowserPanel mode={mode} agentKey={agentKey} fullscreen={false} onFullscreen={() => setFullscreen(true)} />;
}

/** `#/browser`: the browser filling the main view (a browser split beside it would show the same browser twice, so it closes). */
export function BrowserView() {
  useEffect(() => {
    if (useUi.getState().split?.kind === "browser") useUi.getState().setSplit(null);
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col p-2 md:p-3">
      <div className="min-h-0 flex-1 overflow-hidden rounded-tile shadow-[var(--shadow-d2),inset_0_0_0_1px_var(--color-line)]">
        <BrowserSurface mode="page" />
      </div>
    </div>
  );
}
