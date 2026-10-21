import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { spring } from "../motion/springs";

export interface PageHeaderProps {
  /** Small uppercase eyebrow above the title. */
  kicker?: ReactNode;
  title: ReactNode;
  /** Inline after the title (live orb, counts). */
  meta?: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls, bottom-aligned with the title. */
  actions?: ReactNode;
  className?: string;
}

const lines = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const line = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring.smooth } };

/**
 * Desktop page title block shared by every full-page view (Inbox, Activity, Usage, Hosts,
 * Settings): eyebrow, display title, inline meta, description and actions, staggering in on mount.
 * Place it inside the page's content column so it lines up with the content below.
 */
export function PageHeader({ kicker, title, meta, description, actions, className }: PageHeaderProps) {
  return (
    <motion.header initial="hidden" animate="show" variants={lines} className={cn("flex flex-wrap items-end gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 flex-1">
        {kicker && (
          <motion.div variants={line} className="kicker">
            {kicker}
          </motion.div>
        )}
        <motion.div variants={line} className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="font-display text-display font-bold text-ink">{title}</h1>
          {meta && <div className="flex items-center gap-2 pt-1.5 text-xs font-bold text-mute">{meta}</div>}
        </motion.div>
        {description && (
          <motion.p variants={line} className="mt-1.5 max-w-2xl text-sm text-mute">
            {description}
          </motion.p>
        )}
      </div>
      {actions && (
        <motion.div variants={line} className="flex shrink-0 items-center gap-2">
          {actions}
        </motion.div>
      )}
    </motion.header>
  );
}
