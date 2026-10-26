import { useEffect, useState } from "react";
import { core, toApiError } from "@/core";
import type { ApiError, Automation, AutomationDraft, AutomationList, SchedulePreview } from "@/core/gen";
import { useHostQuery } from "@/features/workspace/shared/useHostQuery";

const POLL_MS = 30_000;
/** After a run comes due, ask again once hostd has had a moment to start it. */
const AFTER_DUE_MS = 2_500;

export interface AutomationsQuery {
  data: AutomationList | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** Waiting for the host to come online (the request re-runs by itself). */
  waiting: boolean;
  /** The host's tf-hostd predates automations (`unknown_method`). */
  outdated: boolean;
  reload(): void;
}

/**
 * `automation.list` of one host, refreshed every 30 s while the page is visible, when it becomes
 * visible again, and just after the soonest scheduled run (so next/last run stay current).
 */
export function useAutomations(hostId: string | undefined): AutomationsQuery {
  const q = useHostQuery(hostId, "automation.list", hostId ? {} : null);
  const { reload, data } = q;

  useEffect(() => {
    if (!hostId) return;
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => visible() && reload(), POLL_MS);
    const onVisible = () => visible() && reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hostId, reload]);

  const soonest = data?.automations.reduce<number | undefined>((min, a) => (a.nextRunAt !== undefined && (min === undefined || a.nextRunAt < min) ? a.nextRunAt : min), undefined);
  useEffect(() => {
    if (soonest === undefined) return;
    const wait = soonest - Date.now() + AFTER_DUE_MS;
    if (wait > POLL_MS || wait < 0) return;
    const timer = setTimeout(reload, wait);
    return () => clearTimeout(timer);
  }, [soonest, reload]);

  return { data, error: q.error, loading: q.loading, waiting: q.waiting, outdated: q.error?.code === "unknown_method", reload };
}

/** The editable draft of a saved automation. */
export function toDraft(a: Automation): AutomationDraft {
  return { id: a.id, name: a.name, enabled: a.enabled, schedule: a.schedule, cwd: a.cwd, worktree: a.worktree, prompt: a.prompt, model: a.model, thinking: a.thinking, plan: a.plan, catchUp: a.catchUp };
}

export interface PreviewState {
  /** The schedule `preview` answers (lags the typed one while the debounce runs). */
  schedule: string;
  preview?: SchedulePreview;
  error?: ApiError;
  loading: boolean;
}

/** The host's reading of `schedule` (`automation.preview`, host time zone), debounced 300 ms. */
export function useSchedulePreview(hostId: string, schedule: string, enabled: boolean): PreviewState {
  const [state, setState] = useState<PreviewState>({ schedule: "", loading: false });
  useEffect(() => {
    if (!enabled) return;
    const text = schedule.trim();
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      core
        .host(hostId)
        .call("automation.preview", { schedule: text })
        .then(
          (preview) => live && setState({ schedule: text, preview, loading: false }),
          (e: unknown) => live && setState({ schedule: text, error: toApiError(e), loading: false }),
        );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [hostId, schedule, enabled]);
  return state;
}
