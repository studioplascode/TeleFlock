import { ChevronDown, FileDiff as FileDiffIcon, FilePlus2, FileX2, FileSymlink } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { FileDiff } from "@/core/gen";
import { cn } from "@/design";
import { highlight, languageFor, TOKEN_CLASS } from "../lib/highlight";
import { lruMemo } from "../lib/lru";
import { Highlighted } from "../markdown/Markdown";
import { useOpenOnFind } from "../find/reveal";

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Changed character range vs. its paired line (word-level emphasis). */
  span?: [number, number];
}

const parsePatch = lruMemo(200, parsePatchUncached);

function parsePatchUncached(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = m ? Number(m[1]) : oldNo;
      newNo = m ? Number(m[2]) : newNo;
      out.push({ kind: "hunk", text: m?.[3]?.trim() || raw });
    } else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("\\")) {
      if (raw.startsWith("\\")) out.push({ kind: "meta", text: raw.slice(1).trim() });
    } else if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    else if (raw.length > 0 || out.length > 0) out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
  }
  while (out.length && out[out.length - 1]?.kind === "ctx" && out[out.length - 1]?.text === "") out.pop();
  pairChanges(out);
  return out;
}

/**
 * Pairs each run of removed lines with the added run right after it and marks the part of each
 * pair that actually changed (common prefix/suffix trimmed), so a one-word edit reads as one.
 */
