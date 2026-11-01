import { Slot } from "@radix-ui/react-slot";
import type { HTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn";

export type TileVariant = "default" | "flat" | "glass" | "deep" | "sunset" | "omp";

const tileVariants: Record<TileVariant, string> = {
  /** Bento tile: tile-2→tile-1 gradient, 28px radius, layered depth. */
  default: "tile",
  /** Quiet lane/background container: hairline, no gradient. */
  flat: "rounded-tile bg-ink/[0.018] shadow-hairline",
  /** Frosted floating pane (session view, sheets over content). */
  glass: "rounded-tile glass",
  /** Terminal/well surface. */
  deep: "rounded-tile bg-bg-deep shadow-[var(--shadow-d2),inset_0_0_0_1px_var(--color-line)]",
  /** Needs-you hero: sunset gradient with pulsing glow; text tokens re-mapped to --color-on-sun (card-sunset). */
  sunset: "rounded-tile card-sunset sun-pulse shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]",
  /** Brand hero tile in the omp gradient; text tokens re-mapped to --color-on-accent (card-omp). */
  omp: "rounded-tile card-omp shadow-[inset_0_1px_0_rgb(255_255_255/0.3),var(--shadow-glow-accent)]",
};

export interface TileProps extends HTMLAttributes<HTMLDivElement> {
  variant?: TileVariant;
  /** Render as the child element. */
  asChild?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** Bento tile (28px radius). Padding is the caller's: use p-4/p-5. */
export function Tile({ variant = "default", asChild = false, className, ...rest }: TileProps) {
  const Comp = asChild ? Slot : "div";
  return <Comp className={cn("relative", tileVariants[variant], className)} {...rest} />;
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  asChild?: boolean;
  /** Visual pressed/selected state (accent ring). */
  selected?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** Raised card inside tiles/lanes (22px radius, tile-3→tile-2). */
export function Card({ asChild = false, selected = false, className, ...rest }: CardProps) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-selected={selected || undefined}
      className={cn(
        "card-surface p-3",
        selected && "shadow-[var(--shadow-d1),inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-accent)_70%,transparent),0_0_24px_-6px_color-mix(in_srgb,var(--color-accent)_60%,transparent)]",
        className,
      )}
      {...rest}
    />
  );
}
