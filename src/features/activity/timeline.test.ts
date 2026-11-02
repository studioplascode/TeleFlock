import { describe, expect, test } from "bun:test";
import { isTimelineNotice, noticeName } from "./timeline";

describe("isTimelineNotice", () => {
  test("a quiet agent and the host's own notices get rows: the feed has no entry for them", () => {
    expect(isTimelineNotice({ kind: "quiet", agentId: "term_1" })).toBe(true);
    // herdr is running again, a test notification, "Closed 3 idle shells"
    expect(isTimelineNotice({ kind: "info", agentId: "" })).toBe(true);
  });

  test("a notice about an agent does not: a refusal fallback shows once, as its activity entry", () => {
    // "ana · continued on Sonnet 5.5" comes with the entry "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued"
    expect(isTimelineNotice({ kind: "info", agentId: "term_1" })).toBe(false);
    for (const kind of ["needs", "finished", "error"] as const) expect(isTimelineNotice({ kind, agentId: "term_1" })).toBe(false);
  });
});

describe("noticeName", () => {
  test("a notice row names its agent as the app knows it, never by its terminal id; the host's own is TeleFlock's", () => {
    expect(noticeName({ agentId: "term_65f3" }, "push")).toBe("push");
    expect(noticeName({ agentId: "" }, undefined)).toBe("TeleFlock");
    // gone from the board, and no activity of its own loaded
    expect(noticeName({ agentId: "term_0000" }, undefined)).toBe("An agent");
  });
});
