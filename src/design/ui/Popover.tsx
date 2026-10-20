import * as RadixPopover from "@radix-ui/react-popover";
import { cn } from "../lib/cn";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

/** Floating glass panel anchored to its trigger. */
export function PopoverContent({ className, sideOffset = 8, collisionPadding = 12, ...rest }: RadixPopover.PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "tf-pop z-popover max-h-[var(--radix-popover-content-available-height)] min-w-56 overflow-auto rounded-lg bg-[linear-gradient(180deg,#22222e,#191921)] p-3 text-sm shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)] outline-none",
          className,
        )}
        {...rest}
      />
    </RadixPopover.Portal>
  );
}
