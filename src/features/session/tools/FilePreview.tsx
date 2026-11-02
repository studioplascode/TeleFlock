import { useContext } from "react";
import { useAgent, useSession } from "@/core";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";
import { SessionCtx } from "../context";
import { SvgFigure, MermaidFigure } from "../markdown/Figures";
import { Markdown } from "../markdown/Markdown";

/** Largest file the preview reads back from the host. */
const MAX_BYTES = 1_000_000;

const absolute = (path: string) => /^(?:[/~]|[A-Za-z]:[\\/])/.test(path);

/**
 * The rendered file behind an edit or write. `content` is the whole file when the tool call carries
 * it; otherwise (an edit, which carries only a patch) the file is read from the session's host as
 * it is now, and says so.
 */
export function FilePreview({ path, kind, content }: { path: string; kind: "svg" | "mermaid" | "markdown"; content?: string }) {
  const session = useContext(SessionCtx);
  const agent = useAgent(session?.key ?? "");
  const cwd = useSession(session?.key ?? "").meta?.cwd ?? agent?.cwd;
  const where = absolute(path) ? path : cwd ? `${cwd.replace(/[\\/]$/, "")}/${path}` : null;
  const disk = useHostQuery(session?.hostId, "fs.read", content === undefined && where ? { path: where, maxBytes: MAX_BYTES } : null);
  const text = content ?? disk.data?.text;
  if (text === undefined) {
    const note = disk.loading ? "Reading the file…" : disk.error ? `Can't read ${path} from the host: ${disk.error.message}` : where ? "This file isn't text." : "The file's folder isn't known, so it can't be read back.";
    return <div className="px-3 py-3 text-xs text-mute">{note}</div>;
  }
  return (
    <div className="px-2 pb-2">
      {content === undefined && (
        <div data-find-skip className="px-1 pb-1 text-2xs text-mute-2">
          The file as it is on the host now{disk.data?.truncated ? " (first MB)" : ""}.
        </div>
      )}
      {kind === "svg" && <SvgFigure code={text} />}
      {kind === "mermaid" && <MermaidFigure code={text} />}
      {kind === "markdown" && <Markdown text={text} className="px-1 py-1 text-[12.5px]" />}
    </div>
  );
}
