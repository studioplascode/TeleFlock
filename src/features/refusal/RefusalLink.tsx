import { ShieldAlert } from "lucide-react";
import { useHosts } from "@/core";
import { Button } from "@/design";
import { openRefusalSettings } from "./focus";
import { useEnsureRules } from "./store";

/**
 * Next to omp's fallback chains: those walk on provider errors; a refusal that none of them takes over is what
 * Refusal fallback in Settings is for. Says what the host has (nothing, or N rules) and opens that card on the host.
 */
export function RefusalFallbackLink({ hostId }: { hostId: string }) {
  const online = useHosts((h) => h.status[hostId]?.phase === "online");
  const rules = useEnsureRules(hostId, online, 60_000);
  const n = rules?.phase === "ready" ? rules.rules.length : undefined;
  const state = rules?.phase === "old" ? "needs TeleFlock 0.9.0 on this host" : n === undefined ? undefined : n === 0 ? "no rules on this host yet" : `${n} ${n === 1 ? "rule" : "rules"} on this host`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-ink/[0.03] px-3 py-2 shadow-hairline">
      <ShieldAlert className="size-3.5 shrink-0 text-mute" aria-hidden />
      <p className="min-w-0 flex-1 basis-64 text-xs text-mute">
        A provider's refusal (a cyber refusal, say) that no chain takes over stops the turn. <b className="font-bold text-ink-2">Refusal fallback</b> switches the agent to another model and goes on with it
        {state ? `: ${state}.` : "."}
      </p>
      <Button size="sm" variant="secondary" onClick={() => openRefusalSettings(hostId)}>
        Refusal fallback
      </Button>
    </div>
  );
}
