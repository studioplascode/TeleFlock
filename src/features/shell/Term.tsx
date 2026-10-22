import type { ReactNode } from "react";
import { cn, Popover, PopoverContent, PopoverTrigger, Tooltip, useFinePointer } from "@/design";
import { GLOSSARY, type GlossaryId } from "./glossary";

/**
 * A term with a plain-language meaning: dotted underline, tooltip on hover/focus (desktop) or a
 * small popover on tap (touch, where tooltips never open). The visible text stays as written.
 */
export function Term({ id, children, className }: { id: GlossaryId; children?: ReactNode; className?: string }) {
  const fine = useFinePointer();
  const entry = GLOSSARY[id];
  const text = children ?? entry.term;
  const trigger = cn("cursor-help underline decoration-white/30 decoration-dotted underline-offset-[3px] focus-ring rounded-[3px]", className);
  if (fine) {
    return (
      <Tooltip content={<span className="font-medium">{entry.text}</span>}>
        <span tabIndex={0} className={trigger}>
          {text}
        </span>
      </Tooltip>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(trigger, "text-left")} onClick={(e) => e.stopPropagation()}>
          {text}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-72 text-xs leading-relaxed text-ink-2" side="top">
        <span className="mb-1 block font-bold text-ink">{entry.term}</span>
        {entry.text}
      </PopoverContent>
    </Popover>
  );
}
