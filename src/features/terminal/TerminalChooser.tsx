import { ChevronRight, Plus, Server, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { navigate, useAgent, useColumnKeys, useHostIds, useHosts, useHostStates } from "@/core";
import { Button, EmptyState, StatusOrb, Tile } from "@/design";
import { haptic } from "@/features/shell/haptics";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { agentTier, COLUMN_STATUS, connSummary, PHASE_STATUS } from "@/features/shell/status";
import { agentStateWord } from "@/features/shell/vocab";
import { openNewShell } from "./lastTerminal";
import { hostPanes, paneDetail, paneName } from "./panes";

function Row({ orb, title, detail, trailing, onClick }: { orb: ReactNode; title: string; detail?: string; trailing?: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic("select");
        onClick();
      }}
      className="flex min-h-13 w-full items-center gap-3 px-3.5 py-1.5 text-left pressable focus-ring active:bg-white/4"
    >
      <span className="grid size-5 shrink-0 place-items-center">{orb}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-md font-bold text-ink">{title}</span>
        {detail && <span className="block truncate font-mono text-2xs text-mute-2">{detail}</span>}
      </span>
      {trailing && <span className="shrink-0 text-xs font-bold text-mute">{trailing}</span>}
      <ChevronRight className="size-4 shrink-0 text-mute-2" aria-hidden />
    </button>
  );
}

function AgentChoice({ agentKey, multiHost }: { agentKey: string; multiHost: boolean }) {
  const agent = useAgent(agentKey);
  const hostName = useHosts((s) => (agent ? (s.profiles.find((p) => p.id === agent.hostId)?.name ?? agent.hostId) : ""));
  if (!agent) return null;
  const where = [agent.repo, agent.branch].filter(Boolean).join(" · ") || agent.cwd;
  return (
    <Row
      orb={<StatusOrb status={COLUMN_STATUS[agent.column]} activity={agent.column === "running" ? agentTier(agent) : "calm"} size={9} label={null} />}
      title={agent.name}
      detail={multiHost ? `${hostName} · ${where}` : where}
      trailing={agentStateWord(agent)}
      onClick={() => navigate({ name: "terminal", hostId: agent.hostId, agentId: agent.id })}
    />
  );
}

/**
 * Phone Terminal tab with nothing remembered: "Attach to…" an agent (status orbs, needs-you and
 * running first) or a shell pane, or open a new shell, instead of silently attaching to whichever
 * pane comes first. A host with no panes at all offers its new shell up front.
 */
