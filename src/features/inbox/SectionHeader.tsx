import type { ReactNode } from "react";

/** An Inbox section's header: title, a count or order note, actions on the right. */
export function SectionHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2.5 px-1">
      <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
      {meta && <span className="text-xs font-bold text-mute">{meta}</span>}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}
