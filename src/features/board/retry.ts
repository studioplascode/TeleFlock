import type { Agent, RetryWait } from "@/core/gen";

/**
 * omp's wait to retry a provider error (`OmpInfo.retry`: rate limit, usage limit, overload): the
 * agent is not stuck, so it is never "quiet" while this holds. Once omp gave up, the auto-resume
 * ticket (`Agent.autoResume`) takes over the words and this is absent.
 */
export function retryOf(agent: Pick<Agent, "omp" | "autoResume"> | undefined): RetryWait | undefined {
  return agent?.autoResume ? undefined : agent?.omp?.retry;
}
