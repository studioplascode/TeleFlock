import { spring } from "@/design";

/** One line of the board's notice box (the strips share one box instead of stacking boxes). */
export const noticeRow = "flex items-center gap-3 px-4 py-2 text-xs max-md:px-3";

/** How a notice row comes and goes. */
export const noticeRise = { initial: { opacity: 0, y: -8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: spring.smooth } as const;
