import * as RadixSwitch from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

export interface SwitchProps extends RadixSwitch.SwitchProps {
  /** Accessible label when there is no visible <label>. */
  label?: string;
}

/** On/off switch. On = omp gradient track with glow; the thumb springs across. */
export function Switch({ className, label, ...rest }: SwitchProps) {
  return (
    <RadixSwitch.Root
      aria-label={label}
      className={cn(
        "group relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full bg-tile-4 shadow-[inset_0_0_0_1px_var(--color-line-2)] transition-[background-color,box-shadow] duration-300 touch-hit focus-ring disabled:opacity-45 data-[state=checked]:bg-omp data-[state=checked]:shadow-[0_4px_12px_-4px_rgb(163_92_240/0.9)]",
        className,
      )}
      {...rest}
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.4)] transition-transform duration-[450ms] ease-spring group-active:scale-x-110 data-[state=checked]:translate-x-4" />
    </RadixSwitch.Root>
  );
}
