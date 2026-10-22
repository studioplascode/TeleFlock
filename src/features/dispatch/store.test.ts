import { beforeAll, describe, expect, test } from "bun:test";

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
