import { useEffect, useMemo, useState } from "react";
import { LIMITS_EVERY_MS, useAccountLimits } from "@/core";
import { providerQuota, type QuotaReading } from "@/core/workload";
import { useNow, useWindowActive } from "@/design";
import { fetchModels } from "@/features/session/header/useModels";
import { roleOf } from "@/features/agentRoles/mainModel";
import { splitLevel } from "@/core/refusal";

/*
 * Auto's quota term: for each candidate host, the binding window of the chosen model's provider in
 * that host's `host.limits` (each host has its own subscription logins). "Default model" means each
 * host's own `modelRoles.default` (`host.models`), a role (`@slow`) that role's binding there, so it
 * can differ per host.
 */

/** `provider/id` (a `provider/id:level` role binding loses its level), else undefined. */
export function modelOf(spec: string | undefined): { provider: string; id: string } | undefined {
  const base = spec === undefined ? undefined : splitLevel(spec).model;
  const slash = base?.indexOf("/") ?? -1;
  return base && slash > 0 && slash < base.length - 1 ? { provider: base.slice(0, slash), id: base.slice(slash + 1) } : undefined;
}

/**
 * Host id → its quota reading for `choice` ("default", `@<role>` or `provider/id`): undefined while the
 * host's limits or that role's model aren't known, null when it has no metered window for the provider.
 */
export function useAutoQuotas(hostIds: readonly string[], choice: string): Record<string, QuotaReading | null | undefined> {
  const key = hostIds.join("|");
  const limits = useAccountLimits(key ? key.split("|") : [], useWindowActive() ? LIMITS_EVERY_MS : null);
  const role = choice === "default" ? "default" : roleOf(choice);
  const [bound, setBound] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    if (!role || !key) return;
    let alive = true;
    for (const h of key.split("|")) {
      fetchModels(h).then(
        (c) => alive && setBound((d) => ({ ...d, [`${h}\u0000${role}`]: c.roles.find((r) => r.role === role)?.model })),
        () => {},
      );
    }
    return () => {
      alive = false;
    };
  }, [key, role]);
  const now = useNow(60_000);
  return useMemo(() => {
    const out: Record<string, QuotaReading | null | undefined> = {};
    for (const h of key ? key.split("|") : []) {
      const model = modelOf(role ? bound[`${h}\u0000${role}`] : choice);
      out[h] = model ? providerQuota(limits[h]?.data, model, now) : undefined;
    }
    return out;
  }, [key, choice, role, bound, limits, now]);
}
