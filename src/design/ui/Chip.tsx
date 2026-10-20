import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import type { ActivityTier } from "../motion/activity";
import { StatusOrb } from "../motion/StatusOrb";
import { STATUS, type Status } from "../tokens";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** neutral (default), accent (omp purple), or a status tint. */
  tone?: "neutral" | "accent" | Status;
  /** Solid gradient fill instead of a soft tint. */
  solid?: boolean;
  icon?: ReactNode;
}

/** Rounded info chip: model names, branches, counts, tool names. */
export function Chip({ tone = "neutral", solid = false, icon, className, children, ...rest }: ChipProps) {
  const isStatus = tone !== "neutral" && tone !== "accent";
  return (
    <span
      data-status={isStatus ? tone : undefined}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold whitespace-nowrap [&_svg]:size-3",
        tone === "neutral" && "bg-white/6 text-[#d6d6e0] shadow-hairline",
        tone === "accent" && (solid ? "bg-omp text-white shadow-glow-accent" : "bg-accent/14 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)]"),
        isStatus && (solid ? "st-bg st-glow" : "st-soft st-ring"),
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "accent" | Status;
}

/** Tiny uppercase label badge ("QUESTION", "APPROVAL", "READY TO REVIEW"). Loud statuses are solid. */
export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  const isStatus = tone !== "neutral" && tone !== "accent";
  const loud = isStatus && STATUS[tone].loud;
  return (
    <span
      data-status={isStatus ? tone : undefined}
      className={cn(
        "inline-flex h-[19px] shrink-0 items-center rounded-full px-2 text-[9.5px] font-extrabold tracking-[0.09em] uppercase whitespace-nowrap",
        tone === "neutral" && "bg-white/8 text-mute",
        tone === "accent" && "bg-accent/18 text-accent-ink",
        isStatus && (loud ? "st-bg shadow-[0_4px_12px_-2px_rgb(var(--st-rgb)/0.6)]" : "st-soft"),
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/** Sunset count bubble (unread asks, notifications). Hidden at 0. */
export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-sun px-1.5 text-[10.5px] leading-none font-extrabold text-white tabular",
        className,
      )}
      aria-label={`${count} pending`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Keyboard key. Pass the key text as children, e.g. <Kbd>Ctrl</Kbd><Kbd>K</Kbd>. */
export function Kbd({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs bg-tile-3 px-1.5 font-mono text-2xs font-semibold text-mute shadow-key",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}

export interface StatusPillProps {
  status: Status;
  activity?: ActivityTier;
  /** Overrides the default status label. */
  children?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}

/** Orb + label pill. Needs-you is a solid sunset pill (the loudest thing in the app). */
export function StatusPill({ status, activity, children, size = "md", className }: StatusPillProps) {
  const loud = status === "needs-you";
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full font-display font-bold tracking-[0.1em] uppercase whitespace-nowrap",
        size === "sm" ? "h-[22px] pr-2.5 pl-2 text-[9.5px]" : "h-7 pr-3 pl-2.5 text-2xs",
        loud ? "st-bg shadow-glow-sun" : "st-soft st-ring",
        className,
      )}
    >
      <StatusOrb status={status} activity={activity} size={size === "sm" ? 6 : 7} label={null} className={loud ? "[--st-grad:#fff] [--st-rgb:255_255_255]" : undefined} />
      {children ?? STATUS[status].label}
    </span>
  );
}
