import { describe, expect, test } from "bun:test";
import { pasteMenuItems, stepMenu } from "./usePasteAttach";

const p = { n: 3, text: "x\n".repeat(150), mode: "block" as const, at: 1 };

describe("paste menu", () => {
  test("omp's three choices, in omp's order and words, when the paste opens it", () => {
    const items = pasteMenuItems(p, true);
    expect(items.map((i) => i.label)).toEqual(["Attach as a wrapped block", "Attach as local file", "Paste inline"]);
    expect(items.map((i) => i.description)).toEqual([
      "Wrap the text in <attachment> tags, collapsed to a marker",
      "Save the text to a local://paste file",
      "Collapse the text to an inline paste marker",
    ]);
    expect(items.some((i) => i.checked)).toBe(false);
  });

  test("from a chip: the current choice is marked, plus Edit as text and Remove", () => {
    const items = pasteMenuItems(p, false);
    expect(items.map((i) => i.action)).toEqual(["block", "file", "inline", "edit", "remove"]);
    expect(items.find((i) => i.checked)?.action).toBe("block");
  });

  test("without a session the file choice is off with its reason, and arrows skip it", () => {
    const items = pasteMenuItems(p, true, "No session yet");
    expect(items[1]).toMatchObject({ action: "file", disabled: true, description: "No session yet" });
    expect(stepMenu(items, 0, 1)).toBe(2);
    expect(stepMenu(items, 2, -1)).toBe(0);
    expect(stepMenu(items, 2, 1)).toBe(0);
  });
});
