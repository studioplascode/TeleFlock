import { useEffect, useRef } from "react";
import { type CoreState, core, navigate, useCore, useUi } from "@/core";
import type { ConnStatus } from "@/core/gen";
import { formatAge, toast } from "@/design";
import { decidedSince } from "@/features/autoAnswer/review";
import { openHostPage } from "@/features/notify/openNotification";
import { awayDigest } from "./awayDigest";

/** Gaps shorter than this are network blips, not "being away". */
const MIN_AWAY_MS = 45_000;
/** Give the fresh snapshot a moment to land after the phase flips to online. */
const SETTLE_MS = 1500;

interface HostMark {
  phase: ConnStatus["phase"];
  /** When we last knew the host was online (start of the gap), if it is not online now. */
  awaySince: number | null;
  /** Today's cost from the last snapshot we saw before the gap (cache or live). */
  costBefore: number | null;
}

/** Per-host connection memory; module-level so a gap that ends while the board is hidden is reported on return. */
const MARKS: Record<string, HostMark> = {};

/**
 * "While you were away" digest (spec §5 Activity): when a host comes back online after a real
 * gap, toast what finished, what needs you now, the questions decide for me answered for you in
 * between (still unreviewed) and what it cost. Renders nothing.
 */
export function WhileAwayToast(): null {
  const statuses = useCore((s) => s.status);
  const marks = useRef(MARKS);
  const costs = useCore((s) => s.hosts);
  const costsRef = useRef(costs);
  useEffect(() => {
    costsRef.current = costs;
  }, [costs]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    for (const [hostId, st] of Object.entries(statuses)) {
      const prev = marks.current[hostId];
      const cost = costsRef.current[hostId]?.state.usage.costUsd ?? null;
      if (!prev) {
        // first sighting: only a cached (not yet online) host starts a gap we can report on
        marks.current[hostId] = { phase: st.phase, awaySince: st.phase === "online" ? null : (st.lastOnlineAt ?? null), costBefore: cost };
        continue;
      }
      if (st.phase !== "online") {
        if (prev.phase === "online") {
          prev.awaySince = st.lastOnlineAt ?? st.since;
          prev.costBefore = cost;
        }
      } else if (prev.phase !== "online" && prev.awaySince !== null) {
        const since = prev.awaySince;
        const before = prev.costBefore;
        if (st.since - since >= MIN_AWAY_MS) timers.current.push(window.setTimeout(() => void digest(hostId, since, before, costsRef), SETTLE_MS));
        prev.awaySince = null;
      }
      prev.phase = st.phase;
    }
  }, [statuses]);

  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  return null;
}

async function digest(hostId: string, since: number, costBefore: number | null, costsRef: { current: CoreState["hosts"] }) {
  let finished = 0;
  let asked = 0;
  try {
    const page = await core.host(hostId).call("host.activity", { limit: 200 });
    for (const ev of page.events) {
      if (ev.at < since) continue;
      if (ev.kind === "finished") finished++;
      else if (ev.kind === "asked") asked++;
    }
  } catch {
    // activity unavailable: still report what the state tells us
  }
  const entry = costsRef.current[hostId];
  if (!entry) return;
  const needsNow = entry.state.agents.filter((a) => a.column === "needs").length;
  const spent = costBefore !== null ? Math.max(0, entry.state.usage.costUsd - costBefore) : null;
  const decided = decidedSince(entry.state.info.decisions, since);
  const d = awayDigest({ finished, asked, needsNow, decided, spent });
  if (!d) return;
  toast({
    title: `While you were away · ${entry.state.info.hostname}`,
    description: `${d.parts.join(" · ")} — over the last ${formatAge(Date.now() - since).replace(/ ago$/, "")}.`,
    status: d.status,
    duration: 14_000,
    action:
      d.action === "answer"
        ? { label: "Answer next", onClick: () => useUi.getState().setAnswerNext(true) }
        : d.action === "review"
          ? { label: "Review", onClick: () => openHostPage(hostId, "decisions") }
          : { label: "Activity", onClick: () => navigate({ name: "activity" }) },
  });
}
