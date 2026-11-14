import type { ReactNode } from "react";
import type { ToolItem } from "@/core/gen";
import { Shimmer } from "@/design";
import { CodeBlock } from "../markdown/CodeBlock";
import { AnsiText } from "./AnsiText";
import type { EvalCell } from "./evalArgs";

/** A call's code longer than this many lines folds to them ("Show N more lines"). */
export const CODE_FOLD_LINES = 16;

/**
 * The code a tool call ran, as a card in its body: its language, `title`, Copy, and the code as
 * written (its lines and indentation), highlighted and folded when long. `findRow`: the transcript
 * row it is in, so Find's current match in the code unfolds it.
 */
export function CodeCard({ code, lang, title, findRow }: { code: string; lang: string; title?: ReactNode; findRow: string }) {
  return <CodeBlock code={code} lang={lang} title={title} fold={CODE_FOLD_LINES} findRow={findRow} className="mx-2 my-2" />;
}

/**
 * An omp `eval` call: each cell's code (with its title when the call has several), then what it
 * printed (followed while it runs), then the image it returned, such as a browser screenshot.
 * No cells yet: the model is still writing the call.
 */
export function EvalBody({ item, cells, image }: { item: ToolItem; cells: EvalCell[]; image?: ReactNode }) {
  const running = item.status === "running";
  const out = item.output ?? "";
  return (
    <div>
      {cells.length === 0 ? (
        <div data-find-skip className="px-3 py-2 font-mono text-[11px] text-mute-2">
          <Shimmer>writing the code…</Shimmer>
        </div>
      ) : (
        cells.map((c, i) => <CodeCard key={i} code={c.code} lang={c.language} title={cells.length > 1 ? c.title : undefined} findRow={item.id} />)
      )}
      {out ? (
        <AnsiText text={out} follow={running} className="border-t border-line" />
      ) : (
        running &&
        cells.length > 0 && (
          <div data-find-skip className="border-t border-line px-3 py-2 font-mono text-[11px] text-mute-2">
            <Shimmer>waiting for output…</Shimmer>
          </div>
        )
      )}
      {image}
    </div>
  );
}
