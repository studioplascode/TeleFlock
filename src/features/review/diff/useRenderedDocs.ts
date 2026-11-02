import { useEffect, useMemo, useState } from "react";
import { core, toApiError } from "@/core";
import { addedLines, isMarkdownPath, markdownChunks, oldText, RENDER_MAX_BYTES, type RenderedDoc } from "./markdown";
import type { DiffFile } from "./parse";

/** Markdown files read at once (a diff of a docs rewrite can have dozens; the rest stay diffs). */
const MAX_DOCS = 40;

type Source = { text: string } | { message: string };

const NONE: ReadonlyMap<string, RenderedDoc> = new Map();

/**
 * What Rendered shows for each Markdown file of the diff: the working-tree text of an added or
 * modified one (`fs.read`; the diff is against it), the old text of a deleted one (the patch
 * carries it whole). Reads again when the diff reloads, keeping the previous text on screen until
 * the new one arrives. Nothing is read while `enabled` is off.
 */
export function useRenderedDocs(hostId: string, root: string | undefined, files: readonly DiffFile[], enabled: boolean): ReadonlyMap<string, RenderedDoc> {
  const [sources, setSources] = useState<ReadonlyMap<string, Source>>(new Map());
  const docs = useMemo(() => (enabled ? files.filter((f) => isMarkdownPath(f.path) && !f.binary).slice(0, MAX_DOCS) : []), [enabled, files]);
  useEffect(() => {
    if (docs.length === 0 || !root) return;
    let alive = true;
    const put = (path: string, s: Source) => alive && setSources((m) => new Map(m).set(path, s));
    for (const f of docs) {
      if (f.status === "deleted") {
        put(f.path, { text: oldText(f) });
        continue;
      }
      core
        .host(hostId)
        .call("fs.read", { path: `${root.replace(/\/$/, "")}/${f.path}`, maxBytes: RENDER_MAX_BYTES })
        .then(
          (r) => {
            if (r.truncated) put(f.path, { message: `Larger than ${Math.round(RENDER_MAX_BYTES / 1000)} KB: shown as a diff only` });
            else if (r.text == null) put(f.path, { message: "Not text: shown as a diff only" });
            else put(f.path, { text: r.text });
          },
          (e: unknown) => put(f.path, { message: `Couldn't read the file: ${toApiError(e).message}` }),
        );
    }
    return () => {
      alive = false;
    };
  }, [hostId, root, docs]);
  return useMemo(() => {
    if (docs.length === 0) return NONE;
    const out = new Map<string, RenderedDoc>();
    for (const f of docs) {
      const s = sources.get(f.path);
      if (!s) out.set(f.path, { state: "loading" });
      else if ("message" in s) out.set(f.path, { state: "message", message: s.message });
      else {
        // A new file is all change: marking every block says nothing.
        const marked = f.status === "added" || f.status === "untracked" || f.status === "deleted" ? new Set<number>() : addedLines(f);
        out.set(f.path, { state: "ready", chunks: markdownChunks(s.text, marked) });
      }
    }
    return out;
  }, [docs, sources]);
}
