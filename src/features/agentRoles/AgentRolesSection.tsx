import { Boxes } from "lucide-react";
import type { ReactNode } from "react";
import { useCore } from "@/core";
import { Chip } from "@/design";
import { FALLBACK_CHAINS_KEY } from "@/features/ompSettings/model";
import { useModels } from "@/features/session/header/useModels";
import { AgentOptionsSection } from "@/features/workspace/shared/AgentOptions";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";
import { RoleOverridesEditor } from "./RoleOverridesEditor";
import { type ChainMap, cleanChains, hostTakesRoles, overridesSummary, type RoleMap } from "./roles";

/** The host's `retry.fallbackChains` (read with `omp.settings` while `enabled`); undefined until known. */
export function useHostChains(hostId: string | undefined, enabled = true): ChainMap | undefined {
  const q = useHostQuery(hostId, "omp.settings", enabled ? {} : null);
  const setting = q.data?.settings.find((s) => s.id === FALLBACK_CHAINS_KEY);
  return setting ? cleanChains(setting.value) : undefined;
}

/** Header chip of `AgentOptions` for an agent's own roles and chains; null when it has none. */
export function rolesSummaryChip(roles: RoleMap | undefined, chains: ChainMap | undefined): ReactNode {
  const text = overridesSummary(roles, chains);
  return text ? (
    <Chip key="roles" tone="accent" icon={<Boxes />} className="h-5 px-2 text-2xs">
      {text}
    </Chip>
  ) : null;
}

export interface AgentRolesSectionProps {
  hostId: string;
  roles: RoleMap;
  chains: ChainMap;
  onChange: (patch: { roleModels?: RoleMap; fallbackChains?: ChainMap }) => void;
  /** The form's main model (`launchMainText`), shown as the read-only Default role. */
  mainModel: string;
  /** Where the form sets it. */
  mainWhere?: string;
}

/** Whether `hostId`'s tf-hostd takes an agent's own roles (`hostTakesRoles`). */
export function useHostTakesRoles(hostId: string | undefined): boolean {
  return useCore((s) => (hostId ? hostTakesRoles(s.hosts[hostId]?.state.info) : true));
}

/** `AgentOptions` section of the launch forms: this agent's own model roles and fallback chains. */
export function AgentRolesSection({ hostId, roles, chains, onChange, mainModel, mainWhere = "set above" }: AgentRolesSectionProps) {
  const { catalog } = useModels(hostId);
  const host = Object.fromEntries((catalog?.roles ?? []).map((r) => [r.role, r.model]));
  const hostChains = useHostChains(hostId);
  const takes = useHostTakesRoles(hostId);
  const version = useCore((s) => s.hosts[hostId]?.state.info.hostdVersion);
  if (!takes) {
    // The editors are gone, and so are the maps in the spec (`launchOverrides`): a tf-hostd from before 0.7 would start the agent on the host's models, ignoring them.
    return (
      <AgentOptionsSection title="Model roles · this agent only" note="Needs a newer TeleFlock host daemon.">
        <p className="text-xs font-semibold text-warn">
          This host runs tf-hostd {version ?? "from before 0.7"}, which would ignore the agent's own model roles and start it on the host's models. Update the daemon from Hosts (it is also redeployed when the app connects) to set them here.
        </p>
      </AgentOptionsSection>
    );
  }
  return (
    <AgentOptionsSection title="Model roles · this agent only" note="Only this agent; the host's omp settings stay as they are.">
      <RoleOverridesEditor
        hostId={hostId}
        value={roles}
        onChange={(roleModels) => onChange({ roleModels })}
        host={host}
        defaultRow={{ readOnlyText: `Main model: ${mainModel} — ${mainWhere}` }}
        chains={chains}
        onChainsChange={(fallbackChains) => onChange({ fallbackChains })}
        hostChains={hostChains}
      />
    </AgentOptionsSection>
  );
}
