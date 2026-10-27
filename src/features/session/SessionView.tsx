import { Focus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { agentKey, useAgent, useUi } from "@/core";
import { spring, useCalmMotion, useIsMobile, useMinWidth } from "@/design";
import { usePaletteCommands } from "@/features/palette/registry";
import { Inspector } from "./inspector/Inspector";
import { MobileSession } from "./mobile/MobileSession";
import { SessionPane } from "./SessionPane";

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

/** Narrower than this, the inspector rail leaves (e.g. beside a terminal split). */
const RAIL_MIN_PX = 864;

/**
 * Route view for `#/agent/:hostId/:agentId`. Desktop: session + inspector rail; the rail
 * drops out when the view is too narrow for both (e.g. beside a terminal split).
 * Focus mode (desktop): rail and shell chrome go away, the transcript centres at a reading
 * measure and the composer floats. Phone: full-screen pager between agents with an inspector sheet.
 */
export function SessionView({ hostId, agentId }: { hostId: string; agentId: string }) {
  const mobile = useIsMobile();
  const key = agentKey(hostId, agentId);
  const agent = useAgent(key);
  const focus = useUi((s) => s.focusMode) && !mobile;
  const calm = useCalmMotion();
  const box = useRef<HTMLDivElement>(null);
  const wide = useMinWidth(box, RAIL_MIN_PX);

  // Focus mode is a desktop session state: leaving the view (or going mobile) ends it.
  useEffect(() => {
    if (mobile) useUi.getState().setFocusMode(false);
  }, [mobile]);
  useEffect(() => () => useUi.getState().setFocusMode(false), []);

  // F toggles focus (outside text fields); Esc leaves it (unless an overlay or the composer used it).
  useEffect(() => {
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [cmdk-root]')) return;
      const ui = useUi.getState();
      if ((e.key === "f" || e.key === "F") && !isEditable(e.target)) {
        e.preventDefault();
        ui.setFocusMode(!ui.focusMode);
      } else if (e.key === "Escape" && ui.focusMode) {
        e.preventDefault();
        ui.setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile]);

  const commands = useMemo(
    () =>
      mobile
        ? []
        : [
            {
              id: `session.focus`,
              title: "Focus mode",
              group: "Session",
              keywords: ["zen", "distraction", "fullscreen"],
              icon: <Focus />,
              shortcut: "F",
              run: () => useUi.getState().setFocusMode(!useUi.getState().focusMode),
            },
          ],
    [mobile],
  );
  usePaletteCommands(commands);

  if (mobile) return <MobileSession hostId={hostId} agentId={agentId} />;
  const rail = agent?.omp?.link === "live" && !focus && wide;
  const transition = calm ? { duration: 0 } : spring.smooth;
  // focus mode and the rail are all that move these two: they measure their layout only when one changes
  const arrangement = `${focus}/${rail}`;
  return (
    <div ref={box} className="@container relative flex h-full min-h-0 gap-5 p-4 pt-3" data-focus={focus || undefined}>
      <motion.div
        layout
        layoutDependency={arrangement}
        transition={transition}
        className={focus ? "mx-auto flex h-full min-h-0 w-full max-w-[860px] flex-col pb-2" : "flex min-h-0 min-w-0 flex-1 flex-col"}
      >
        <SessionPane key={key} agentKey={key} focus={focus} inspector={rail} />
      </motion.div>
      <AnimatePresence initial={false}>
        {rail && (
          <motion.div
            key="rail"
            layout
            layoutDependency={arrangement}
            initial={calm ? { opacity: 0 } : { opacity: 0, x: 48 }}
            animate={{ opacity: 1, x: 0, transition }}
            exit={calm ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 48, transition: { duration: 0.18 } }}
            className="flex min-h-0 w-[336px] shrink-0"
          >
            <Inspector agentKey={key} className="w-full" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
