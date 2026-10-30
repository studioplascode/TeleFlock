import { useEffect, useState } from "react";
import { core, isApiError, useHosts } from "@/core";
import type { WrappedReport } from "@/core/gen";
import { isWindowActive, onWindowActive } from "@/design";
import { hourOffset, type Week } from "./model";

/** While a host still asks git or GitHub, ask it again this often … */
const PENDING_EVERY_MS = 3_000;
/** … and while omp's index syncs (a first sync on a busy host takes minutes). */
const INDEXING_EVERY_MS = 20_000;
/** Follow-up asks per load at most. */
const MAX_FOLLOW_UPS = 15;

export interface HostAnswer {
  hostId: string;
  report?: WrappedReport;
  error?: { code: string; message: string };
}

/**
 * `host.wrapped` from every online host in view for `week`: asked once per (hosts, week, `nonce`),
 * then again while a host is still gathering (only while the window is active). `nonce > 0` asks
 * the hosts to look at git and GitHub again.
 */
export function useWrapped(hostIds: readonly string[], week: Week, nonce: number): { answers: HostAnswer[]; loading: boolean } {
  const online = useHosts((s) => hostIds.filter((id) => s.status[id]?.phase === "online").join("|"));
  const key = `${online}#${week.since}#${nonce}`;
  const [got, setGot] = useState<{ key: string; answers: HostAnswer[] }>({ key: "", answers: [] });
  useEffect(() => {
    const ids = online ? online.split("|") : [];
    const params = { since: week.since, until: week.back === 0 ? undefined : week.until, hourOffset: hourOffset(week.since) };
    let alive = true;
    let timer = 0;
    let unwatch: (() => void) | undefined;
    let followUps = 0;
    const load = async (refresh: boolean) => {
      const results = await Promise.allSettled(ids.map((id) => core.host(id).call("host.wrapped", { ...params, refresh: refresh || undefined })));
      if (!alive) return;
      const answers = results.map((r, i): HostAnswer => {
        const hostId = ids[i] ?? "";
        if (r.status === "fulfilled") return { hostId, report: r.value };
        return { hostId, error: isApiError(r.reason) ? { code: r.reason.code, message: r.reason.message } : { code: "internal", message: String(r.reason) } };
      });
      setGot({ key, answers });
      const pending = answers.some((a) => a.report?.pending);
      const indexing = answers.some((a) => a.report?.index?.syncing);
      if ((!pending && !indexing) || followUps >= MAX_FOLLOW_UPS) return;
      followUps += 1;
      timer = window.setTimeout(again, pending ? PENDING_EVERY_MS : INDEXING_EVERY_MS);
    };
    // Follow-ups wait for the window to be in front: an unwatched card needs no fresh figures.
    const again = () => {
      if (isWindowActive()) return void load(false);
      unwatch = onWindowActive(() => {
        if (!isWindowActive()) return;
        unwatch?.();
        unwatch = undefined;
        void load(false);
      });
    };
    if (ids.length === 0) setGot({ key, answers: [] });
    else void load(nonce > 0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      unwatch?.();
    };
  }, [key, online, week.since, week.until, week.back, nonce]);
  return { answers: got.key === key ? got.answers : [], loading: got.key !== key };
}
