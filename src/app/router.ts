import { useSyncExternalStore } from "react";

/*
 * Minimal hash router: "#/design" → "/design". Hash routing works identically in `vite dev`,
 * the Tauri webview (tauri://localhost) and Android (no server-side fallback needed).
 */

function readPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** Current route path (without the leading "#"). */
export function useRoutePath(): string {
  return useSyncExternalStore(subscribe, readPath, () => "/");
}

/** Navigate to a route path, e.g. navigate("/design"). `replace` avoids a history entry. */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
  const url = `#${path}`;
  if (replace) {
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = path;
  }
}
