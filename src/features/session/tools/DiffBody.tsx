import { ChevronDown, FileDiff as FileDiffIcon, FilePlus2, FileX2, FileSymlink } from "lucide-react";
import { useState } from "react";
import type { FileDiff } from "@/core/gen";
import { cn } from "@/design";
import { languageFor } from "../lib/highlight";
import { Highlighted } from "../markdown/Markdown";

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

function parsePatch(patch: string): DiffLine[] {
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
  return out;
}

const COLLAPSED_LINES = 36;

export function DiffStatText({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("font-mono text-[11px] font-semibold whitespace-nowrap tabular", className)}>
      <span className="text-add">+{added}</span> <span className="text-del">−{removed}</span>
    </span>
  );
}

const STATUS_ICON: Partial<Record<FileDiff["status"], typeof FileDiffIcon>> = { added: FilePlus2, untracked: FilePlus2, deleted: FileX2, renamed: FileSymlink };

export function FileDiffView({ file, defaultOpen = true }: { file: FileDiff; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
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
        {file.status !== "modified" && <span className="rounded-full bg-white/6 px-1.5 text-[9.5px] font-bold tracking-wider text-mute uppercase">{file.status}</span>}
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
                  <tr key={i} className={cn(l.kind === "add" && "bg-add/[0.075]", l.kind === "del" && "bg-del/[0.085]")}>
                    <td className="w-0 px-1.5 text-right text-mute-2/70 select-none tabular" style={{ minWidth: `${width + 1}ch` }}>
                      {l.kind === "add" ? "" : l.oldNo}
                    </td>
                    <td className="w-0 px-1.5 text-right text-mute-2/70 select-none tabular" style={{ minWidth: `${width + 1}ch` }}>
                      {l.kind === "del" ? "" : l.newNo}
                    </td>
                    <td className="pr-3 whitespace-pre">
                      <span className={cn("inline-block w-4 select-none", l.kind === "add" ? "text-add" : l.kind === "del" ? "text-del" : "text-mute-2")}>
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                      </span>
                      <span className={cn(l.kind === "del" && "opacity-80")}>
                        <Highlighted code={l.text} lang={lang} />
                      </span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {lines.length > COLLAPSED_LINES && (
            <button type="button" onClick={() => setAll((a) => !a)} className="focus-ring mx-3 mt-1 rounded-xs px-1.5 text-2xs font-bold text-accent-hi hover:text-ink">
              {all ? "Show less" : `Show all ${lines.length} lines`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
