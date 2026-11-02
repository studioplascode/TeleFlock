import { describe, expect, test } from "bun:test";
import { core, type HostNotification } from "@/core";
import type { NotifyAction } from "@/core/gen";
import { coreStore } from "@/core/store/store";
import { notificationPage, openNotification } from "./openNotification";

const action = (id: string, answer?: NotifyAction["answer"]): NotifyAction => ({ id, label: "x", answer });

describe("notificationPage", () => {
  test("the idle-shells summary opens the Cleanup page's idle shells", () => {
    expect(notificationPage({ actions: [action("open:idleShells")] })).toBe("idleShells");
    expect(notificationPage({ actions: [action("approve", { choices: ["y"], cancel: false, chat: false }), action("open:idleShells")] })).toBe("idleShells");
  });

  test("a decided-for-you notification opens its decision in the Inbox", () => {
    expect(notificationPage({ actions: [action("open:decisions")] })).toBe("decisions");
  });

  test("agent notifications and unknown pages open the agent", () => {
    expect(notificationPage({ actions: [] })).toBeUndefined();
    expect(notificationPage({ actions: [action("open:somewhere")] })).toBeUndefined();
    // An answer is never a page, whatever its id.
    expect(notificationPage({ actions: [action("open:idleShells", { choices: ["y"], cancel: false, chat: false })] })).toBeUndefined();
  });
});

describe("openNotification", () => {
  test("a host's own notice is read once opened (no session view reads it, as one reads an agent's)", () => {
    const told: unknown[] = [];
    const realApp = core.app;
    core.app = ((method: string, params: unknown) => {
      told.push([method, params]);
      return Promise.resolve({});
    }) as never;
    // navigate() only sets the location's hash; bun has no window
    const realWindow = globalThis.window;
    globalThis.window = { location: { hash: "" } } as never;
    try {
      const note = (id: string, agentId: string, actions: NotifyAction[] = []): HostNotification => ({ id, at: 1, kind: "info", agentId, title: id, body: "", actions, hostId: "forge", read: false });
      const shells = note("Closed 3 idle shells", "", [action("open:idleShells")]);
      coreStore.setState({ notifications: [shells, note("push finished", "push")] });
      openNotification(shells);
      expect(coreStore.getState().notifications.map((n) => [n.id, n.read])).toEqual([
        ["Closed 3 idle shells", true],
        ["push finished", false],
      ]);
      // read on the other devices too: the wire reads the host's own notices as an agent "" of the host
      expect(told).toEqual([["app.notifyRead", { hostId: "forge", agentId: "" }]]);
    } finally {
      core.app = realApp;
      if (realWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else globalThis.window = realWindow;
      coreStore.setState({ notifications: [] });
    }
  });
});
