import { describe, expect, test } from "bun:test";
import { core, getRoute, type HostNotification, markAgentNotificationsRead, useUi } from "@/core";
import type { NotifyAction, PresentedArtifact } from "@/core/gen";
import { coreStore } from "@/core/store/store";
import { openDoc, useFullscreenDoc } from "@/features/session/artifacts/viewer";
import { notificationPage, openNotification } from "./openNotification";
import { notificationDocument } from "./presented";

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

describe("a presented document's notification", () => {
  const presented = (name: string): HostNotification => ({
    id: "n1",
    at: 1,
    kind: "presented",
    agentId: "docs",
    title: "docs presented Q3 revenue report",
    body: "HTML page · version 2",
    actions: [{ id: `open:${name}`, label: "View" }],
    hostId: "forge",
    read: false,
  });

  test("names its snapshot; pages and answers do not", () => {
    expect(notificationDocument(presented("presented/q3-revenue-report-v2.html"))).toBe("presented/q3-revenue-report-v2.html");
    expect(notificationDocument({ actions: [action("open:idleShells")] })).toBeUndefined();
    expect(notificationDocument({ actions: [action("open:presented/x-v1.md", { choices: ["y"], cancel: false, chat: false })] })).toBeUndefined();
  });

  test("opens the agent's session with that document: beside it on desktop, full screen on a phone", () => {
    const realWindow = globalThis.window;
    const realApp = core.app;
    core.app = (() => Promise.resolve({})) as never;
    const artifact: PresentedArtifact = { title: "Q3 revenue report", kind: "html", name: "presented/q3-revenue-report-v2.html", url: "local://presented/q3-revenue-report-v2.html", slug: "q3-revenue-report", version: 2, size: 9, assets: 3 };
    try {
      // Desktop, the session loaded: its card of the call says what the document is.
      globalThis.window = { location: { hash: "" }, innerWidth: 1280 } as never;
      const card = { kind: "tool", id: "t:c1", at: 1, callId: "c1", tool: "present", title: "Q3 revenue report", args: {}, status: "ok", truncated: false, artifact };
      coreStore.setState({ sessions: { "forge::docs": { items: { "t:c1": card }, itemIds: ["t:c1"], hasMore: false } } as never });
      openNotification(presented(artifact.name));
      expect(getRoute()).toEqual({ name: "agent", hostId: "forge", agentId: "docs" });
      expect(useUi.getState().split).toEqual({ kind: "artifact", key: "forge::docs", file: "local", name: artifact.name, as: "html", title: "Q3 revenue report", language: undefined });
      expect(useFullscreenDoc.getState().doc).toBeNull();

      // A phone, the session not loaded yet (a subagent presented it): full screen, by its name.
      useUi.getState().setSplit(null);
      coreStore.setState({ sessions: {} });
      globalThis.window = { location: { hash: "" }, innerWidth: 412 } as never;
      openNotification(presented("presented/board-test-report-v3.md"));
      expect(getRoute()).toEqual({ name: "agent", hostId: "forge", agentId: "docs" });
      expect(useFullscreenDoc.getState().doc).toEqual({ agentKey: "forge::docs", kind: "local", name: "presented/board-test-report-v3.md" });
      expect(useUi.getState().split).toBeNull();
    } finally {
      core.app = realApp;
      useFullscreenDoc.setState({ doc: null });
      useUi.getState().setSplit(null);
      coreStore.setState({ sessions: {} });
      if (realWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else globalThis.window = realWindow;
    }
  });

  /** Records `core.app` calls while `run` runs, with a store holding `notes`. */
  function withNotes(notes: HostNotification[], run: (told: unknown[]) => void): void {
    const told: unknown[] = [];
    const realApp = core.app;
    core.app = ((method: string, params: unknown) => {
      told.push([method, params]);
      return Promise.resolve({});
    }) as never;
    coreStore.setState({ notifications: notes });
    try {
      run(told);
    } finally {
      core.app = realApp;
      useUi.getState().setSplit(null);
      coreStore.setState({ notifications: [] });
    }
  }
  const note = (id: string, kind: HostNotification["kind"], name?: string): HostNotification => ({ ...presented(name ?? ""), id, kind, actions: name ? [{ id: `open:${name}`, label: "View" }] : [] });
  const unread = () => coreStore.getState().notifications.filter((n) => !n.read).map((n) => n.id);

  test("stays unread while its agent's session is open (a notice arriving there, or the session opening)", () => {
    withNotes([note("f1", "finished"), note("p1", "presented", "presented/q3-revenue-report-v1.html")], (told) => {
      markAgentNotificationsRead("forge", "docs");
      expect(unread()).toEqual(["p1"]);
      expect(told).toEqual([["app.notifyRead", { hostId: "forge", agentId: "docs" }]]);
    });
  });

  test("is read once its document is opened, every version's, here and on the other devices", () => {
    const notes = [note("p1", "presented", "presented/q3-revenue-report-v1.html"), note("p2", "presented", "presented/q3-revenue-report-v2.html"), note("p3", "presented", "presented/board-test-report-v1.md")];
    withNotes(notes, (told) => {
      openDoc({ agentKey: "forge::docs", kind: "local", name: "presented/q3-revenue-report-v1.html" }, false);
      expect(unread()).toEqual(["p3"]);
      expect(told).toEqual([["app.notifyRead", { hostId: "forge", ids: ["p1", "p2"] }]]);
      // Another agent's document of the same name is not this one.
      openDoc({ agentKey: "forge::ana", kind: "local", name: "presented/board-test-report-v1.md" }, false);
      expect(unread()).toEqual(["p3"]);
    });
  });
});
