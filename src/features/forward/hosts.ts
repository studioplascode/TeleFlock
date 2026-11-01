import { useMemo } from "react";
import { useCore, useHosts } from "@/core";
import type { HostKind } from "@/core/gen";

/** A host a forward can name. */
export interface ForwardHost {
  id: string;
  name: string;
  kind: HostKind;
  online: boolean;
}

/**
 * The hosts a rule can use, in the host list's order. Demo-kind hosts inside a real app belong to the
 * in-process demo, which the real core knows nothing about, so they are left out there.
 */
export function useForwardHosts(): ForwardHost[] {
  const { profiles, status } = useHosts();
  const backend = useCore((s) => s.backend);
  return useMemo(
    () =>
      profiles
        .filter((p) => backend === "demo" || p.kind !== "demo")
        .map((p) => ({ id: p.id, name: p.name, kind: p.kind, online: status[p.id]?.phase === "online" })),
    [profiles, status, backend],
  );
}
