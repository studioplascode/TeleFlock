import type { Terminal } from "@xterm/xterm";
import { useEffect, useState } from "react";
import { termBus } from "@/core";
import { ansiToText, decodeBase64, findLocalhostUrls, type LocalhostUrl } from "./frames";

export type { LocalhostUrl } from "./frames";

/**
 * Mounted xterm instances by `${hostId}::${termId}`. When the terminal is on screen, URL detection
 * reads its rendered buffer (exact rows, wraps joined) instead of re-parsing raw frames, so URLs
 * split across incremental repaints are still found.
 */
const liveTerms = new Map<string, Terminal>();

export function registerLiveTerm(hostId: string, termId: string, term: Terminal): () => void {
  const key = `${hostId}::${termId}`;
  liveTerms.set(key, term);
  return () => {
    if (liveTerms.get(key) === term) liveTerms.delete(key);
  };
}

function bufferText(term: Terminal): string {
  const buf = term.buffer.active;
  let text = "";
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    text += (y > 0 && !line.isWrapped ? "\n" : "") + line.translateToString(true);
  }
  return text;
}

const MAX_URLS = 6;
const SCAN_DELAY_MS = 350;

/**
 * Localhost URLs (`http://localhost:PORT`, `127.0.0.1:PORT`, …) seen in a terminal's output,
 * newest first, de-duplicated by port. Feeds `PreviewButton`.
 */
export function useLocalhostUrls(hostId: string, termId: string | null | undefined): LocalhostUrl[] {
  const [urls, setUrls] = useState<LocalhostUrl[]>([]);

  useEffect(() => {
    setUrls([]);
    if (!termId) return;
    let timer: number | undefined;
    let pending = "";

    const scan = () => {
      timer = undefined;
      const term = liveTerms.get(`${hostId}::${termId}`);
      const text = term ? bufferText(term) : pending;
      pending = "";
      const found = findLocalhostUrls(text);
      if (!found.length) return;
      setUrls((prev) => {
        const byPort = new Map(prev.map((u) => [u.port, u]));
        let changed = false;
        for (const u of found) {
          const old = byPort.get(u.port);
          // Keep the richer URL (one with a path) but refresh recency.
          if (!old || old.url !== u.url) changed = true;
          byPort.set(u.port, old && old.url.length > u.url.length ? { ...old, seenAt: u.seenAt } : u);
        }
        if (!changed) return prev;
        return [...byPort.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, MAX_URLS);
      });
    };

    const unsub = termBus.subscribe(hostId, termId, (ev) => {
      if (ev.k !== "frame") return;
      if (!liveTerms.has(`${hostId}::${termId}`)) {
        // Off-screen: accumulate decoded text until the next scan (bounded).
        pending = (pending + ansiToText(decodeBase64(ev.data))).slice(-64_000);
      }
      timer ??= window.setTimeout(scan, SCAN_DELAY_MS);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [hostId, termId]);

  return urls;
}
