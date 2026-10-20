import { useId } from "react";
import { cn } from "../lib/cn";

export interface SpinnerProps {
  /** px (default 16). */
  size?: number;
  className?: string;
  label?: string;
}

/** Gradient arc spinner. Keeps spinning under reduced motion (it is essential status, not decoration). */
export function Spinner({ size = 16, className, label = "Loading" }: SpinnerProps) {
  const id = `tf-spin-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("animate-spin tf-keep shrink-0", className)}
      style={{ animationDuration: "0.8s" }}
      role="status"
      aria-label={label}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f053d0" />
          <stop offset="0.5" stopColor="#a15eef" />
          <stop offset="1" stopColor="#7fa2e7" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth="2.5" />
      <path d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5" fill="none" stroke={`url(#${id})`} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
