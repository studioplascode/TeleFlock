import { Check, ClipboardPaste, TriangleAlert, X } from "lucide-react";
import { motion } from "motion/react";
import { lineCount, pasteSize, previewLines } from "@/core/pastes";
import { cn, Kbd, Spinner, spring } from "@/design";
import type { PasteAttach } from "./usePasteAttach";

/** Lines of the paste the menu shows. */
const MENU_PREVIEW_LINES = 6;

/**
 * Large pastes as chips above the message, one per paste whose token is in it: its first line,
 * number, size and how it goes (inline, or wrapped in `<attachment>` tags). The chip opens the
 * paste's menu; × takes the paste out. A token whose paste this device lost gets a warning chip.
 */
export function PasteChips({ paste, mobile = false, className }: { paste: PasteAttach; mobile?: boolean; className?: string }) {
  if (!paste.pastes.length && !paste.missing.length) return null;
  const btn = cn("pressable focus-ring grid shrink-0 place-items-center rounded-full text-mute hover:bg-white/8 hover:text-ink", mobile ? "size-8" : "size-6");
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} aria-label={paste.pastes.length === 1 ? "1 pasted text" : `${paste.pastes.length} pasted texts`}>
      {paste.pastes.map((p) => {
        const saving = paste.saving.includes(p.n);
        const open = paste.menu?.n === p.n;
        const size = pasteSize(p.text);
        const how = saving ? "saving as a file…" : p.mode === "block" ? "attachment block" : "inline";
        return (
          <motion.div
            key={p.n}
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1, transition: spring.bouncy }}
            role="group"
            aria-label={`Pasted text ${p.n}, ${size}, ${how}`}
            className={cn(
              "relative flex max-w-[300px] min-w-0 items-center gap-1 overflow-hidden rounded-[12px] py-1 pr-1 pl-1 shadow-hairline",
              mobile ? "h-11" : "h-10",
              open ? "bg-accent/16 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.45)]" : "bg-tile-4",
            )}
          >
            <button
              type="button"
              // Keeps the caret in the message, so the menu's keys and undo work there.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (open ? paste.close() : paste.open(p.n))}
              aria-haspopup="listbox"
              aria-expanded={open}
              title={`Paste #${p.n} · ${size}\n${previewLines(p.text, 4, 100).join("\n")}`}
              className="pressable focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-[9px] py-0.5 pr-1 pl-1.5 text-left"
            >
              {saving ? <Spinner size={14} className="shrink-0" /> : <ClipboardPaste className="size-4 shrink-0 text-accent-hi" aria-hidden />}
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate font-mono text-[11.5px] font-semibold text-ink">{previewLines(p.text, 1, 80)[0] || " "}</span>
                <span className="truncate text-[10.5px] font-semibold text-mute tabular">
                  #{p.n} · {size} · {how}
                </span>
              </span>
            </button>
            <button type="button" aria-label={`Remove pasted text ${p.n}`} onMouseDown={(e) => e.preventDefault()} onClick={() => paste.remove(p.n)} className={btn}>
              <X className="size-3.5" />
            </button>
          </motion.div>
        );
      })}
      {paste.missing.map((n) => (
        <div
          key={`missing-${n}`}
          role="group"
          aria-label={`Paste ${n} is no longer on this device`}
          className={cn("flex max-w-[300px] min-w-0 items-center gap-2 rounded-[12px] bg-error/10 py-1 pr-1 pl-2.5 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)]", mobile ? "h-11" : "h-10")}
        >
          <TriangleAlert className="size-4 shrink-0 text-error" aria-hidden />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[12px] font-bold text-ink">Paste #{n}</span>
            <span className="truncate text-[10.5px] font-semibold text-error">not on this device</span>
          </span>
          <button type="button" aria-label={`Remove the marker of paste ${n}`} onMouseDown={(e) => e.preventDefault()} onClick={() => paste.removeMissing(n)} className={btn}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The paste menu above the composer: omp's large-paste menu when a paste reaches the host's
 * `paste.largeMenuThreshold` (same three choices, same words; Esc keeps it inline), or a chip's
 * menu (also Edit as text and Remove). The first lines of the paste head it.
 */
export function PasteMenu({ paste, mobile = false }: { paste: PasteAttach; mobile?: boolean }) {
  const { menu, menuPaste: p, menuItems } = paste;
  if (!menu || !p) return null;
  const lines = previewLines(p.text, MENU_PREVIEW_LINES);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: spring.snappy }}
      className="absolute inset-x-0 bottom-full z-popover mb-2 overflow-hidden rounded-lg bg-[linear-gradient(180deg,#22222e,#181820)] shadow-[var(--shadow-d3),inset_0_0_0_1px_rgb(255_255_255/0.09)]"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          paste.close();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-2xs font-bold text-mute-2">
        <ClipboardPaste className="size-3" />
        {menu.auto ? `Pasted ${lineCount(p.text).toLocaleString("en-US")} lines` : `Paste #${p.n} · ${pasteSize(p.text)}`}
        {!mobile && (
          <span className="ml-auto flex items-center gap-1">
            <Kbd>↑↓</Kbd>
            <Kbd>Enter</Kbd>
            <Kbd>Esc</Kbd>
            <span className="ml-1 font-semibold">{menu.auto ? "pastes inline" : "closes"}</span>
          </span>
        )}
      </div>
      <pre className="max-h-[7.5lh] overflow-hidden border-b border-line bg-black/20 px-3 py-2 font-mono text-[11px] leading-[1.25] whitespace-pre text-ink-2 [mask-image:linear-gradient(180deg,#000_70%,transparent)]">
        {lines.join("\n")}
      </pre>
      <div role="listbox" aria-label={menu.auto ? `Pasted ${lineCount(p.text)} lines` : `Paste ${p.n}`} className="p-1">
        {menuItems.map((item, i) => (
          <button
            key={item.action}
            type="button"
            role="option"
            aria-selected={i === menu.sel}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            onMouseEnter={() => !item.disabled && paste.highlight(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => paste.choose(item.action)}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2.5 text-left",
              mobile ? "min-h-11 py-1.5" : "py-1.5",
              i === menu.sel && !item.disabled ? "bg-accent/18 text-ink" : "text-ink-2",
              item.disabled && "cursor-not-allowed opacity-45",
              item.action === "remove" && "text-error",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[12.5px] font-bold">{item.label}</span>
              <span className="truncate text-xs text-mute">{item.description}</span>
            </span>
            {item.checked && <Check className="size-4 shrink-0 text-accent-hi" aria-label="current" />}
          </button>
        ))}
      </div>
    </motion.div>
  );
}
