import { Globe } from "lucide-react";
import { navigate, useUi } from "@/core";
import { SplitHeaderRow } from "@/features/shell/SplitHeaderRow";
import { BrowserSurface } from "./BrowserView";

/** The browser beside a session (the split panel): the shared header row, then the panel. */
export function BrowserSplit({ agentKey }: { agentKey?: string }) {
  const expand = () => {
    useUi.getState().setSplit(null);
    navigate({ name: "browser" });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SplitHeaderRow icon={<Globe className="size-4 text-mute" />} title="Browser" onExpand={expand} expandLabel="Open the Browser page" />
      <div className="min-h-0 flex-1">
        <BrowserSurface mode="split" agentKey={agentKey} />
      </div>
    </div>
  );
}
