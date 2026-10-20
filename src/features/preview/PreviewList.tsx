import { AnimatePresence, motion } from "motion/react";
import { Copy, ExternalLink, Globe, X } from "lucide-react";
import { useState } from "react";
import { core, useHosts, useTunnels } from "@/core";
import type { TunnelInfo } from "@/core/gen";
import { EmptyState, IconButton, cn, fadeRise, formatAge, toast, useIsMobile, useNow } from "@/design";
import { describeError } from "../workspace/shared/errors";
import { PreviewSheet } from "./PreviewButton";

/** Open preview tunnels across hosts: open, copy, close. Live tunnels show a breathing dot and age. */
export function PreviewList({ className }: { className?: string }) {
  const tunnels = useTunnels();
  const profiles = useHosts((s) => s.profiles);
  const mobile = useIsMobile();
  const now = useNow(5000);
  const [sheet, setSheet] = useState<TunnelInfo | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  if (tunnels.length === 0) {
    return (
      <EmptyState
        compact
        className={className}
        icon={<Globe />}
        title="No previews open"
        description="When an agent starts a dev server, use Open preview on its localhost link."
      />
    );
  }

  const close = async (t: TunnelInfo) => {
    setClosing(t.tunnelId);
    try {
      await core.app("tunnel.close", { tunnelId: t.tunnelId });
    } catch (e) {
      toast({ title: "Couldn't close the tunnel", description: describeError(e).title, status: "error" });
    } finally {
      setClosing(null);
    }
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <AnimatePresence initial={false}>
        {tunnels.map((t) => {
          const host = profiles.find((p) => p.id === t.hostId);
          return (
            <motion.div
              key={t.tunnelId}
              layout
              {...fadeRise}
              className={cn("flex items-center gap-3 rounded-lg bg-white/4 px-3 py-2.5 shadow-hairline", closing === t.tunnelId && "opacity-50")}
            >
              <span className="relative grid size-8 shrink-0 place-items-center rounded-md bg-done/12 text-done">
                <Globe className="size-4" />
                <span className="tf-loop absolute top-1 right-1 size-1.5 animate-breathe rounded-full bg-done shadow-[0_0_6px_var(--color-done)]" aria-hidden />
              </span>
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col text-left focus-ring rounded-xs"
                onClick={() => (mobile ? setSheet(t) : void core.app("app.openExternal", { url: t.url }))}
              >
                <span className="truncate text-sm font-bold">
                  {host?.name ?? t.hostId} <span className="font-mono text-mute">:{t.remotePort}</span>
                </span>
                <span className="truncate font-mono text-2xs text-mute-2">
                  {t.url} · opened {formatAge(now - t.openedAt)}
                </span>
              </button>
              <IconButton
                label="Copy URL"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(t.url).then(() => toast({ title: "Preview URL copied", description: t.url, duration: 2000 }));
                }}
              >
                <Copy />
              </IconButton>
              <IconButton label="Open in browser" size="sm" onClick={() => void core.app("app.openExternal", { url: t.url })}>
                <ExternalLink />
              </IconButton>
              <IconButton label={`Close tunnel to port ${t.remotePort}`} size="sm" variant="danger" onClick={() => void close(t)} disabled={closing === t.tunnelId}>
                <X />
              </IconButton>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {mobile && <PreviewSheet tunnel={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
