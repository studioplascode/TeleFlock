import { useEffect, useMemo, useState } from "react";
import { LIMITS_EVERY_MS, useAccountLimits } from "@/core";
import { providerQuota, type QuotaReading } from "@/core/workload";
import { useNow, useWindowActive } from "@/design";
import { fetchModels } from "@/features/session/header/useModels";

/*
 * Auto's quota term: for each candidate host, the binding window of the chosen model's provider in
 * that host's `host.limits` (each host has its own subscription logins). "Default model" means each
 * host's own `modelRoles.default` (`host.models`), so it can differ per host.
 */

const LEVEL = /:(off|minimal|low|medium|high|xhigh)$/;

/** `provider/id` (a `provider/id:level` role binding loses its level), else undefined. */
export function modelOf(spec: string | undefined): { provider: string; id: string } | undefined {
  const base = spec?.replace(LEVEL, "");
  const slash = base?.indexOf("/") ?? -1;
  return base && slash > 0 && slash < base.length - 1 ? { provider: base.slice(0, slash), id: base.slice(slash + 1) } : undefined;
}

/**
 * Host id → its quota reading for `choice` ("default" or `provider/id`): undefined while the host's
 * limits or default model aren't known, null when it has no metered window for the provider.
 */
export function useAutoQuotas(hostIds: readonly string[], choice: string): Record<string, QuotaReading | null | undefined> {
  const key = hostIds.join("|");
  const limits = useAccountLimits(key ? key.split("|") : [], useWindowActive() ? LIMITS_EVERY_MS : null);
  const [defaults, setDefaults] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    if (choice !== "default" || !key) return;
    let alive = true;
    for (const h of key.split("|")) {
      fetchModels(h).then(
        (c) => alive && setDefaults((d) => ({ ...d, [h]: c.roles.find((r) => r.role === "default")?.model })),
        () => {},
      );
    }
    return () => {
      alive = false;
    };
  }, [key, choice]);
  const now = useNow(60_000);
  return useMemo(() => {
    const out: Record<string, QuotaReading | null | undefined> = {};
    for (const h of key ? key.split("|") : []) {
      const model = modelOf(choice === "default" ? defaults[h] : choice);
      out[h] = model ? providerQuota(limits[h]?.data, model, now) : undefined;
    }
    return out;
  }, [key, choice, defaults, limits, now]);
}
