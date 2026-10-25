import { Clock3 } from "lucide-react";
import { EmptyState } from "@/design";

/** Placeholder until the Automations feature lands (owner: Automations). */
export function AutomationsView({ hostId }: { hostId?: string }) {
  return <EmptyState icon={<Clock3 />} title="Automations" description={hostId ? `Host ${hostId}` : undefined} />;
}
