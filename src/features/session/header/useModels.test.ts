import { describe, expect, test } from "bun:test";
import { mergeRoles } from "./useModels";

describe("mergeRoles", () => {
  const host = [
    { role: "default", model: "mock/lab-1" },
    { role: "smol", model: "mock/lab-1" },
  ];

  test("an agent's own role replaces the host's model, in the host's order", () => {
    expect(mergeRoles(host, { smol: "mock/lab-2:low" })).toEqual([
      { role: "default", model: "mock/lab-1" },
      { role: "smol", model: "mock/lab-2:low" },
    ]);
  });

  test("a role only the agent has comes after the host's; no own roles leaves the host's", () => {
    expect(mergeRoles(host, { designer: "mock/lab-3" }).map((r) => r.role)).toEqual(["default", "smol", "designer"]);
    expect(mergeRoles(host, {})).toEqual(host);
  });
});
