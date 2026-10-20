import type { CSSProperties } from "react";
import { cn } from "../lib/cn";
import { STATUS, type Status } from "../tokens";
import { type ActivityTier, BREATH_SECONDS } from "./activity";

export interface StatusOrbProps {
  status: Status;
  /** Breath speed follows activity: silent breathes slowly, frantic pants. Ignored for non-live statuses. */
  activity?: ActivityTier;
  /** Diameter in px (default 10). */
  size?: number;
  className?: string;
  /** Accessible label; defaults to the status label. Pass `null` when a visible label is adjacent. */
  label?: string | null;
}

/** A living status dot: breathing halo (rate = activity), spinning core when running, ping when loud. */
export function StatusOrb({ status, activity = "steady", size = 10, className, label }: StatusOrbProps) {
  const meta = STATUS[status];
  const breath = status === "needs-you" ? 1.1 : status === "error" ? 1.6 : BREATH_SECONDS[activity];
  const style = { "--orb-size": `${size}px`, "--tf-breath": `${breath}s` } as CSSProperties;
  const a11y = label === null ? { "aria-hidden": true as const } : { role: "img", "aria-label": label ?? meta.label };
  return (
    <span data-status={status} data-activity={activity} className={cn("tf-orb", className)} style={style} {...a11y}>
      {meta.live && <span className="tf-orb__halo tf-loop" />}
      {meta.loud && <span className="tf-orb__ping tf-loop" />}
      <span className={cn("tf-orb__core", status === "running" && "tf-loop")} />
    </span>
  );
}