function pairChanges(lines: DiffLine[]): void {
  for (let i = 0; i < lines.length; ) {
    if (lines[i]?.kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (lines[i]?.kind === "del") i++;
    const addStart = i;
    while (lines[i]?.kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const a = lines[delStart + k]!;
      const b = lines[addStart + k]!;
      const max = Math.min(a.text.length, b.text.length);
      let pre = 0;
      while (pre < max && a.text[pre] === b.text[pre]) pre++;
      let suf = 0;
      while (suf < max - pre && a.text[a.text.length - 1 - suf] === b.text[b.text.length - 1 - suf]) suf++;
      // Only near-identical pairs get emphasis; unrelated lines and full rewrites keep just the row tint.
      if ((pre + suf) / Math.max(a.text.length, b.text.length, 1) < 0.5) continue;
      if (a.text.length - suf > pre) a.span = [pre, a.text.length - suf];
      if (b.text.length - suf > pre) b.span = [pre, b.text.length - suf];
    }
  }
}

/** Syntax-highlighted line with the changed range wrapped in a stronger tint. */
function DiffCode({ code, lang, span, kind }: { code: string; lang?: string; span?: [number, number]; kind: "add" | "del" | "ctx" }) {
  if (!span) return <Highlighted code={code} lang={lang} />;
  const mark = kind === "add" ? "rounded-[3px] bg-add/25 text-inherit" : "rounded-[3px] bg-del/30 text-inherit";
  const out: ReactNode[] = [];
  let pos = 0;
  highlight(code, lang).forEach((t, i) => {
    const end = pos + t.text.length;
    const cuts = [pos, Math.min(end, Math.max(pos, span[0])), Math.min(end, Math.max(pos, span[1])), end];
    for (let k = 0; k < 3; k++) {
      const from = cuts[k]!;
      const to = cuts[k + 1]!;
      if (to <= from) continue;
      const text = t.text.slice(from - pos, to - pos);
      const piece = t.kind === "plain" ? text : <span className={TOKEN_CLASS[t.kind]}>{text}</span>;
      out.push(
        k === 1 ? (
          <mark key={`${i}.${k}`} className={mark}>
            {piece}
          </mark>
        ) : (
          <span key={`${i}.${k}`}>{piece}</span>
        ),
      );
    }
    pos = end;
  });
  return <>{out}</>;
}

const COLLAPSED_LINES = 36;

export function DiffStatText({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span data-find-skip className={cn("font-mono text-[11px] font-semibold whitespace-nowrap tabular", className)}>
      <span className="text-add">+{added}</span> <span className="text-del">−{removed}</span>
    </span>
  );
}

const STATUS_ICON: Partial<Record<FileDiff["status"], typeof FileDiffIcon>> = { added: FilePlus2, untracked: FilePlus2, deleted: FileX2, renamed: FileSymlink };

/** One file of a diff. `findRow`: the transcript row it is in, so Find's current match there opens it. */
export function FileDiffView({ file, defaultOpen = true, findRow }: { file: FileDiff; defaultOpen?: boolean; findRow?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  useOpenOnFind(
    findRow ?? "",
    () => {
      setOpen(true);
      setAll(true);
    },
    `${file.path}\n${file.patch}`,
  );
  const lines = parsePatch(file.patch);
  const lang = languageFor(file.lang ?? file.path);
  const shown = all ? lines : lines.slice(0, COLLAPSED_LINES);
  const Icon = STATUS_ICON[file.status] ?? FileDiffIcon;
  const width = String(Math.max(...lines.map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)), 1)).length;
  return (
    <div className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.03]"
      >
        <Icon className="size-3.5 shrink-0 text-mute" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2" title={file.path}>
          {file.path}
        </span>
        {file.status !== "modified" && <span data-find-skip className="rounded-full bg-white/6 px-1.5 text-[9.5px] font-bold tracking-wider text-mute uppercase">{file.status}</span>}
        <DiffStatText added={file.added} removed={file.removed} />
        <ChevronDown className={cn("size-3.5 shrink-0 text-mute-2 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && lines.length > 0 && (
        <div className="overflow-x-auto pb-1.5 font-mono text-[11px] leading-[1.65]">
          <table className="w-full border-collapse">
            <tbody>
              {shown.map((l, i) =>
                l.kind === "hunk" ? (
                  <tr key={i} className="bg-accent/[0.06] text-accent-ink/70">
                    <td colSpan={3} className="px-3 py-0.5 text-[10.5px]">
                      ⋯ {l.text}
                    </td>
                  </tr>
                ) : l.kind === "meta" ? (
                  <tr key={i} className="text-mute-2">
                    <td colSpan={3} className="px-3 text-[10.5px] italic">
                      {l.text}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={cn(l.kind === "add" && "bg-add/[0.055]", l.kind === "del" && "bg-del/[0.06]")}>
                    <td
                      data-find-skip
                      className={cn(
                        "w-0 px-1.5 text-right text-mute-2/70 select-none tabular",
                        l.kind === "add" && "shadow-[inset_2px_0_0_var(--color-add)]",
                        l.kind === "del" && "shadow-[inset_2px_0_0_var(--color-del)]",
                      )}
                      style={{ minWidth: `${width + 1}ch` }}
                    >
                      {l.kind === "add" ? "" : l.oldNo}
                    </td>
                    <td data-find-skip className="w-0 px-1.5 text-right text-mute-2/70 select-none tabular" style={{ minWidth: `${width + 1}ch` }}>
                      {l.kind === "del" ? "" : l.newNo}
                    </td>
                    <td className="pr-3 whitespace-pre">
                      <span data-find-skip className={cn("inline-block w-4 select-none", l.kind === "add" ? "text-add" : l.kind === "del" ? "text-del" : "text-mute-2")}>
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                      </span>
                      <span className={cn(l.kind === "del" && "opacity-85")}>
                        <DiffCode code={l.text} lang={lang} span={l.span} kind={l.kind} />
                      </span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {lines.length > COLLAPSED_LINES && (
            <button
              type="button"
              data-find-skip
              onClick={() => setAll((a) => !a)}
              className={cn(
                "focus-ring relative flex w-full items-center justify-center gap-1.5 py-1.5 font-sans text-2xs font-bold text-accent-hi hover:text-ink",
                !all && "-mt-7 bg-gradient-to-b from-transparent via-[rgb(10_10_16/0.85)] to-[rgb(10_10_16/0.95)] pt-6",
              )}
            >
              <ChevronDown className={cn("size-3 transition-transform", all && "rotate-180")} />
              {all ? "Show less" : `Show ${lines.length - COLLAPSED_LINES} more lines`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
