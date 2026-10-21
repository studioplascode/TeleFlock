import * as RadixTabs from "@radix-ui/react-tabs";
import { motion } from "motion/react";
import { createContext, type ReactNode, use, useId, useState } from "react";
import { cn } from "../lib/cn";
import { spring } from "../motion/springs";

interface TabsCtx {
  value: string;
  indicatorId: string;
  variant: "underline" | "pill";
}

const Ctx = createContext<TabsCtx | null>(null);

export interface TabsProps extends Omit<RadixTabs.TabsProps, "value" | "defaultValue" | "onValueChange"> {
  value?: string;
  defaultValue: string;
  onValueChange?: (value: string) => void;
  /** underline (default) for page sections, pill for compact toolbars. */
  variant?: "underline" | "pill";
}

/** Tabs with an animated indicator that slides between triggers. */
export function Tabs({ value: controlled, defaultValue, onValueChange, variant = "underline", children, ...rest }: TabsProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const value = controlled ?? uncontrolled;
  const indicatorId = useId();
  return (
    <Ctx value={{ value, indicatorId, variant }}>
      <RadixTabs.Root
        value={value}
        onValueChange={(v) => {
          setUncontrolled(v);
          onValueChange?.(v);
        }}
        {...rest}
      >
        {children}
      </RadixTabs.Root>
    </Ctx>
  );
}

export function TabsList({ className, ...rest }: RadixTabs.TabsListProps) {
  const ctx = use(Ctx);
  return (
    <RadixTabs.List
      className={cn(
        "relative flex items-center",
        ctx?.variant === "pill" ? "gap-1 rounded-md well p-1" : "gap-5 border-b border-line",
        className,
      )}
      {...rest}
    />
  );
}

export interface TabsTriggerProps extends RadixTabs.TabsTriggerProps {
  /** Count or badge after the label. */
  badge?: ReactNode;
}

export function TabsTrigger({ value, className, children, badge, ...rest }: TabsTriggerProps) {
  const ctx = use(Ctx);
  const on = ctx?.value === value;
  const pill = ctx?.variant === "pill";
  return (
    <RadixTabs.Trigger
      value={value}
      className={cn(
        "relative inline-flex items-center gap-2 font-bold whitespace-nowrap transition-colors touch-hit focus-ring [&_svg]:size-3.5",
        pill ? "h-8 rounded-sm px-3 text-xs" : "h-10 px-0.5 text-sm",
        on ? "text-ink" : "text-mute hover:text-ink",
        className,
      )}
      {...rest}
    >
      {on && ctx && (
        <motion.span
          layoutId={ctx.indicatorId}
          transition={spring.snappy}
          aria-hidden
          className={
            pill
              ? "absolute inset-0 rounded-sm bg-tile-4 shadow-d1"
              : "absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-omp shadow-[0_0_12px_rgb(163_92_240/0.9)]"
          }
        />
      )}
      <span className="relative inline-flex items-center gap-2">
        {children}
        {badge}
      </span>
    </RadixTabs.Trigger>
  );
}

export function TabsContent({ className, ...rest }: RadixTabs.TabsContentProps) {
  return <RadixTabs.Content className={cn("outline-none data-[state=active]:animate-rise-in", className)} {...rest} />;
}
