import { Activity, BarChart3, Bell, ChevronRight, type LucideIcon, Plus, Search, Server, Settings2 } from "lucide-react";
import { motion } from "motion/react";
import { CountBadge, fadeRise, IconButton, spring, StatusOrb, Tile } from "@/design";
import { navigate, type Route, useHosts, useNotifications, useUi } from "@/core";
import { useAppInfo } from "@/features/hosts/appInfo";
import { ConnStatusCard } from "@/features/hosts/ConnStatusCard";
import { profileAddress } from "@/features/hosts/kinds";
import { NotificationList } from "@/features/notify/NotificationCenter";
import { haptic } from "./haptics";
import { GlobalHeartbeat } from "./TitleBarParts";
import { useFlockCounts } from "./liveness";
import { MobileHeader } from "./MobileHeader";
import { closeSheet, openSheet } from "./sheets";
import { connSummary, PHASE_STATUS } from "./status";

function LinkRow({ icon: Icon, label, hint, route, onClick, badge }: { icon: LucideIcon; label: string; hint?: string; route?: Route; onClick?: () => void; badge?: number }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic("tick");
        if (onClick) onClick();
        else if (route) navigate(route);
      }}
      className="flex min-h-12 w-full items-center gap-3 px-3.5 py-1.5 text-left pressable focus-ring active:bg-white/4"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent/14 text-accent-hi">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-md font-bold text-ink">{label}</span>
        {hint && <span className="block truncate text-xs text-mute">{hint}</span>}
      </span>
      {badge !== undefined && <CountBadge count={badge} />}
      <ChevronRight className="size-4 text-mute-2" />
    </button>
  );
}

/** Mobile "More" tab: hosts at a glance, usage, activity, notifications, settings. */
export function MoreView() {
  const { profiles, status } = useHosts();
  const { openDialog, setPalette } = useUi();
  const { running, needs } = useFlockCounts();
  const unread = useNotifications((n) => n.unread);
  const info = useAppInfo();

  return (
    <div className="flex min-h-full flex-col">
      <MobileHeader
        title="More"
        actions={
          <IconButton label="Search" onClick={() => setPalette(true)}>
            <Search />
          </IconButton>
        }
      />
      <div className="flex flex-col gap-3 px-3 pt-1 pb-6">
        <motion.div {...fadeRise}>
          <Tile className="px-3.5 py-3">
            <div className="flex items-center justify-between">
              <span className="kicker">Flock pulse</span>
              <span className="text-xs font-bold text-mute">
                {running} running · {needs} need you
              </span>
            </div>
            <GlobalHeartbeat className="mt-2 w-full" />
          </Tile>
        </motion.div>

        <motion.section {...fadeRise} transition={{ ...spring.smooth, delay: 0.05 }} aria-label="Hosts">
          <div className="flex items-center justify-between px-1 pb-1">
            <h2 className="kicker">Hosts</h2>
            <IconButton label="Add host" size="sm" onClick={() => openDialog({ kind: "hostEditor" })}>
              <Plus />
            </IconButton>
          </div>
          <Tile className="divide-y divide-line overflow-hidden">
            {profiles.map((p) => {
              const s = status[p.id];
              const phase = s?.phase ?? "idle";
              return (
                <div key={p.id} className="flex flex-col gap-2 px-3.5 py-2">
                  <button type="button" onClick={() => navigate({ name: "hosts" })} className="flex min-h-11 items-center gap-3 text-left focus-ring rounded-sm">
                    <StatusOrb status={PHASE_STATUS[phase]} size={10} label={null} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-md font-bold text-ink">{p.name}</span>
                      <span className="block truncate font-mono text-2xs text-mute-2">{profileAddress(p)}</span>
                    </span>
                    <span className="font-mono text-xs text-mute">{connSummary(s)}</span>
                  </button>
                  {phase !== "online" && <ConnStatusCard hostId={p.id} status={s} />}
                </div>
              );
            })}
          </Tile>
        </motion.section>

        <motion.div {...fadeRise} transition={{ ...spring.smooth, delay: 0.1 }}>
          <Tile className="divide-y divide-line overflow-hidden">
            <LinkRow
              icon={Bell}
              label="Notifications"
              hint={unread ? `${unread} unread` : "All caught up"}
              badge={unread}
              onClick={() => openSheet({ title: "Notifications", content: <NotificationList onNavigate={closeSheet} title={false} /> })}
            />
            <LinkRow icon={BarChart3} label="Usage" hint="Cost and tokens per agent, day and model" route={{ name: "usage" }} />
            <LinkRow icon={Activity} label="Activity" hint="Everything the flock did" route={{ name: "activity" }} />
            <LinkRow icon={Server} label="Hosts" hint="Connections, health and setup" route={{ name: "hosts" }} />
            <LinkRow icon={Settings2} label="Settings" hint="Notifications, motion, defaults" route={{ name: "settings" }} />
          </Tile>
        </motion.div>

        {info && (
          <p className="text-center font-mono text-2xs text-mute-2">
            TeleFlock v{info.version} · {info.platform}
          </p>
        )}
      </div>
    </div>
  );
}
