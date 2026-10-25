import { Bot } from "lucide-react";
import { EmptyState } from "@/design";

/** Placeholder until the omp settings feature lands (owner: OmpSettings). */
export function OmpSettingsView({ hostId }: { hostId?: string }) {
  return <EmptyState icon={<Bot />} title="omp settings" description={hostId ? `Host ${hostId}` : undefined} />;
}
