import { Gauge } from "lucide-react";
import { formatPct } from "@/core";
import { Chip, Tooltip } from "@/design";
import { paceStatus } from "@/features/usage/limitsUi";
import { timeLeftText, useSessionLimits } from "../inspector/LimitsTile";

/** Shown only while the session account's tightest window is below this much left. */
const LOW = 0.2;

/** Session header warning: the subscription this session draws from is nearly used up. */
export function LimitsChip({ agentKey }: { agentKey: string }) {
  const { limits, tight } = useSessionLimits(agentKey);
  if (!limits || !tight || tight.pace.remaining == null || tight.pace.remaining >= LOW) return null;
  const { window, pace } = tight;
  return (
    <Tooltip content={`${window.label} on ${limits.account.label}: ${formatPct(pace.remaining ?? 0)} left, ${timeLeftText(pace)}. Details on the Usage page.`}>
      <Chip tone={paceStatus(window, pace)} icon={<Gauge />} className="tabular" data-limits-chip>
        {formatPct(pace.remaining ?? 0)} left
      </Chip>
    </Tooltip>
  );
}
