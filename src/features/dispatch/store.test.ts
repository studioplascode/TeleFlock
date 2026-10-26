import { beforeAll, describe, expect, test } from "bun:test";
import type { DispatchEntry } from "./store";

// The store persists to localStorage, which bun doesn't provide: an in-memory stand-in.
const mem: Record<string, string> = {};
beforeAll(() => {
  globalThis.localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => {
      mem[k] = v;
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
});

describe("dispatch naming phase", () => {
  test("identical sends named by one shared answer get distinct names", async () => {
    // Dynamic: the store hydrates from localStorage at module load, so it must load after the stub.
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    // Identical prompts share one in-flight AI call (ai.ts), so both answers land in the same tick.
    let answer!: (slug: string) => void;
    // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
    const shared = new Promise<string>((r) => {
      answer = r;
    });
    const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
    const send = () => dispatchTask({ hostId: "h", repo: "/r/app", prompt: "fix flaky login test", options, taken: [], suggest: () => shared });
    const a = send();
    const b = send();
    expect(a.phase).toBe("naming");
    expect(a.name).not.toBe(b.name);

    answer("fix-flaky-login-test");
    await shared;
    await Promise.resolve();
    await Promise.resolve();

    const names = (useDispatch.getState().threads[threadKey("h", "/r/app")] ?? []).map((e) => [e.name, e.branch, e.aiNamed]);
    expect(names).toEqual([
      ["fix-flaky-login-test", "dispatch/fix-flaky-login-test", true],
      ["fix-flaky-login-test-2", "dispatch/fix-flaky-login-test-2", true],
    ]);
  });
});

describe("hosts, images and workload", () => {
  const options = { templateId: null, model: "default", thinking: "default" as const, plan: false };
  const img = { mime: "image/png", data: "iVBORw0KGgo=", preview: "data:image/png;base64,iVBORw0KGgo=" };

  test("an image-only task is named after its images and keeps them with the entry", async () => {
    const { dispatchTask, threadKey, useDispatch } = await import("./store");
    const { loadEntryImages } = await import("./images");
    const e = dispatchTask({ hostId: "h2", repo: "/r/app", prompt: "", images: [img], options, taken: [], suggest: null });
    expect(e).toMatchObject({ name: "image-task", branch: "dispatch/image-task", images: 1, hostId: "h2", repo: "/r/app" });
    expect(await loadEntryImages(e.id)).toEqual([{ mime: "image/png", data: "iVBORw0KGgo=" }]);
    // Dismissed → its images go too.
    useDispatch.getState().remove(threadKey("h2", "/r/app"), [e.id]);
    expect(await loadEntryImages(e.id)).toBeNull();
  });

  test("Auto entries live in the group thread but belong to (and reserve names on) their host", async () => {
    const { dispatchTask, entryHost, entryRepo, threadKey, useDispatch } = await import("./store");
    const key = threadKey("auto:farm", "github.com/acme/app");
    const a = dispatchTask({ key, hostId: "h3", repo: "/home/a/app", prompt: "fix the login page", options, taken: [], suggest: null });
    expect(useDispatch.getState().threads[key]?.map((x) => x.id)).toEqual([a.id]);
    expect(entryHost(key, a)).toBe("h3");
    expect(entryRepo(key, a)).toBe("/home/a/app");
    // Same host, another (single-host) thread: the Auto entry's name is taken there.
    const b = dispatchTask({ hostId: "h3", repo: "/home/a/app", prompt: "fix the login page", options, taken: [], suggest: null });
    expect(b.name).toBe(`${a.name}-2`);
    // Another host of the group: free.
    const c = dispatchTask({ key, hostId: "h4", repo: "/srv/app", prompt: "fix the login page", options, taken: [], suggest: null });
    expect(c.name).toBe(a.name);
    // Entries from before 0.5 (no hostId / repo) belong to the thread's host and repo.
    expect(entryHost(threadKey("old", "/x"), { hostId: undefined })).toBe("old");
    expect(entryRepo(threadKey("old", "/x"), { repo: undefined })).toBe("/x");
  });

  test("dispatches on their way count per host", async () => {
    const { pendingByHost } = await import("./store");
    const entry = (p: Pick<DispatchEntry, "phase"> & Partial<DispatchEntry>): DispatchEntry => ({ id: Math.random().toString(36), prompt: "x", createdAt: 1_000, branch: "dispatch/x", name: "x", options, ...p });
    const threads: Record<string, DispatchEntry[]> = {
      "auto:farm\u0000repo": [
        entry({ phase: "naming", hostId: "a" }),
        entry({ phase: "started", startedAt: 50_000, hostId: "a", agentId: "ag1" }),
        entry({ phase: "started", startedAt: 50_000, hostId: "b", agentId: "ag2" }),
        entry({ phase: "started", startedAt: 1_000, hostId: "b" }),
        entry({ phase: "failed", hostId: "b" }),
      ],
      "c\u0000/r": [entry({ phase: "naming" })],
    };
    // ag2 is already running (counted as an agent), the old start is past the window.
    expect(pendingByHost(threads, new Set(["ag2"]), 70_000)).toEqual({ a: 2, c: 1 });
  });
});
