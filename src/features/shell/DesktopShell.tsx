import { TitleBar } from "@/design";
import { NotificationBell } from "@/features/notify/NotificationCenter";
import { Sidebar } from "./Sidebar";
import { SplitFrame } from "./SplitView";
import { GlobalHeartbeat, HostPill, NeedsCounter, SearchField } from "./TitleBarParts";
import { ViewStage } from "./ViewStage";

/** Desktop frame: custom title bar, collapsible sidebar, routed views with an optional split. */
export function DesktopShell() {
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
        <Sidebar />
        <main className="relative min-h-0 min-w-0 flex-1">
          <SplitFrame>
            <ViewStage mobile={false} />
          </SplitFrame>
        </main>
      </div>
    </div>
  );
}
