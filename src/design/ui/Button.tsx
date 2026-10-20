import { Slot } from "@radix-ui/react-slot";
import { type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "../lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "sunset";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "relative inline-flex items-center justify-center gap-2 font-bold whitespace-nowrap select-none pressable focus-ring disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45";

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-omp text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),var(--shadow-glow-accent)] hover:brightness-110 active:brightness-95",
  secondary: "bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] hover:bg-tile-5",
  ghost: "text-mute hover:bg-white/6 hover:text-ink",
  danger: "bg-error/12 text-[#ff8aa5] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)] hover:bg-error hover:text-white",
  sunset: "bg-sun text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),var(--shadow-glow-sun)] hover:brightness-110",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs rounded-sm [&_svg]:size-3.5",
  md: "h-10 px-4 text-sm rounded-md [&_svg]:size-4",
  lg: "h-12 px-5 text-md rounded-lg [&_svg]:size-[18px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks clicks. */
  loading?: boolean;
  /** Render as the child element (e.g. an <a>) with button styling. */
  asChild?: boolean;
  /** Icon before the label. */
  icon?: ReactNode;
  /** Icon/kbd after the label. */
  trailing?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** Buttons. primary = omp gradient, sunset = needs-you actions, danger = destructive. */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  asChild = false,
  icon,
  trailing,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const cls = cn(base, variants[variant], sizes[size], className);
  if (asChild) {
    return (
      <Slot className={cls} {...rest}>
        {children}
      </Slot>
    );
  }
  return (
    <button type={type ?? "button"} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner size={size === "lg" ? 18 : 14} /> : icon}
      {children}
      {trailing}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name (also used as the native tooltip). */
  label: string;
  variant?: "ghost" | "secondary" | "primary" | "sunset" | "danger";
  size?: ButtonSize;
  /** Small count/attention badge in the corner. */
  badge?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const iconSizes: Record<ButtonSize, string> = {
  sm: "size-7 rounded-sm [&_svg]:size-3.5",
  md: "size-[34px] rounded-md [&_svg]:size-4",
  lg: "size-10 rounded-md [&_svg]:size-[18px]",
};

/** Square icon-only button with a required label. */
export function IconButton({ label, variant = "ghost", size = "md", badge, className, children, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(base, variants[variant], iconSizes[size], "shrink-0 px-0", className)}
      {...rest}
    >
      {children}
      {badge !== undefined && badge !== null && (
        <span className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-sun px-1 text-[10.5px] leading-none font-extrabold text-white shadow-[0_0_0_3px_var(--color-chrome),0_4px_14px_rgb(255_61_119/0.6)]">
          {badge}
        </span>
      )}
    </button>
  );
}
