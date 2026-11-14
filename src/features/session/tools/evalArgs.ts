import type { ToolItem } from "@/core/gen";

/** One cell of an omp `eval` call: the code it runs, in which language, under which title. */
export interface EvalCell {
  language: "python" | "javascript";
  code: string;
  title?: string;
}

/**
 * The cells of an omp `eval` call from its arguments (`ToolItem.args`): `{language, code, title}`,
 * or older omp's `{cells: [{language, code, title}, …]}`. As omp's own renderer reads them
 * (`getRenderCells`): a cell's language is JavaScript for `js`, else Python. Arguments the model is
 * still writing give the cells that have code so far, possibly none; anything else gives none.
 */
export function evalCells(args: unknown): EvalCell[] {
  if (!isObject(args)) return [];
  const raw = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : [];
  const out: EvalCell[] = [];
  for (const cell of raw) {
    if (!isObject(cell) || typeof cell.code !== "string" || !cell.code.trim()) continue;
    const title = typeof cell.title === "string" ? cell.title.trim() : "";
    const js = typeof cell.language === "string" && /^(?:js|javascript|ts|typescript)$/i.test(cell.language.trim());
    out.push({ language: js ? "javascript" : "python", code: cell.code, ...(title ? { title } : {}) });
  }
  return out;
}

/**
 * The cells an `eval` call's card shows as code (`tools/CodeCard.tsx` `EvalBody`): none for other
 * tools, or when its result came with a view other than a screenshot. Find (`find/rowText.ts`,
 * tf-hostd's `find/rows.rs`) and the row estimate read the same cells.
 */
export function shownEvalCells(t: Pick<ToolItem, "tool" | "args" | "view">): EvalCell[] {
  if (t.tool !== "eval" || (t.view != null && t.view.type !== "image")) return [];
  return evalCells(t.args);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

