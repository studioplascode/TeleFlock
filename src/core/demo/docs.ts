/**
 * Real Markdown documents behind the demo host's `.md` changes, so Review's Rendered view has
 * something true to show: the patch is a real unified diff of `before` → `after`, and `fs.read` of
 * the path returns `after` (the working tree) like a host would.
 */
import type { ChangedFile, FileStatus } from "@/core/gen";

interface DemoDoc {
  before?: string;
  after?: string;
}

const BOARD_BEFORE = `# Board

The board shows one card per agent, grouped into lanes by what each needs from you.

## Lanes

| Lane | Meaning |
| --- | --- |
| Needs you | The agent asked a question or wants approval |
| Running | The agent is working |
| Review | The agent finished; look at the diff |

## Moving cards

Drag a card to another lane to park, resume or archive it.

## Persistence

Column order is saved per host in \`localStorage\`.
`;

const BOARD_AFTER = `# Board

The board shows one card per agent, grouped into lanes by what each needs from you.

## Lanes

| Lane | Meaning |
| --- | --- |
| Needs you | The agent asked a question or wants approval |
| Running | The agent is working |
| Review | The agent finished; look at the diff |
| Done | Archived sessions |

## Moving cards

Drag a card to another lane to park, resume or archive it.

You can also move the focused card from the keyboard: **J** and **K** pick a card, **Shift+J** and **Shift+K** move it one lane.

> Moves are announced to screen readers: "Moved *Drag-and-drop kanban board* to Review".

## Persistence

Column order is saved per host in \`localStorage\`. The shape of the saved value:

\`\`\`ts
interface SavedBoard {
  version: 2;
  lanes: Record<string, string[]>; // lane id -> agent ids, top first
}
\`\`\`

Old saves (version 1) are migrated on first load.
`;

const SHORTCUTS = `# Keyboard shortcuts

| Keys | Action |
| --- | --- |
| \`J\` / \`K\` | Next / previous card |
| \`Shift+J\` / \`Shift+K\` | Move the card one lane down / up |
| \`Enter\` | Open the session |
| \`/\` | Filter cards |

## Why not arrow keys?

Arrow keys scroll the board; the letters stay out of the way of the browser.

1. Pick a card with \`J\` or \`K\`.
2. Hold \`Shift\` to carry it.
3. Release to drop it.

- Reduced motion: the card jumps instead of flying.
- Screen readers hear the move.
`;

const OLD_NOTES = `# Notes from the first prototype

- Lanes were fixed at three.
- Cards could not be moved.

These notes are replaced by [the board guide](board.md).
`;

const DOCS: Record<string, DemoDoc> = {
  "docs/board.md": { before: BOARD_BEFORE, after: BOARD_AFTER },
  "docs/keyboard-shortcuts.md": { after: SHORTCUTS },
  "docs/prototype-notes.md": { before: OLD_NOTES },
};

/** The document the demo has for `path`, if any. */
export function demoDoc(path: string): DemoDoc | undefined {
  return DOCS[path];
}

function lines(text: string | undefined): string[] {
  return text === undefined ? [] : text.replace(/\n$/, "").split("\n");
}

/** Longest-common-subsequence line diff as ops. */
function diffOps(a: string[], b: string[]): { op: " " | "-" | "+"; text: string }[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { op: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ op: " ", text: a[i++]! }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", text: a[i++]! });
    else out.push({ op: "+", text: b[j++]! });
  }
  while (i < n) out.push({ op: "-", text: a[i++]! });
  while (j < m) out.push({ op: "+", text: b[j++]! });
  return out;
}

/** A real unified diff of the document (3 lines of context); `null` when `path` has no demo document. */
export function demoDocPatch(path: string): { patch: string; added: number; removed: number; status: FileStatus } | null {
  const doc = DOCS[path];
  if (!doc) return null;
  const status: FileStatus = doc.before === undefined ? "added" : doc.after === undefined ? "deleted" : "modified";
  const ops = diffOps(lines(doc.before), lines(doc.after));
  const added = ops.filter((o) => o.op === "+").length;
  const removed = ops.filter((o) => o.op === "-").length;
  const head = [`diff --git a/${path} b/${path}`];
  if (status === "added") head.push("new file mode 100644");
  if (status === "deleted") head.push("deleted file mode 100644");
  head.push("index 3f2a9c1..8b7d4e2 100644", `--- ${status === "added" ? "/dev/null" : `a/${path}`}`, `+++ ${status === "deleted" ? "/dev/null" : `b/${path}`}`);
  // hunks: runs of changes with 3 lines of context, merged when the gap is small
  const CTX = 3;
  const changed = ops.map((o, k) => (o.op === " " ? -1 : k)).filter((k) => k >= 0);
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const last = hunks[hunks.length - 1];
    if (last && k - last[1] <= CTX * 2 + 1) last[1] = k;
    else hunks.push([k, k]);
  }
  const body: string[] = [];
  for (const [from, to] of hunks) {
    const s = Math.max(0, from - CTX);
    const e = Math.min(ops.length - 1, to + CTX);
    let oldStart = 1;
    let newStart = 1;
    for (let k = 0; k < s; k++) {
      if (ops[k]!.op !== "+") oldStart++;
      if (ops[k]!.op !== "-") newStart++;
    }
    const slice = ops.slice(s, e + 1);
    const oldN = slice.filter((o) => o.op !== "+").length;
    const newN = slice.filter((o) => o.op !== "-").length;
    body.push(`@@ -${oldN === 0 ? 0 : oldStart},${oldN} +${newN === 0 ? 0 : newStart},${newN} @@`);
    for (const o of slice) body.push(`${o.op}${o.text}`);
  }
  return { patch: [...head, ...body].join("\n"), added, removed, status };
}

/** A `ChangedFile` for a demo document, with the counts its real diff has. */
export function docFile(path: string, oldPath?: string): ChangedFile {
  const d = demoDocPatch(path);
  if (!d) throw new Error(`no demo document ${path}`);
  return oldPath ? { path, added: d.added, removed: d.removed, status: d.status, oldPath } : { path, added: d.added, removed: d.removed, status: d.status };
}
