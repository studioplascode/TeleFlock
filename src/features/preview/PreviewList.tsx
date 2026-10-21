import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Copy, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { core, useHosts, useTunnels } from "@/core";
import type { TunnelInfo } from "@/core/gen";
import { EmptyState, IconButton, Shimmer, Spinner, cn, fadeRise, formatAge, toast, useIsMobile, useNow } from "@/design";
import { describeError } from "../workspace/shared/errors";
import { PreviewSheet } from "./PreviewButton";
import { type PendingTunnel, dismissPending, openExternal, openTunnel, usePreviewStore } from "./store";

/**
 * Preview tunnels across hosts. Opening ones spin, failed ones explain and retry, live ones breathe
 * and show their age; open, copy, close.
 */
export function PreviewList({ className }: { className?: string }) {
  const tunnels = useTunnels();
  const pendingMap = usePreviewStore((s) => s.pending);
  const profiles = useHosts((s) => s.profiles);
  const mobile = useIsMobile();
  const now = useNow(5000);
  const [sheet, setSheet] = useState<TunnelInfo | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const pending = useMemo(
    () => Object.values(pendingMap).filter((p) => !tunnels.some((t) => t.hostId === p.hostId && t.remotePort === p.port)),
    [pendingMap, tunnels],
  );
  const live = useMemo(() => [...tunnels].sort((a, b) => b.openedAt - a.openedAt), [tunnels]);
  const hostName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;

  if (live.length === 0 && pending.length === 0) {
    return (
      <EmptyState
        compact
        className={className}
        icon={<Globe />}
        title="No previews open"
        description="When an agent starts a dev server, its localhost link gets a Preview button that tunnels it here."
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
    <div role="list" aria-label="Preview tunnels" className={cn("flex flex-col gap-1.5", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {pending.map((p) => (
          <PendingRow key={p.key} p={p} host={hostName(p.hostId)} />
        ))}
        {live.map((t) => (
          <Row
            key={t.tunnelId}
            tone="live"
            dim={closing === t.tunnelId}
            icon={
              <>
                <Globe className="size-4" />
                <span className="tf-loop absolute top-1 right-1 size-1.5 animate-breathe rounded-full bg-done shadow-[0_0_6px_var(--color-done)]" aria-hidden />
              </>
            }
            title={
              <>
                {hostName(t.hostId)} <span className="font-mono text-mute">:{t.remotePort}</span>
              </>
            }
            meta={
              <>
                <span className="text-done">live</span> · 127.0.0.1:{t.localPort} · {formatAge(now - t.openedAt)}
              </>
            }
            onOpen={() => (mobile ? setSheet(t) : openExternal(t))}
            openLabel={`Open preview of ${hostName(t.hostId)} port ${t.remotePort}`}
            actions={
              <>
                <IconButton
                  label="Copy URL"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(t.url)
                      .then(() => toast({ title: "Preview URL copied", description: t.url, duration: 2000 }))
                      .catch(() => toast({ title: "Copy failed", description: "Clipboard access was denied.", status: "error" }));
                  }}
                >
                  <Copy />
                </IconButton>
                {!mobile && (
                  <IconButton label="Open in browser" size="sm" onClick={() => openExternal(t)}>
                    <ExternalLink />
                  </IconButton>
                )}
                <IconButton label={`Close tunnel to port ${t.remotePort}`} size="sm" variant="danger" onClick={() => void close(t)} disabled={closing === t.tunnelId}>
                  {closing === t.tunnelId ? <Spinner size={12} /> : <X />}
                </IconButton>
              </>
            }
          />
        ))}
      </AnimatePresence>
      {mobile && <PreviewSheet tunnel={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}

function PendingRow({ p, host }: { p: PendingTunnel; host: string }) {
  if (p.state === "opening") {
    return (
      <Row
        tone="opening"
        icon={<Spinner size={14} label={`Opening tunnel to port ${p.port}`} />}
        title={
          <>
            {host} <span className="font-mono text-mute">:{p.port}</span>
          </>
        }
        meta={<Shimmer>Opening SSH tunnel…</Shimmer>}
      />
    );
  }
  return (
    <Row
      tone="error"
      icon={<AlertTriangle className="size-4" />}
      title={
        <>
          {host} <span className="font-mono text-mute">:{p.port}</span>
        </>
      }
      meta={<span className="text-error">{p.hint ?? p.title}</span>}
      actions={
        <>
          <IconButton label={`Retry tunnel to port ${p.port}`} size="sm" onClick={() => void openTunnel(p.hostId, p.port)}>
            <RotateCw />
          </IconButton>
          <IconButton label="Dismiss" size="sm" onClick={() => dismissPending(p.hostId, p.port)}>
            <X />
          </IconButton>
        </>
      }
    />
  );
}

const TONE = {
  live: "bg-done/12 text-done",
  opening: "bg-accent/14 text-accent-hi",
  error: "bg-error/14 text-error",
} as const;

function Row({
  tone,
  icon,
  title,
  meta,
  actions,
  onOpen,
  openLabel,
  dim,
}: {
  tone: keyof typeof TONE;
  icon: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  actions?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  dim?: boolean;
}) {
  const body = (
    <>
      <span className="truncate text-sm font-bold text-ink">{title}</span>
      <span className="truncate font-mono text-2xs text-mute-2">{meta}</span>
    </>
  );
  return (
    <motion.div
      role="listitem"
      layout
      {...fadeRise}
      className={cn(
        "flex items-center gap-3 rounded-lg bg-white/4 px-3 py-2.5 shadow-hairline transition-opacity",
        tone === "error" && "shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)]",
        dim && "opacity-50",
      )}
    >
      <span className={cn("relative grid size-8 shrink-0 place-items-center rounded-md", TONE[tone])}>{icon}</span>
      {onOpen ? (
        <button type="button" aria-label={openLabel} className="flex min-w-0 flex-1 flex-col rounded-xs text-left focus-ring" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">{body}</div>
      )}
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </motion.div>
  );
}
