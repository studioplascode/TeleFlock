import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons. */
  action?: ReactNode;
  className?: string;
  /** Compact variant for lanes / small panels. */
  compact?: boolean;
}

/** Friendly empty placeholder: floating icon tile, display title, optional action. */
export function EmptyState({ icon, title, description, action, className, compact = false }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 p-5" : "gap-3 p-10", className)}>
      {icon && (
        <div
          className={cn(
            "tf-loop grid place-items-center rounded-lg bg-[linear-gradient(180deg,var(--color-tile-3),var(--color-tile-2))] text-mute shadow-[var(--shadow-d2),inset_0_0_0_1px_var(--color-line)] [animation:tf-float_5s_ease-in-out_infinite]",
            compact ? "size-10 [&_svg]:size-5" : "size-14 [&_svg]:size-6",
          )}
          aria-hidden
        >
          {icon}
        </div>
      )}
      <h3 className={cn("font-display font-semibold text-ink", compact ? "text-md" : "text-xl")}>{title}</h3>
      {description && <p className={cn("max-w-sm text-mute", compact ? "text-xs" : "text-sm")}>{description}</p>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
