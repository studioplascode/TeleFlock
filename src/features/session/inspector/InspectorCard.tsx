import { ChevronRight } from "lucide-react";
import { type MouseEvent, type ReactNode, useId } from "react";
import { cn } from "@/design";
import { type CardId, useCardCollapsed } from "./cards";

/** A click on the title text toggles; one on something interactive inside the title (a glossary term) does not. */
function titleClick(toggle: () => void) {
  return (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("button,a,input,[tabindex]")) return;
    toggle();
  };
}

function Chevron({ collapsed, name, bodyId, toggle, className }: { collapsed: boolean; name: string; bodyId: string; toggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-controls={collapsed ? undefined : bodyId}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      className={cn("focus-ring grid size-5 shrink-0 place-items-center rounded-sm text-mute hover:text-ink [@media(pointer:coarse)]:size-7", className)}
    >
      <ChevronRight className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} aria-hidden />
    </button>
  );
}

/**
 * An inspector card (desktop rail and the phone's tab bodies): glass chrome, a title row that
 * collapses the card (chevron button, or a click on the title), the collapse remembered per card on
 * this device. Collapsed, the row shows `summary` (else `aside`) on its right and the body unmounts.
 */
export function InspectorCard({
  id,
  title,
  label,
  aside,
  summary,
  children,
  className,
}: {
  id: CardId;
  title: ReactNode;
  /** Accessible name when the title isn't plain text. */
  label?: string;
  /** Right side of the title row while open (and while collapsed when there is no `summary`). */
  aside?: ReactNode;
  /** Right side of the title row while collapsed. */
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [collapsed, toggle] = useCardCollapsed(id);
  const bodyId = useId();
  const name = label ?? (typeof title === "string" ? title : id);
  const right = collapsed ? (summary ?? aside) : aside;
  return (
    <section data-panel={id} data-collapsed={collapsed || undefined} className={cn("rounded-[22px] glass px-4 py-3.5 transition-shadow duration-500", className)} aria-label={name}>
      <div className={cn("flex items-center justify-between gap-2", !collapsed && "mb-2.5")}>
        <div onClick={titleClick(toggle)} className="flex min-w-0 cursor-pointer items-center gap-1">
          <Chevron collapsed={collapsed} name={name} bodyId={bodyId} toggle={toggle} className="-ml-1" />
          <div className="kicker truncate">{title}</div>
        </div>
        {right && <span className={cn("text-[11px] font-bold text-mute", collapsed ? "min-w-0 truncate" : "shrink-0")}>{right}</span>}
      </div>
      {!collapsed && <div id={bodyId}>{children}</div>}
    </section>
  );
}

/** A tile inside a card (Spend, Throughput): the same title row, one tile at a time. */
export function CollapsibleTile({ id, title, aside, className, children }: { id: CardId; title: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  const [collapsed, toggle] = useCardCollapsed(id);
  const bodyId = useId();
  return (
    <div className={className} aria-label={title} data-collapsed={collapsed || undefined}>
      <div onClick={titleClick(toggle)} className="flex cursor-pointer items-center justify-between gap-2 text-[10.5px] font-bold text-mute">
        <span className="flex min-w-0 items-center gap-0.5">
          <Chevron collapsed={collapsed} name={title} bodyId={bodyId} toggle={toggle} className="-ml-1.5 size-4 [@media(pointer:coarse)]:size-6" />
          <span className="truncate">{title}</span>
        </span>
        {aside}
      </div>
      {!collapsed && (
        <div id={bodyId} className="mt-1.5 flex flex-col gap-1.5">
          {children}
        </div>
      )}
    </div>
  );
}
