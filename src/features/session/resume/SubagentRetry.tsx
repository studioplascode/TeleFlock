import { RotateCw } from "lucide-react";
import { useCore } from "@/core";
import type { Subagent } from "@/core/gen";
import { Button } from "@/design";
import { retrySubagent, useResumePending } from "./actions";

/**
 * Retry in the subagent viewer for a subagent that failed or was stopped, where the session can
 * (`caps.subagentRetry`, bridge ≥ 2.1.0): omp revives it and its result reaches the parent.
 */
export function SubagentRetry({ agentKey, sub, blocked, onDone }: { agentKey: string; sub: Subagent; blocked: string | null; onDone: () => void }) {
  const can = useCore((s) => s.sessions[agentKey]?.meta?.caps.subagentRetry === true);
  const pending = useResumePending(`${agentKey}/${sub.id}`);
  if (!can || (sub.status !== "failed" && sub.status !== "aborted")) return null;
  return (
    <Button
      size="sm"
      variant="primary"
      icon={<RotateCw />}
      loading={pending}
      disabled={!!blocked}
      title={blocked ?? `Retry ${sub.name}'s stopped turn; its result reaches the parent`}
      onClick={() => void retrySubagent(agentKey, sub).then((ok) => ok && onDone())}
    >
      Retry
    </Button>
  );
}
