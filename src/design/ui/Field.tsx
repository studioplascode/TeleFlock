import { type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes, useId } from "react";
import { cn } from "../lib/cn";

const fieldBox =
  "well rounded-md text-sm text-ink transition-[box-shadow,background-color] duration-200 placeholder:text-mute-2 hover:bg-[rgb(10_10_16/0.7)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-accent),0_0_0_4px_rgb(163_92_240/0.18)] has-[:disabled]:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1.5px_var(--color-error)]";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Icon or text before the value (e.g. a search icon). */
  leading?: ReactNode;
  /** Icon/Kbd/button after the value. */
  trailing?: ReactNode;
  /** Classes for the outer box (the <input> gets `className`). */
  boxClassName?: string;
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/** Text input in a well. Focus draws the omp-purple ring on the whole box. */
export function Input({ leading, trailing, boxClassName, className, invalid, ...rest }: InputProps) {
  return (
    <div
      aria-invalid={invalid || undefined}
      className={cn(fieldBox, "flex h-10 items-center gap-2 px-3 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-mute-2", boxClassName)}
    >
      {leading}
      <input
        aria-invalid={invalid || undefined}
        className={cn("h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-mute-2 focus-visible:outline-none", className)}
        {...rest}
      />
      {trailing}
    </div>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with content up to this many px (default 240). */
  maxHeight?: number;
  boxClassName?: string;
  invalid?: boolean;
  /** Toolbar row rendered under the text (composer buttons). */
  footer?: ReactNode;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Auto-growing textarea (CSS field-sizing) in a well. */
export function Textarea({ maxHeight = 240, boxClassName, className, invalid, footer, style, ...rest }: TextareaProps) {
  return (
    <div aria-invalid={invalid || undefined} className={cn(fieldBox, "flex flex-col px-3 py-2.5", boxClassName)}>
      <textarea
        aria-invalid={invalid || undefined}
        className={cn(
          "min-h-[1.5lh] w-full resize-none bg-transparent leading-normal outline-none [field-sizing:content] placeholder:text-mute-2 focus-visible:outline-none",
          className,
        )}
        style={{ maxHeight, ...style }}
        {...rest}
      />
      {footer && <div className="mt-2 flex items-center gap-1.5">{footer}</div>}
    </div>
  );
}

export interface FieldProps {
  label: ReactNode;
  /** Right-aligned hint in the label row (e.g. "auto", "required"). */
  hint?: ReactNode;
  /** Help or error text under the control. */
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  /** Receives the generated id; put it on the control. */
  children: (id: string) => ReactNode;
}

/** Label + control + help text, wired up with ids. */
export function Field({ label, hint, description, error, className, children }: FieldProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="flex items-center gap-2 text-2xs font-bold tracking-[0.02em] text-mute">
        {label}
        {hint && <span className="ml-auto font-semibold text-mute-2">{hint}</span>}
      </label>
      {children(id)}
      {error ? (
        <p className="text-xs font-semibold text-error">{error}</p>
      ) : (
        description && <p className="text-xs text-mute-2">{description}</p>
      )}
    </div>
  );
}
