import { ChevronRight, Plus, Search } from "lucide-react";
import { motion } from "motion/react";
import { Button, fadeRise, IconButton, spring, StatusOrb, Tile, useNow } from "@/design";
import { navigate, type Route, useHosts, useUi } from "@/core";
import { connWords } from "@/features/board/FlockActions";
import { useAppInfo } from "@/features/hosts/appInfo";
import { connAction } from "@/features/hosts/ConnStatusCard";
import { profileAddress } from "@/features/hosts/kinds";
import { haptic } from "./haptics";
import { MobileHeader } from "./MobileHeader";
import { connSummary, PHASE_STATUS, phaseBusy } from "./status";
import { VIEWS } from "./vocab";

/** The pages More lists, in order. Label, icon and description come from `VIEWS`, like every other entry point. */
const PAGES = ["usage", "activity", "automations", "omp", "mcp", "accounts", "settings"] as const satisfies readonly (Route["name"] & keyof typeof VIEWS)[];

function LinkRow({ id }: { id: (typeof PAGES)[number] }) {
  const { icon: Icon, label, description } = VIEWS[id];
  return (
    <button
      type="button"
      onClick={() => {
        haptic("tick");
        navigate({ name: id } as Route);
      }}
      className="flex min-h-12 w-full items-center gap-3 px-3.5 py-2 text-left pressable focus-ring active:bg-white/4"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent/14 text-accent-hi">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-md font-bold text-ink">{label}</span>
        {/* Two lines on a narrow phone rather than cut off. */}
        <span className="line-clamp-2 text-xs text-mute">{description}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-mute-2" />
    </button>
  );
}

/**
 * Mobile "More" tab: the host list (one connection verb per state, the same as Flock's strip),
 * then the pages without a tab of their own. Counts live on the Flock tiles, updates in Inbox.
 */
export function MoreView() {
  const { profiles, status } = useHosts();
  const { openDialog, setPalette } = useUi();
  const info = useAppInfo();
  const now = useNow(1000);

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
        <motion.section {...fadeRise} aria-label="Hosts">
          <div className="flex items-center justify-between gap-1 px-1 pb-1">
            <h2 className="kicker">Hosts</h2>
            <span className="flex items-center gap-1">
              <IconButton label="Add host" size="sm" onClick={() => openDialog({ kind: "hostEditor" })}>
                <Plus />
              </IconButton>
              <button
                type="button"
                onClick={() => {
                  haptic("tick");
                  navigate({ name: "hosts" });
                }}
                className="flex min-h-9 items-center rounded-full px-2.5 text-xs font-bold text-accent-hi pressable focus-ring"
                title={VIEWS.hosts.description}
              >
                Manage ›
              </button>
            </span>
          </div>
          <Tile className="divide-y divide-line overflow-hidden">
            {profiles.map((p) => {
              const s = status[p.id];
              const phase = s?.phase ?? "idle";
              const action = connAction(s, p.id);
              return (
                <div key={p.id} className="flex items-center gap-3 px-3.5 py-2">
                  <button type="button" onClick={() => navigate({ name: "hosts" })} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-ring">
                    <StatusOrb status={PHASE_STATUS[phase]} size={10} label={null} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-md font-bold text-ink">{p.name}</span>
                        <span className={phaseBusy(phase) ? "tf-shimmer-text shrink-0 font-mono text-xs text-mute" : "shrink-0 font-mono text-xs text-mute"}>
                          {phase === "online" ? connSummary(s) : connWords(s, now)}
                        </span>
                      </span>
                      {s?.error && phase !== "online" ? (
                        <span className="block truncate text-2xs text-[#ff9fb2]">{s.error.message}</span>
                      ) : (
                        <span className="block truncate font-mono text-2xs text-mute-2">{profileAddress(p)}</span>
                      )}
                    </span>
                  </button>
                  {action && (
                    <Button size="sm" variant="secondary" className="shrink-0" onClick={action.run}>
                      {action.label}
                    </Button>
                  )}
                </div>
              );
            })}
          </Tile>
        </motion.section>

        <motion.div {...fadeRise} transition={{ ...spring.smooth, delay: 0.05 }}>
          <Tile className="divide-y divide-line overflow-hidden">
            {PAGES.map((id) => (
              <LinkRow key={id} id={id} />
            ))}
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
