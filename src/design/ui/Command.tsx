import * as RadixDialog from "@radix-ui/react-dialog";
import { Command as Cmdk } from "cmdk";
import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { overlayClass } from "./Dialog";

/** cmdk root, styled. Use inside CommandDialog or inline. */
export function Command({ className, ...rest }: ComponentProps<typeof Cmdk>) {
  return <Cmdk className={cn("flex size-full flex-col overflow-hidden text-ink", className)} {...rest} />;
}

export function CommandInput({ className, ...rest }: ComponentProps<typeof Cmdk.Input>) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4" cmdk-input-wrapper="">
      <Search className="size-4 shrink-0 text-mute-2" aria-hidden />
      <Cmdk.Input
        className={cn("h-14 w-full bg-transparent text-md font-semibold outline-none placeholder:text-mute-2", className)}
        {...rest}
      />
    </div>
  );
}

export function CommandList({ className, ...rest }: ComponentProps<typeof Cmdk.List>) {
  return (
    <Cmdk.List
      className={cn(
        "max-h-[min(420px,60dvh)] overflow-y-auto overscroll-contain p-2 transition-[height] duration-200 ease-out-expo [height:var(--cmdk-list-height)]",
        className,
      )}
      {...rest}
    />
  );
}

export function CommandEmpty({ className, ...rest }: ComponentProps<typeof Cmdk.Empty>) {
  return <Cmdk.Empty className={cn("py-10 text-center text-sm text-mute", className)} {...rest} />;
}

export function CommandGroup({ className, ...rest }: ComponentProps<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      className={cn("[&_[cmdk-group-heading]]:kicker [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1.5", className)}
      {...rest}
    />
  );
}

export function CommandSeparator({ className, ...rest }: ComponentProps<typeof Cmdk.Separator>) {
  return <Cmdk.Separator className={cn("mx-2 my-1.5 h-px bg-line-2", className)} {...rest} />;
}

export interface CommandItemProps extends ComponentProps<typeof Cmdk.Item> {
  icon?: ReactNode;
  /** Right-side shortcut, e.g. "Ctrl N". */
  shortcut?: string;
}

export function CommandItem({ className, icon, shortcut, children, ...rest }: CommandItemProps) {
  return (
    <Cmdk.Item
      className={cn(
        "flex h-11 cursor-default items-center gap-3 rounded-md px-2.5 text-sm font-semibold text-ink-2 select-none data-[disabled=true]:opacity-40 data-[selected=true]:bg-accent/14 data-[selected=true]:text-ink data-[selected=true]:shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35)] [&_svg]:size-4 [&_svg]:text-mute data-[selected=true]:[&_svg]:text-accent-hi",
        className,
      )}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="font-mono text-2xs text-mute-2">{shortcut}</span>}
    </Cmdk.Item>
  );
}

export interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (visually hidden). */
  title?: string;
  children: ReactNode;
  /** Props for the cmdk root (filter, loop, value…). */
  commandProps?: ComponentProps<typeof Cmdk>;
}

/** Command palette in a blurred modal, anchored high on the screen like Spotlight. */
export function CommandDialog({ open, onOpenChange, title = "Command palette", children, commandProps }: CommandDialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlayClass} />
        <RadixDialog.Content
          className="tf-pop fixed top-[14dvh] left-1/2 z-modal w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-tile bg-[linear-gradient(180deg,#22222e,#18181f)] shadow-[var(--shadow-d3),0_0_0_1px_rgb(255_255_255/0.09),0_0_80px_-20px_rgb(163_92_240/0.45)] outline-none"
        >
          <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">Type a command or search</RadixDialog.Description>
          <Command loop {...commandProps}>
            {children}
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
