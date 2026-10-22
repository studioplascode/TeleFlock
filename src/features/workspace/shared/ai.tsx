import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Tooltip, cn } from "@/design";

/*
 * Small UI pieces shared by every surface that shows or asks for an AI-made value (omp's tiny
 * model role on the host, through `@/core` ai.ts). AI values are always editable suggestions with
 * a deterministic fallback; these only mark and request them.
 */

/** Tooltip of every AI-made value. */
export const AI_TOOLTIP = "Named by omp's tiny model";

/** The small ✨ beside a value the tiny model made (tooltip says so). */
export function AiMark({ className, label = AI_TOOLTIP }: { className?: string; label?: string }) {
  return (
    <Tooltip content={label}>
      <span tabIndex={0} aria-label={label} className={cn("inline-flex shrink-0 cursor-help items-center text-accent-hi focus-ring rounded-[3px]", className)}>
        <Sparkles className="size-3" aria-hidden />
      </span>
    </Tooltip>
  );
}

/**
 * "✨ Suggest": runs `run` and hands a non-null result to `onValue` (never submits anything).
 * A null result (AI off, unavailable, timeout) leaves the field as it is. Pass the field's value as
 * `current`: a result arriving after the user changed the field is dropped, never overwriting typing.
 */
export function SuggestButton({
  run,
  onValue,
  current,
  label = "Suggest",
  title = "Suggest with omp's tiny model",
  disabled,
  className,
  size = "sm",
  variant = "ghost",
}: {
  run: () => Promise<string | null>;
  onValue(value: string): void;
  /** The field's current value; the result applies only if it is still the value at click time. */
  current?: string;
  label?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
}) {
  const [busy, setBusy] = useState(false);
  const [missed, setMissed] = useState(false);
  const latest = useRef(current);
  useEffect(() => {
    latest.current = current;
  });
  return (
    <Button
      size={size}
      variant={variant}
      icon={<Sparkles />}
      loading={busy}
      disabled={disabled}
      title={missed ? "No suggestion this time (tiny model unavailable or too slow)" : title}
      className={cn("shrink-0", className)}
      onClick={async () => {
        const before = current;
        setBusy(true);
        setMissed(false);
        try {
          const v = await run();
          if (!v?.trim()) setMissed(true);
          else if (latest.current === before) onValue(v.trim());
        } catch {
          setMissed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

/** `p`'s value, or null once `ms` passed (the caller then uses its fallback; `p` keeps running and caches). */
export function within<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}
