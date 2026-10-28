/** What an `mcp.list` answer is: the page's read, a long-poll step, or a change's (save, remove, switch, sign-out). */
export type AnswerKind = "read" | "poll" | "change";

/**
 * Orders the `mcp.list` answers of one host and folder. They arrive in any order; the newest
 * request's answer is the one shown. A long-poll step asks again after an answer that was dropped
 * or still shows a check running. A change's answer is never just dropped: one that lost to a
 * read started after it may predate the change on the host (hostd answers requests concurrently),
 * so a fresh read follows it.
 */
export class AnswerOrder {
  #started = 0;
  #shown = 0;

  /** Numbers a request about to start. */
  start(): number {
    this.#started += 1;
    return this.#started;
  }

  /** Whether to show the answer of request `n` (it is then the one shown), and what to ask next. */
  answer(n: number, kind: AnswerKind, running: boolean): { show: boolean; next?: "poll" | "read" } {
    const show = n >= this.#shown;
    if (show) this.#shown = n;
    if (kind === "poll" && (!show || running)) return { show, next: "poll" };
    if (kind === "change" && !show) return { show, next: "read" };
    return { show };
  }
}
