import { failureReporter } from "../failures";
import { type ReduceResult, reduceEvents } from "./reduce";
import type { CoreEvent, CoreState, Effect } from "./state";

const reducerFailed = failureReporter("reducer");

function describe(e: CoreEvent): string {
  const key = "agentId" in e ? `${e.hostId}::${e.agentId}` : "hostId" in e ? e.hostId : undefined;
  return key === undefined ? `skipped a ${e.type} event` : `skipped a ${e.type} event of ${key}`;
}

/**
 * `reduceEvents` for one frame that never loses the frame to one bad event. The frame is reduced
 * in one pass; when that throws (copy-on-write: `prev` is untouched), it is applied again one event
 * at a time, each on the state the previous one produced, and only the events that throw are
 * skipped (and reported). The others commit in order, with their effects.
 */
export function reduceSafely(prev: CoreState, events: readonly CoreEvent[], now = Date.now()): ReduceResult {
  try {
    return reduceEvents(prev, events, now);
  } catch {
    // Some event of the frame throws: find it below.
  }
  let state = prev;
  const effects: Effect[] = [];
  for (const e of events) {
    try {
      const r = reduceEvents(state, [e], now);
      state = r.state;
      for (const fx of r.effects) effects.push(fx);
    } catch (err) {
      reducerFailed(err, describe(e));
    }
  }
  return { state, effects };
}
