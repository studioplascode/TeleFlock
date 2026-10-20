import * as RadixScroll from "@radix-ui/react-scroll-area";
import type { Ref } from "react";
import { cn } from "../lib/cn";

export interface ScrollAreaProps extends RadixScroll.ScrollAreaProps {
  /** Classes for the scrolling viewport. */
  viewportClassName?: string;
  /** Ref to the scrolling viewport (for virtualizers / scroll-to-bottom). */
  viewportRef?: Ref<HTMLDivElement>;
  /** Fade the top/bottom edges of the content. */
  fade?: boolean;
}

/** Custom-scrollbar scroll container (thin, quiet thumb that brightens on hover). */
export function ScrollArea({ className, viewportClassName, viewportRef, fade = false, children, ...rest }: ScrollAreaProps) {
  return (
    <RadixScroll.Root type="hover" scrollHideDelay={500} className={cn("relative overflow-hidden", className)} {...rest}>
      <RadixScroll.Viewport
        ref={viewportRef}
        className={cn(
          "size-full rounded-[inherit]",
          fade && "[mask-image:linear-gradient(transparent,#000_24px,#000_calc(100%-24px),transparent)]",
          viewportClassName,
        )}
      >
        {children}
      </RadixScroll.Viewport>
      {(["vertical", "horizontal"] as const).map((o) => (
        <RadixScroll.Scrollbar
          key={o}
          orientation={o}
          className="z-raised flex touch-none p-0.5 transition-colors select-none data-[orientation=horizontal]:h-2 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:w-2"
        >
          <RadixScroll.Thumb className="relative flex-1 rounded-full bg-white/14 transition-colors hover:bg-white/28" />
        </RadixScroll.Scrollbar>
      ))}
      <RadixScroll.Corner />
    </RadixScroll.Root>
  );
}
