import { describe, expect, test } from "bun:test";
import type { Automation, AutoAnswer } from "@/core/gen";
import { automationDraft, initialForm } from "./AutomationEditor";
import { toDraft } from "./useAutomations";

const own: AutoAnswer = { enabled: true, afterSecs: 1_800, onlyWhenNoApp: true };
const saved: Automation = {
  id: "au1",
  name: "Nightly audit",
  enabled: true,
  schedule: "0 9 * * 1-5",
  cwd: "/home/ada/app",
  worktree: true,
  prompt: "Audit the dependencies",
  plan: false,
  roleModels: { smol: "openai/gpt-5-mini:low" },
  catchUp: true,
  autoAnswer: own,
  herdrSession: "default",
  createdAt: 1,
  updatedAt: 2,
};

describe("automation drafts: decide for me", () => {
  test("editing loads the automation's own policy and saves it back", () => {
    const form = initialForm(saved);
    expect(form.autoAnswer).toEqual(own);
    expect(automationDraft(form, saved.id, true)).toMatchObject({ id: "au1", name: "Nightly audit", roleModels: saved.roleModels, autoAnswer: own });
  });

  test("the host default sends nothing", () => {
    const fresh = { ...initialForm(undefined), name: "Notes", cwd: "/home/ada/notes", prompt: "Tidy the notes" };
    expect(fresh.autoAnswer).toBeUndefined();
    expect("autoAnswer" in automationDraft(fresh, undefined, true)).toBe(false);
    expect("autoAnswer" in automationDraft(initialForm({ ...saved, autoAnswer: undefined }), saved.id, true)).toBe(false);
  });

  test("a host without decide for me never gets the field", () => {
    expect("autoAnswer" in automationDraft(initialForm(saved), saved.id, false)).toBe(false);
  });

  test("the card's switch keeps everything the automation saved", () => {
    expect({ ...toDraft(saved), enabled: false }).toMatchObject({ enabled: false, schedule: "0 9 * * 1-5", roleModels: saved.roleModels, autoAnswer: own });
    expect(toDraft({ ...saved, autoAnswer: undefined }).autoAnswer).toBeUndefined();
  });
});
