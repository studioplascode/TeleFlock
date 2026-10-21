import { core } from "./client";
import { inTauri } from "./transport/tauri";

/**
 * Link policy for agent-controlled URLs (markdown, tool output, terminal OSC 8 / bare URLs):
 * only absolute `http:`/`https:` URLs are followable. Everything else (`javascript:`, `file:`,
 * custom protocol handlers, relative paths) renders as inert text.
 */
export function safeHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
}

/**
 * Opens a link outside the app. Inside Tauri it goes through `app.openExternal` (system browser,
 * http(s) re-checked natively); in a plain browser it opens a new tab without an opener.
 * Returns false when the URL was refused by the policy.
 */
export function openLink(raw: string): boolean {
  const url = safeHref(raw);
  if (!url) return false;
  if (inTauri()) {
    core.app("app.openExternal", { url }).catch((err: unknown) => console.warn("[links] openExternal failed", err));
  } else {
    window.open(url, "_blank", "noopener");
  }
  return true;
}

export interface LinkProps {
  href: string;
  target: "_blank";
  rel: string;
  onClick(e: { preventDefault(): void }): void;
  onAuxClick(e: { button: number; preventDefault(): void }): void;
}

/**
 * Anchor props for an agent-controlled URL, or `null` when the URL must render as inert text.
 * Clicks never navigate the webview: they are routed through {@link openLink}.
 */
export function linkProps(raw: string | null | undefined): LinkProps | null {
  const href = safeHref(raw);
  if (!href) return null;
  return {
    href,
    target: "_blank",
    rel: "noreferrer noopener",
    onClick: (e) => {
      e.preventDefault();
      openLink(href);
    },
    onAuxClick: (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      openLink(href);
    },
  };
}
