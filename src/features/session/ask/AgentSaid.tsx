import { ChevronDown } from "lucide-react";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/design";
import { Markdown } from "../markdown/Markdown";

/** Where the context is drawn: the session ask card, Inbox/HUD panels, desktop board cards, phone Flock cards. */
export type AgentSaidVariant = "ask" | "panel" | "card" | "phone";

const VARIANT: Record<AgentSaidVariant, { box: string; text: string; lines: number; kicker?: string }> = {
  ask: {
    box: "rounded-[16px] bg-[rgb(45_0_22/0.2)] px-3 pt-2 pb-2.5 shadow-[inset_0_0_0_1px_var(--color-line)]",
    text: "text-[13px] leading-[1.5]",
    lines: 4,
    kicker: "text-[10px] font-extrabold tracking-[0.12em] text-mute-2 uppercase",
  },
  panel: { box: "rounded-md well px-3.5 py-2.5 max-md:px-3 max-md:py-2", text: "text-sm leading-[1.55]", lines: 4, kicker: "kicker" },
  card: { box: "border-l-2 border-line-2 pl-2.5", text: "text-xs leading-[1.45] text-mute", lines: 2 },
  phone: { box: "border-l-2 border-line-2 pl-2.5", text: "text-[13px] leading-[1.45] text-mute", lines: 2 },
};

/** Text tokens re-mapped to the sunset's own text colour (the session ask card, the board's hero card). */
const ON_SUN = {
  "--color-ink": "var(--color-on-sun)",
  "--color-ink-2": "color-mix(in srgb, var(--color-on-sun) 94%, transparent)",
  "--color-mute": "color-mix(in srgb, var(--color-on-sun) 84%, transparent)",
  "--color-mute-2": "color-mix(in srgb, var(--color-on-sun) 72%, transparent)",
  "--color-line": "color-mix(in srgb, var(--color-on-sun) 20%, transparent)",
  "--color-line-2": "color-mix(in srgb, var(--color-on-sun) 28%, transparent)",
  "--color-accent": "var(--color-on-sun)",
  "--color-accent-hi": "var(--color-on-sun)",
  "--color-accent-ink": "var(--color-on-sun)",
} as CSSProperties;

/**
 * What the agent wrote before asking, as Markdown, collapsed to a few lines with a fade and "Show
 * more" / "Show less" when it runs longer (measured; short text gets no toggle). The toggle and links
 * keep their clicks, presses and keys to themselves, so a card or swipe row around it never opens.
 */
export function AgentSaid({ text, variant, sunset = false, lines, className }: { text: string; variant: AgentSaidVariant; sunset?: boolean; lines?: number; className?: string }) {
  const v = VARIANT[variant];
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // `text` re-runs the check: a capped box keeps its size while its content grows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);
  const sun = sunset || variant === "ask";
  return (
    <div
      className={cn("relative min-w-0", v.box, className)}
      style={sun ? ON_SUN : undefined}
      onClick={(e) => {
        if (e.target instanceof Element && e.target.closest("a")) e.stopPropagation();
      }}
    >
      {v.kicker && <span className={cn("block", v.kicker)}>Agent said</span>}
      <div
        ref={ref}
        className={cn(v.text, v.kicker && "mt-0.5", !open && "overflow-hidden", !open && overflows && "[mask-image:linear-gradient(to_bottom,#000_50%,transparent)]")}
        style={open ? undefined : { maxHeight: `${lines ?? v.lines}lh` }}
      >
        <Markdown text={text} className={cn(v.text, "max-md:leading-[inherit] [&_[role=heading]]:text-[1.08em] [&_[role=heading]:not(:first-child)]:mt-2")} />
      </div>
      {(overflows || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn("focus-ring mt-0.5 inline-flex items-center gap-1 rounded-xs text-[11px] font-bold", sun ? "text-ink hover:underline" : "text-accent-hi hover:text-ink")}
        >
          <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
