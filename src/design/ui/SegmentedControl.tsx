import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { motion } from "motion/react";
import { type ReactNode, useId } from "react";
import { cn } from "../lib/cn";
import { spring } from "../motion/springs";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  size?: "sm" | "md";
  /** Stretch segments to fill the width. */
  fill?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** Single-choice segmented control; the selected pill glides between segments. */
export function SegmentedControl<T extends string>({ value, onValueChange, options, size = "md", fill = false, className, ...rest }: SegmentedControlProps<T>) {
  const pillId = useId();
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v as T);
      }}
      aria-label={rest["aria-label"]}
      className={cn("inline-flex gap-1 rounded-md well p-1", fill && "flex w-full", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <ToggleGroup.Item
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            className={cn(
              "relative inline-flex items-center justify-center gap-1.5 rounded-sm font-bold whitespace-nowrap transition-colors touch-hit focus-ring disabled:opacity-40 [&_svg]:size-3.5",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-sm",
              fill && "flex-1",
              on ? "text-ink" : "text-mute hover:text-ink",
            )}
          >
            {on && (
              <motion.span
                layoutId={pillId}
                transition={spring.snappy}
                className="absolute inset-0 rounded-sm bg-tile-4 shadow-d1"
                aria-hidden
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {o.icon}
              {o.label}
            </span>
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}
