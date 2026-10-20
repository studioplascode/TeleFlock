import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Mount once near the root (DesignProvider does this). */
export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  content: ReactNode;
  /** Keyboard shortcut shown after the text, e.g. "Ctrl K". */
  shortcut?: string;
  side?: RadixTooltip.TooltipContentProps["side"];
  align?: RadixTooltip.TooltipContentProps["align"];
  /** The trigger: a single focusable element. */
  children: ReactNode;
  className?: string;
}

/** Small glass tooltip with an optional shortcut hint. */
export function Tooltip({ content, shortcut, side = "top", align = "center", children, className }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            "tf-pop z-tooltip flex max-w-72 items-center gap-2 rounded-sm bg-[rgb(38_36_50/0.94)] px-2.5 py-1.5 text-xs font-semibold text-ink shadow-[var(--shadow-d2),inset_0_0_0_1px_var(--color-line-2)] backdrop-blur-xl select-none",
            className,
          )}
        >
          {content}
          {shortcut && (
            <span className="flex gap-0.5">
              {shortcut.split(" ").map((k) => (
                <kbd key={k} className="rounded-[5px] bg-white/10 px-1 font-mono text-[10px] text-mute">
                  {k}
                </kbd>
              ))}
            </span>
          )}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