export function TerminalChooser() {
  // Done agents' panes are usually gone: lane order over the live lanes.
  const needs = useColumnKeys("needs", { hostId: "all" });
  const running = useColumnKeys("running", { hostId: "all" });
  const review = useColumnKeys("review", { hostId: "all" });
  const agents = [...needs, ...running, ...review];
  const ids = useHostIds();
  const status = useHosts((s) => s.status);
  const profiles = useHosts((s) => s.profiles);
  const states = useHostStates();
  const multiHost = ids.length > 1;
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  const online = ids.filter((id) => status[id]?.phase === "online");
  // panes no agent owns (plain shells, other tools), in workspace and tab order
  const shells = online.flatMap((hostId) =>
    hostPanes(states[hostId]?.workspaces ?? [])
      .filter((r) => !r.pane.agentId)
      .map((r) => ({ hostId, ...r })),
  );
  // where a new shell opens on each online host: the workspace in focus (as the terminal screen picks it), else the host's home
  const newShells = online.map((hostId) => {
    const workspaces = states[hostId]?.workspaces ?? [];
    const ws = workspaces.find((w) => w.tabs.some((t) => t.panes.some((p) => p.focused))) ?? workspaces[0];
    const empty = !workspaces.some((w) => w.tabs.some((t) => t.panes.length > 0));
    return { hostId, ws, empty, open: () => openNewShell({ hostId, workspaceId: ws?.id ?? null, cwd: ws?.cwd ?? null }) };
  });
  const emptyHosts = newShells.filter((s) => s.empty);
  const nothing = agents.length === 0 && shells.length === 0;

  return (
    <div className="flex min-h-full flex-col">
      <MobileHeader title="Terminal" subtitle="Attach to…" />
      <div className="flex flex-col gap-3 px-3 pt-1 pb-6">
        {ids.length === 0 && (
          <EmptyState
            icon={<Server />}
            title="No hosts yet"
            description="The terminal attaches to herdr panes on one of your hosts."
            action={
              <Button variant="primary" icon={<Server />} onClick={() => navigate({ name: "hosts" })}>
                Hosts
              </Button>
            }
          />
        )}
        {agents.length > 0 && (
          <section aria-label="Agents">
            <h2 className="kicker px-1 pb-1">Agents</h2>
            <Tile className="divide-y divide-line overflow-hidden">
              {agents.map((k) => (
                <AgentChoice key={k} agentKey={k} multiHost={multiHost} />
              ))}
            </Tile>
          </section>
        )}
        {/* hosts without a single pane: a shell is the only thing to open there, so it gets a primary button */}
        {!nothing &&
          emptyHosts.map(({ hostId, ws, open }) => (
            <Tile key={hostId} className="flex items-center gap-3 px-3.5 py-3">
              <SquareTerminal className="size-5 shrink-0 text-accent-hi" aria-hidden />
              <p className="min-w-0 flex-1 text-xs text-mute">
                <b className="text-ink">{nameOf(hostId)}</b> has no panes yet{ws ? ` · ${ws.label}` : ""}
              </p>
              <Button variant="primary" size="sm" icon={<Plus />} onClick={open}>
                New shell
              </Button>
            </Tile>
          ))}
        {(shells.length > 0 || newShells.some((s) => !s.empty)) && (
          <section aria-label="Shells">
            <h2 className="kicker px-1 pb-1">Shells</h2>
            <Tile className="divide-y divide-line overflow-hidden">
              {shells.map(({ hostId, ws, tab, pane }) => (
                <Row
                  key={`${hostId}/${pane.id}`}
                  orb={<SquareTerminal className="size-4 text-mute" aria-hidden />}
                  title={paneName(pane)}
                  detail={[multiHost ? nameOf(hostId) : null, `${ws.label} › ${tab.label}`, paneDetail(pane, states[hostId]?.info.home, ws.cwd)].filter(Boolean).join(" · ")}
                  onClick={() => navigate({ name: "terminal", hostId, paneId: pane.id })}
                />
              ))}
              {newShells
                .filter((s) => !s.empty)
                .map(({ hostId, ws, open }) => (
                  <Row
                    key={`new:${hostId}`}
                    orb={<Plus className="size-4 text-accent-hi" aria-hidden />}
                    title="New shell"
                    detail={[multiHost ? nameOf(hostId) : null, ws ? `in ${ws.label}` : "in the home folder"].filter(Boolean).join(" · ")}
                    onClick={open}
                  />
                ))}
            </Tile>
          </section>
        )}
        {ids
          .filter((id) => status[id]?.phase !== "online")
          .map((id) => (
            <p key={id} className="flex items-center gap-2 px-1 text-xs text-mute">
              <StatusOrb status={PHASE_STATUS[status[id]?.phase ?? "idle"]} size={7} label={null} />
              <span className="min-w-0">
                <span className="font-bold text-ink-2">{nameOf(id)}</span> · {connSummary(status[id]).toLowerCase()}: its panes show up here once it is online
              </span>
            </p>
          ))}
        {nothing && online.length > 0 && (
          <EmptyState
            icon={<SquareTerminal />}
            title="Nothing to attach to yet"
            description="Open a shell on a host, or start an agent from Flock or Dispatch: its terminal shows up here."
            action={
              <div className="flex flex-col items-center gap-2">
                {newShells.map(({ hostId, open }) => (
                  <Button key={hostId} variant="primary" icon={<Plus />} onClick={open}>
                    {multiHost ? `New shell on ${nameOf(hostId)}` : "New shell"}
                  </Button>
                ))}
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
