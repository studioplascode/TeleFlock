import type { TranscriptItem } from "./gen";

/**
 * Whether a session's last turn failed or was stopped, so omp's retry (F5, `agent.retry`) has
 * something to run again. Walking the loaded rows from the newest, past the rows that aren't the
 * conversation (notices, model/mode markers, compactions, inbound IRC), it is retryable when the
 * first assistant, thinking or user row is an assistant row that ended in an error or an abort (a
 * text row, or the error row of a message that failed without text), or when a tool call after
 * that row failed or was aborted (the run stopped in its tools: no assistant row after them).
 * `row(i)` reads the i-th of `count` rows, oldest first, so the store's ids need no array.
 */
export function lastTurnRetryable(count: number, row: (i: number) => TranscriptItem | undefined): boolean {
  let toolFailed = false;
  for (let i = count - 1; i >= 0; i--) {
    const it = row(i);
    if (!it) continue;
    switch (it.kind) {
      case "notice":
      case "mode":
      case "compaction":
      case "irc":
        continue;
      case "tool":
        if (it.status === "error" || it.status === "aborted") toolFailed = true;
        continue;
      case "assistant":
        return toolFailed || it.stopReason === "error" || it.stopReason === "aborted" || it.error != null;
      default:
        return toolFailed;
    }
  }
  return toolFailed;
}
