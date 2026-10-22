import { describe, expect, test } from "bun:test";
import { askText } from "./askText";

describe("askText", () => {
  test("a generic title gives way to the message", () => {
    expect(askText({ title: "Question", message: "Which push provider?" })).toEqual({ headline: "Which push provider?", body: null });
    expect(askText({ title: "Continue?", message: "This rewrites 14 files. Continue?" })).toEqual({ headline: "This rewrites 14 files. Continue?", body: null });
  });

  test("a real title keeps the message as the body", () => {
    expect(askText({ title: "Open a draft PR?", message: "Push ci/bun-cache and open a draft PR against main?" })).toEqual({
      headline: "Open a draft PR?",
      body: "Push ci/bun-cache and open a draft PR against main?",
    });
    expect(askText({ title: "Same", message: "Same" })).toEqual({ headline: "Same", body: null });
  });

  test("approvals leave the command to its code block", () => {
    const command = "bun run db:migrate --env staging";
    expect(askText({ title: "Allow bash?", message: `Allow tool: bash\n\n${command}`, command, approval: true })).toEqual({ headline: "Allow bash?", body: null });
    expect(askText({ title: command, message: command, command, approval: true })).toEqual({ headline: "Allow this command?", body: null });
    expect(askText({ title: `Run ${command}?`, message: `Needed for the new table.\n\n\n\n${command}`, command, approval: true })).toEqual({
      headline: "Needed for the new table.",
      body: null,
    });
  });
});
