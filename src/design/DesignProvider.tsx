import type { ReactNode } from "react";
import { MotionProvider } from "./motion/MotionProvider";
import { Toaster } from "./ui/Toast";
import { TooltipProvider } from "./ui/Tooltip";

/** Mount once at the app root: motion preference, tooltip timing, toast host. */
export function DesignProvider({ children }: { children: ReactNode }) {
  return (
    <MotionProvider>
      <TooltipProvider delayDuration={350} skipDelayDuration={150}>
        {children}
        <Toaster />
      </TooltipProvider>
    </MotionProvider>
  );
}
