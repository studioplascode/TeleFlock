import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Secondary line (e.g. model provider). */
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Accessible name when there's no <label htmlFor>. */
  "aria-label"?: string;
  id?: string;
}

/** Native-feeling select with a glass popup. Keyboard and typeahead from Radix. */
export function Select({ options, placeholder = "Select…", className, id, ...rest }: SelectProps) {
  return (
    <RadixSelect.Root value={rest.value} defaultValue={rest.defaultValue} onValueChange={rest.onValueChange} disabled={rest.disabled}>
      <RadixSelect.Trigger
        id={id}
        aria-label={rest["aria-label"]}
        className={cn(
          "well inline-flex h-10 min-w-40 items-center justify-between gap-2 rounded-md px-3 text-sm font-semibold text-ink transition-shadow focus-ring hover:bg-[rgb(10_10_16/0.7)] disabled:opacity-45 data-[placeholder]:text-mute-2 data-[state=open]:shadow-[inset_0_0_0_1.5px_var(--color-accent)] [&>span]:truncate",
          className,
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDown className="size-4 text-mute transition-transform" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className="tf-pop z-popover max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg bg-[linear-gradient(180deg,#22222e,#191921)] shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)]"
        >
          <RadixSelect.Viewport className="p-1.5">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex min-h-9 cursor-default items-center gap-2.5 rounded-sm py-1.5 pr-8 pl-2.5 text-sm font-semibold text-ink-2 outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/7 data-[highlighted]:text-ink data-[state=checked]:text-ink [&_svg]:size-4"
              >
                {o.icon}
                <span className="flex min-w-0 flex-col">
                  <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                  {o.hint && <span className="text-2xs font-medium text-mute-2">{o.hint}</span>}
                </span>
                <RadixSelect.ItemIndicator className="absolute right-2.5">
                  <Check className="text-accent" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
