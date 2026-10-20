import { getCurrentWindow } from "@tauri-apps/api/window";
import { type ReactNode, useEffect, useState } from "react";
import { Wordmark } from "../brand/Logo";
import { cn } from "../lib/cn";
import { hasCustomWindowChrome, isAndroid } from "../lib/platform";

export interface TitleBarProps {
  /** Text/nodes after the wordmark, e.g. "forge · default · ● Tailscale". */
  subtitle?: ReactNode;
  /** Right-aligned actions before the window controls (must be interactive elements). */
  actions?: ReactNode;
  className?: string;
}

const ctrl =
  "grid h-full w-[46px] place-items-center text-[#cfcfd8] transition-colors duration-100 hover:bg-white/7 focus-visible:bg-white/10 focus-visible:outline-none";

/**
 * Custom desktop title bar (the main window is undecorated). The whole bar is a Tauri drag region
 * (double-click maximizes); Windows-style minimize / maximize-restore / close on the right.
 * In a plain browser it renders without window controls; on Android it renders nothing.
 */
export function TitleBar({ subtitle, actions, className }: TitleBarProps) {
  const chrome = hasCustomWindowChrome();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!chrome) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      win.isMaximized().then((m) => {
        if (!disposed) setMaximized(m);
      }, () => {});
    };
    sync();
    win.onResized(sync).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      },
      () => {},
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [chrome]);

  if (isAndroid) return null;

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "relative z-titlebar flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-[rgb(10_10_15/0.6)] pl-3.5 select-none",
        className,
      )}
    >
      <Wordmark size={18} className="pointer-events-none" />
      {subtitle && (
        <span data-tauri-drag-region className="min-w-0 truncate text-xs text-mute-2">
          {subtitle}
        </span>
      )}
      <div data-tauri-drag-region className="h-full flex-1" />
      {actions && <div className="flex items-center gap-1.5 pr-2">{actions}</div>}
      {chrome && (
        <div className="flex h-full" role="group" aria-label="Window controls">
          <button type="button" className={ctrl} aria-label="Minimize" title="Minimize" onClick={() => void getCurrentWindow().minimize()}>
            <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
              <path d="M0 5h10" />
            </svg>
          </button>
          <button
            type="button"
            className={ctrl}
            aria-label={maximized ? "Restore" : "Maximize"}
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => void getCurrentWindow().toggleMaximize()}
          >
            <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
              {maximized ? (
                <>
                  <rect x="0.5" y="2.5" width="7" height="7" rx="1.2" />
                  <path d="M2.5 2.5V1.7A1.2 1.2 0 0 1 3.7.5h4.6a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1-1.2 1.2H7.5" />
                </>
              ) : (
                <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className={cn(ctrl, "hover:bg-[#c42b1c] hover:text-white focus-visible:bg-[#c42b1c]")}
            aria-label="Close"
            title="Close"
            onClick={() => void getCurrentWindow().close()}
          >
            <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
              <path d="M0 0l10 10M10 0L0 10" />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}
