import * as RadixContext from "@radix-ui/react-context-menu";
import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

const contentCls =
  "tf-pop z-popover min-w-52 overflow-hidden rounded-lg bg-[linear-gradient(180deg,#22222e,#191921)] p-1.5 text-sm shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)] outline-none";
const itemCls =
  "relative flex h-9 cursor-default items-center gap-2.5 rounded-sm px-2.5 font-semibold text-ink-2 outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/7 data-[highlighted]:text-ink [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-mute data-[highlighted]:[&_svg]:text-ink";
const dangerCls = "text-[#ff8aa5] data-[highlighted]:bg-error/15 data-[highlighted]:text-[#ffb1c1] [&_svg]:text-[#ff8aa5]";
const labelCls = "px-2.5 pt-2 pb-1 kicker";
const sepCls = "mx-1 my-1.5 h-px bg-line-2";

interface ItemExtras {
  icon?: ReactNode;
  /** Shortcut text on the right ("Ctrl K"). */
  shortcut?: string;
  danger?: boolean;
}

function ItemBody({ icon, shortcut, children }: ItemExtras & { children?: ReactNode }) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="ml-4 font-mono text-2xs text-mute-2">{shortcut}</span>}
    </>
  );
}

/* ---------- DropdownMenu ---------- */
export const DropdownMenu = RadixDropdown.Root;
export const DropdownMenuTrigger = RadixDropdown.Trigger;
export const DropdownMenuGroup = RadixDropdown.Group;

export function DropdownMenuContent({ className, sideOffset = 6, collisionPadding = 12, ...rest }: RadixDropdown.DropdownMenuContentProps) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn(contentCls, className)} {...rest} />
    </RadixDropdown.Portal>
  );
}

export function DropdownMenuItem({ icon, shortcut, danger, className, children, ...rest }: RadixDropdown.DropdownMenuItemProps & ItemExtras) {
  return (
    <RadixDropdown.Item className={cn(itemCls, danger && dangerCls, className)} {...rest}>
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </RadixDropdown.Item>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...rest }: RadixDropdown.DropdownMenuCheckboxItemProps) {
  return (
    <RadixDropdown.CheckboxItem className={cn(itemCls, "pl-8", className)} {...rest}>
      <RadixDropdown.ItemIndicator className="absolute left-2.5">
        <Check className="!text-accent" />
      </RadixDropdown.ItemIndicator>
      {children}
    </RadixDropdown.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...rest }: RadixDropdown.DropdownMenuLabelProps) {
  return <RadixDropdown.Label className={cn(labelCls, className)} {...rest} />;
}

export function DropdownMenuSeparator({ className, ...rest }: RadixDropdown.DropdownMenuSeparatorProps) {
  return <RadixDropdown.Separator className={cn(sepCls, className)} {...rest} />;
}

/* ---------- ContextMenu (right-click / long-press) ---------- */
export const ContextMenu = RadixContext.Root;
export const ContextMenuTrigger = RadixContext.Trigger;
export const ContextMenuGroup = RadixContext.Group;

export function ContextMenuContent({ className, collisionPadding = 12, ...rest }: RadixContext.ContextMenuContentProps) {
  return (
    <RadixContext.Portal>
      <RadixContext.Content collisionPadding={collisionPadding} className={cn(contentCls, className)} {...rest} />
    </RadixContext.Portal>
  );
}

export function ContextMenuItem({ icon, shortcut, danger, className, children, ...rest }: RadixContext.ContextMenuItemProps & ItemExtras) {
  return (
    <RadixContext.Item className={cn(itemCls, danger && dangerCls, className)} {...rest}>
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </RadixContext.Item>
  );
}

export function ContextMenuLabel({ className, ...rest }: RadixContext.ContextMenuLabelProps) {
  return <RadixContext.Label className={cn(labelCls, className)} {...rest} />;
}

export function ContextMenuSeparator({ className, ...rest }: RadixContext.ContextMenuSeparatorProps) {
  return <RadixContext.Separator className={cn(sepCls, className)} {...rest} />;
}
