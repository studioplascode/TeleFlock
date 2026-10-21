import { ChevronLeft } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn, IconButton, spring } from "@/design";
import { navigate } from "@/core";
import { haptic } from "./haptics";

export interface MobileHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Show a back chevron (history back, falling back to the board). */
  back?: boolean;
  /** Right-aligned buttons. */
  actions?: ReactNode;
  className?: string;
}

/** Go back in history when there is an in-app entry to return to, else land on the board. */
export function goBack(): void {
  haptic("tick");
  if (window.history.length > 1) window.history.back();
  else navigate({ name: "board" }, { replace: true });
}

/** Sticky, frosted top bar for mobile screens. The title springs in on mount. */
export function MobileHeader({ title, subtitle, back = false, actions, className }: MobileHeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-sticky flex min-h-14 items-center gap-1.5 bg-[rgb(11_11_16/0.72)] px-3 py-2 backdrop-blur-xl [mask-image:linear-gradient(#000_85%,transparent)]",
        className,
      )}
    >
      {back && (
        <IconButton label="Back" size="lg" onClick={goBack} className="-ml-1.5">
          <ChevronLeft />
        </IconButton>
      )}
      <motion.div
        className={cn("min-w-0 flex-1", !back && "pl-1")}
        initial={{ opacity: 0, x: back ? 12 : 0, y: back ? 0 : 6 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={spring.smooth}
      >
        <h1 className="truncate font-display text-xl font-bold tracking-[-0.02em]">{title}</h1>
        {subtitle && <div className="truncate text-xs text-mute">{subtitle}</div>}
      </motion.div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}
