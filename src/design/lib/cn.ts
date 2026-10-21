import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge taught about TeleFlock's custom theme names so overrides resolve correctly. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["display", "hero", "hero-fit", "mega"],
      radius: ["tile", "sheet"],
      shadow: ["d1", "d2", "d3", "key", "hairline", "glow-accent", "glow-sun", "glow-run", "glow-review", "glow-done", "glow-error"],
      ease: ["spring", "out-expo", "in-out-sine"],
      animate: ["spin-slow", "breathe", "ping-soft", "blink", "shimmer", "gradient-pan", "sun-pulse", "rise-in"],
      tracking: ["kicker"],
    },
  },
});

/** Compose class names; later Tailwind classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
