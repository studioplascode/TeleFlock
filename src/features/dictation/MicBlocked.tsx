import { ExternalLink, Mic, MicOff, X } from "lucide-react";
import { Button, cn, IconButton } from "@/design";
import type { MicBlocked } from "./useMicAccess";

const shell = "mb-2 rounded-lg bg-warn/10 text-xs font-semibold text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warn)_32%,transparent)]";
/** On the sunset ask card: the translucent dark panel Rambler's card uses there. */
const sunShell = "mb-2 rounded-lg bg-black/20 text-xs font-semibold text-on-sun shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)] [&_button]:text-on-sun [&_svg]:text-on-sun";

/**
 * Above a text box once a tap on its mic found the microphone blocked: who blocks it, where that is undone, and the
 * button that undoes it from here (the system's settings page, or allowing the window). It goes once access is back.
 */
export function MicBlockedCard({ blocked, mobile, tone }: { blocked: MicBlocked; mobile: boolean; tone?: "sun" }) {
  const { block } = blocked;
  const sun = tone === "sun";
  return (
    <div role="alert" className={cn(sun ? sunShell : shell, "flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 py-2", mobile && "text-[13px]")} data-testid="mic-blocked">
      <MicOff className={cn("size-3.5 shrink-0", !sun && "text-warn")} aria-hidden />
      <span className="min-w-0 flex-1 basis-56">
        <span className={cn("font-bold", sun ? "text-on-sun" : "text-ink")}>{block.title}</span> <span className={cn("font-medium", sun ? "text-on-sun/85" : "text-mute")}>{block.detail}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {block.action && (
          <Button size="sm" variant="secondary" icon={block.action.run === "settings" ? <ExternalLink /> : <Mic />} loading={blocked.busy} onClick={blocked.act}>
            {block.action.label}
          </Button>
        )}
        <IconButton label="Hide" size="sm" onClick={blocked.dismiss}>
          <X />
        </IconButton>
      </span>
    </div>
  );
}
