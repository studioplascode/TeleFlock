import { describe, expect, test } from "bun:test";
import { autoDeviceKind, choiceOn, describeTest, deviceGlyph, escalateLabel, escalateOptions, idleChoice, kindsLabel, PUSH_KIND_CHOICES, toggleChoice } from "./alerts";

const policy = { route: true, escalateAfterS: 300, escalateTo: "phones" } as const;
const device = (name: string) => ({ name, platform: "linux", me: false });

describe("labels", () => {
  test("escalation delays read as minutes, 0 as Never", () => {
    expect(escalateLabel(0)).toBe("Never");
    expect(escalateLabel(60)).toBe("1 min");
    expect(escalateLabel(300)).toBe("5 min");
    expect(escalateLabel(90)).toBe("1.5 min");
    expect(escalateLabel(30)).toBe("30 s");
  });

  test("a host value outside the standard choices is still offered", () => {
    expect(escalateOptions(300)).toEqual([0, 60, 120, 300, 600, 900, 1800]);
    expect(escalateOptions(240)).toEqual([0, 60, 120, 240, 300, 600, 900, 1800]);
  });

  test("idle after snaps a stray stored value to the nearest choice; absent is 3", () => {
    expect(idleChoice(undefined)).toBe(3);
    expect(idleChoice(5)).toBe(5);
    expect(idleChoice(4)).toBe(3);
    expect(idleChoice(60)).toBe(15);
  });

  test("Auto follows the platform", () => {
    expect(autoDeviceKind({ android: true, tauri: true })).toBe("phone");
    expect(autoDeviceKind({ android: false, tauri: true })).toBe("desktop");
    expect(autoDeviceKind({ android: false, tauri: false })).toBe("web");
  });

  test("device glyph from the reported kind, else from the platform string", () => {
    expect(deviceGlyph("android")).toBe("phone");
    expect(deviceGlyph("Windows")).toBe("desktop");
    expect(deviceGlyph("web")).toBe("web");
    expect(deviceGlyph("linux", "phone")).toBe("phone");
    expect(deviceGlyph("android", "desktop")).toBe("desktop");
    expect(deviceGlyph("plan9")).toBe("desktop");
  });
});

describe("push kinds", () => {
  const errors = PUSH_KIND_CHOICES.find((c) => c.id === "errors");
  const needs = PUSH_KIND_CHOICES.find((c) => c.id === "needs");
  if (!errors || !needs) throw new Error("choices");

  test("Errors and stalls is error + quiet together", () => {
    expect(choiceOn(["needs", "error"], errors)).toBe(false);
    expect(choiceOn(["needs", "error", "quiet"], errors)).toBe(true);
    expect(toggleChoice(["needs"], errors, true)).toEqual(["needs", "error", "quiet"]);
  });

  test("toggling one choice leaves the others and keeps a stable order", () => {
    expect(toggleChoice(["finished", "error", "quiet"], needs, true)).toEqual(["needs", "error", "quiet", "finished"]);
    expect(toggleChoice(["needs", "error", "quiet", "finished"], errors, false)).toEqual(["needs", "finished"]);
  });

  test("summary names the choices", () => {
    expect(kindsLabel(["needs", "error", "quiet", "finished"])).toBe("Needs you · Errors and stalls · Finished");
    expect(kindsLabel([])).toBe("No notifications");
  });
});

describe("describeTest", () => {
  test("names who was alerted at once", () => {
    expect(describeTest({ alerted: ["Laptop"] }, { policy, devices: [device("Laptop")] })).toEqual({ title: "Sent to Laptop", status: "done" });
  });

  test("nobody in use: says where it goes next", () => {
    const r = describeTest({ alerted: [] }, { policy, devices: [device("Pixel")] });
    expect(r.title).toBe("No device in use: it goes to your phones after 5 min unseen");
    expect(describeTest({ alerted: [] }, { policy: { ...policy, escalateAfterS: 0 }, devices: [device("Pixel")] }).title).toContain("nothing is sent until");
  });

  test("no app connected: pushed or not", () => {
    expect(describeTest({ alerted: [], push: { at: 1, ok: true, test: true } }, { policy, devices: [] }).title).toBe("No app connected: pushed");
    expect(describeTest({ alerted: [] }, { policy, devices: [] }).status).toBe("idle");
  });
});
