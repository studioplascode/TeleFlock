import { ExternalLink, Globe, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { core, useTunnels } from "@/core";
import type { TunnelInfo } from "@/core/gen";
import { BottomSheet, Button, Spinner, cn, popIn, toast, useIsMobile } from "@/design";
import { describeError } from "../workspace/shared/errors";

export interface PreviewButtonProps {
  hostId: string;
  /** Port on the agent host (the dev server the agent started). */
  port: number;
  /** Shown on the button; defaults to `localhost:<port>`. */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * "Open preview" for a dev server on the agent host: opens (or reuses) a tunnel, then launches the
 * default browser on desktop or an in-app preview sheet on mobile. Live tunnels glow.
 */
export function PreviewButton({ hostId, port, label, size = "sm", className }: PreviewButtonProps) {
  const mobile = useIsMobile();
  const tunnels = useTunnels();
  const existing = tunnels.find((t) => t.hostId === hostId && t.remotePort === port);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<TunnelInfo | null>(null);

  const open = async () => {
    setBusy(true);
    try {
      const tunnel = existing ?? (await core.app("tunnel.open", { hostId, port }));
      if (mobile) setSheet(tunnel);
      else await core.app("app.openExternal", { url: tunnel.url });
    } catch (e) {
      const d = describeError(e);
      toast({ title: `Couldn't open preview for :${port}`, description: d.hint ?? d.title, status: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size={size}
        variant={existing ? "primary" : "secondary"}
        onClick={open}
        loading={busy}
        icon={
          <span className="relative grid place-items-center">
            <Globe />
            {existing && <span className="tf-loop absolute -top-0.5 -right-0.5 size-1.5 animate-breathe rounded-full bg-done shadow-[0_0_6px_var(--color-done)]" aria-hidden />}
          </span>
        }
        trailing={!mobile ? <ExternalLink className="opacity-60" /> : undefined}
        className={cn("max-w-full", className)}
        title={existing ? `Tunnel open on 127.0.0.1:${existing.localPort}` : `Open a tunnel to port ${port} on the host`}
      >
        <span className="truncate">{label ?? `localhost:${port}`}</span>
      </Button>
      {mobile && <PreviewSheet tunnel={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}

/** Mobile in-app preview: the tunnelled page in an iframe, with reload and "open in browser". */
export function PreviewSheet({ tunnel, onClose }: { tunnel: TunnelInfo | null; onClose: () => void }) {
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState(false);
  return (
    <BottomSheet
      open={!!tunnel}
      onOpenChange={(o) => !o && onClose()}
      title={tunnel ? `Preview · :${tunnel.remotePort}` : "Preview"}
      description={tunnel ? `${tunnel.remoteHost}:${tunnel.remotePort} → ${tunnel.url}` : undefined}
      maxHeight="94dvh"
      footer={
        tunnel && (
          <div className="flex gap-2">
            <Button
              className="flex-1"
              icon={<RotateCw />}
              onClick={() => {
                setLoaded(false);
                setNonce((n) => n + 1);
              }}
            >
              Reload
            </Button>
            <Button className="flex-1" variant="primary" icon={<ExternalLink />} onClick={() => void core.app("app.openExternal", { url: tunnel.url })}>
              Open in browser
            </Button>
          </div>
        )
      }
    >
      {tunnel && (
        <div className="relative h-[70dvh] overflow-hidden rounded-lg bg-white shadow-d2">
          <AnimatePresence>
            {!loaded && (
              <motion.div {...popIn} className="absolute inset-0 z-raised grid place-items-center bg-tile-1">
                <div className="flex flex-col items-center gap-2">
                  <Spinner size={22} />
                  <span className="text-xs text-mute">Loading through the tunnel…</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <iframe
            key={nonce}
            src={tunnel.url}
            title={`Preview of port ${tunnel.remotePort}`}
            className="size-full border-0"
            onLoad={() => setLoaded(true)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        </div>
      )}
    </BottomSheet>
  );
}
