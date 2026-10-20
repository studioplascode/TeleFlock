import { Slot } from "@radix-ui/react-slot";
import type { HTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn";

export type TileVariant = "default" | "flat" | "glass" | "deep" | "sunset" | "omp";

const tileVariants: Record<TileVariant, string> = {
  /** Bento tile: tile-2→tile-1 gradient, 28px radius, layered depth. */
  default: "tile",
  /** Quiet lane/background container: hairline, no gradient. */
  flat: "rounded-tile bg-white/[0.018] shadow-hairline",
  /** Frosted floating pane (session view, sheets over content). */
  glass: "rounded-tile glass",
  /** Terminal/well surface. */
  deep: "rounded-tile bg-bg-deep shadow-[var(--shadow-d2),inset_0_0_0_1px_rgb(255_255_255/0.06)]",
  /** Needs-you hero: sunset gradient with pulsing glow. */
  sunset:
    "rounded-tile text-white sun-pulse shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] [background:radial-gradient(120%_130%_at_100%_0%,rgb(255_61_119/0.95)_0%,transparent_60%),radial-gradient(90%_120%_at_0%_100%,#ff7a18_0%,transparent_70%),linear-gradient(135deg,#ff7a18,#ff3d77)]",
  /** Brand hero tile in the omp gradient. */
  omp: "rounded-tile text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),var(--shadow-glow-accent)] [background:radial-gradient(110%_120%_at_100%_0%,rgb(240_83_208/0.9)_0%,transparent_60%),linear-gradient(135deg,#a15eef,#7fa2e7)]",
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
        selected && "shadow-[var(--shadow-d1),inset_0_0_0_1.5px_rgb(163_92_240/0.7),0_0_24px_-6px_rgb(163_92_240/0.6)]",
        className,
      )}
      {...rest}
    />
  );
}
