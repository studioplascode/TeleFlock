import { describe, expect, test } from "bun:test";
import { AGENT_NAME_MAX, agentNameFromBranch, clipName, uniqueAgentName } from "./paths";

describe("clipName", () => {
  test("keeps short names and cuts long ones at a word boundary", () => {
    expect(clipName("offline-cache", 24)).toBe("offline-cache");
    expect(clipName("implement-websocket-reconnection-backoff", 32)).toBe("implement-websocket-reconnection");
    expect(clipName("offline-caching-client", 15)).toBe("offline-caching");
    expect(clipName("offline-caching-client", 16)).toBe("offline-caching");
  });

  test("cuts a single over-long word hard", () => {
    expect(clipName("supercalifragilistic", 8)).toBe("supercal");
  });
});

describe("agent names stay within herdr's 32 chars", () => {
  test("agentNameFromBranch clips at a word boundary", () => {
    expect(agentNameFromBranch("dispatch/implement-websocket-reconnection-backoff")).toBe("implement-websocket-reconnection");
  });

  test("uniqueAgentName makes room for the suffix", () => {
    const base = "implement-websocket-reconnection";
    expect(uniqueAgentName(base, [])).toBe(base);
    const second = uniqueAgentName(base, [base]);
    expect(second).toBe("implement-websocket-2");
    expect(second.length).toBeLessThanOrEqual(AGENT_NAME_MAX);
    expect(uniqueAgentName("docs", ["docs", "docs-2"])).toBe("docs-3");
    expect(uniqueAgentName("", ["x"])).toBe("");
  });
});
