import { AnimatePresence, motion } from "motion/react";
import { spring, TitleBar } from "@/design";
import { useRoute, useUi } from "@/core";
import { isBare } from "@/app/routes";
import { NotificationBell } from "@/features/notify/NotificationCenter";
import { Sidebar } from "./Sidebar";
import { SplitFrame } from "./SplitView";
import { GlobalHeartbeat, HostPill, NeedsCounter, SearchField } from "./TitleBarParts";
import { ViewStage } from "./ViewStage";

/**
 * Desktop frame: custom title bar, collapsible sidebar, routed views with an optional split.
 * Focus mode (`useUi().focusMode`: the session's and the wall's F) and bare screens (ambient mode,
 * `isBare`) slide the sidebar and split away; the title bar stays for the window controls and drag region.
 */
export function DesktopShell() {
  const bare = isBare(useRoute());
  const focus = useUi((s) => s.focusMode) || bare;
  return (
    <div className="flex h-full flex-col">
      <TitleBar
        subtitle={
          <span className="flex items-center gap-3">
            <HostPill />
            <GlobalHeartbeat className="hidden lg:flex" />
          </span>
        }
        actions={
          <>
            <SearchField />
            <NeedsCounter />
            <NotificationBell />
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <AnimatePresence initial={false}>
          {!focus && (
            <motion.div
              key="sidebar"
              className="h-full shrink-0"
              // Clip only while sliding: the collapsed rail's peek overlay must spill over the view.
              initial={{ width: 0, opacity: 0, overflow: "hidden" }}
              animate={{ width: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
              exit={{ width: 0, opacity: 0, overflow: "hidden" }}
              transition={spring.smooth}
            >
              <Sidebar />
            </motion.div>
          )}
        </AnimatePresence>
        <main className="relative min-h-0 min-w-0 flex-1">
          <SplitFrame>
            <ViewStage mobile={false} />
          </SplitFrame>
        </main>
      </div>
    </div>
  );
}
