import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { INITIAL_THEME, shownThemeCss, shownThemeId } from "./model";

// The theme store persists to localStorage and startTheme touches window/document, which bun doesn't
// provide: small stand-ins, removed again afterwards (test files share one process).
const KEY = "tf.theme";
const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

interface FakeWindow {
  localStorage: Storage;
  location: { search: string };
  keydown: ((e: unknown) => void)[];
  addEventListener(type: string, fn: (e: unknown) => void): void;
}
const fakeWindow = (search = ""): FakeWindow => ({
  localStorage: storage,
  location: { search },
  keydown: [],
  addEventListener(type, fn) {
    if (type === "keydown") this.keydown.push(fn);
  },
});
const style = { id: "", textContent: "" };
const fakeDocument = {
  getElementById: () => style,
  createElement: () => style,
  head: { lastElementChild: style, appendChild: () => {} },
  documentElement: { dataset: {} as Record<string, string> },
  querySelector: () => null,
  hidden: false,
  hasFocus: () => true,
};

const globals = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const STUBS = ["localStorage", "document", "getComputedStyle", "window"];
beforeAll(() => {
  for (const k of STUBS) saved[k] = globals[k];
  globals.localStorage = storage;
  globals.document = fakeDocument;
  globals.getComputedStyle = () => ({ colorScheme: "dark", getPropertyValue: () => "" });
  globals.window = fakeWindow();
});
afterAll(() => {
  for (const k of STUBS) {
    if (saved[k] === undefined) delete globals[k];
    else globals[k] = saved[k];
  }
});

const MINE = ":root { --color-bg: #123456; }";

// Dynamic: the store hydrates from localStorage at module load, so it loads after the stubs.
async function load() {
  const { useThemeStore } = await import("./store");
  const { startTheme, THEME_ESCAPE_KEYS } = await import("./apply");
  /** A fresh start: initial state, then what storage holds. */
  const restart = async () => {
    // resetting the in-memory state writes to storage: put back what the last run left
    const left = mem.get(KEY);
    useThemeStore.setState({ ...INITIAL_THEME });
    if (left === undefined) mem.delete(KEY);
    else mem.set(KEY, left);
    await useThemeStore.persist.rehydrate();
    return useThemeStore.getState();
  };
  const shown = () => shownThemeId(useThemeStore.getState());
  return { useThemeStore, startTheme, THEME_ESCAPE_KEYS, restart, shown };
}

/** A confirmed custom theme next to a premade one, as left by a previous run. */
async function seed() {
  const t = await load();
  mem.clear();
  t.useThemeStore.setState({ ...INITIAL_THEME });
  const created = t.useThemeStore.getState().create({ name: "Mine", css: MINE, base: "default" });
  if (!created.ok) throw new Error(created.error);
  return { ...t, id: created.id };
}

describe("trial across a restart", () => {
  test("a theme still on trial is not what a fresh start applies; Keep makes it stick", async () => {
    const { useThemeStore, restart, shown, id } = await seed();
    useThemeStore.getState().choose("nord");
    expect(useThemeStore.getState().choose(id)).toEqual({ ok: true, id });
    expect(shown()).toBe(id);
    expect(useThemeStore.getState().trial).not.toBeNull();

    // quit during the trial
    const started = await restart();
    expect(started.trial).toBeNull();
    expect(shownThemeId(started)).toBe("nord");
    expect(started.custom.map((t) => t.id)).toEqual([id]);

    // try again, keep, quit
    useThemeStore.getState().choose(id);
    useThemeStore.getState().keep();
    const kept = await restart();
    expect(shownThemeId(kept)).toBe(id);
    expect(shownThemeCss(kept)).toContain("#123456");
    expect(kept.trial).toBeNull();
  });
});

describe("escapes", () => {
  test("?theme=default starts with the default theme and keeps the saved themes", async () => {
    const { useThemeStore, startTheme, restart, shown, id } = await seed();
    useThemeStore.getState().choose(id);
    useThemeStore.getState().keep();
    expect((await restart()).active).toBe(id);

    globals.window = fakeWindow("?theme=default");
    startTheme({ owner: true });
    expect(shown()).toBe("default");
    expect(fakeDocument.documentElement.dataset.theme).toBe("default");
    expect(style.textContent).toBe("");
    // saved themes survive, and the default is what the next start applies too
    const next = await restart();
    expect(next.custom.map((t) => t.name)).toEqual(["Mine"]);
    expect(shownThemeId(next)).toBe("default");
  });

  test("a start without the parameter keeps the saved theme", async () => {
    const { useThemeStore, startTheme, restart, shown, id } = await seed();
    useThemeStore.getState().choose(id);
    useThemeStore.getState().keep();
    await restart();
    globals.window = fakeWindow("");
    startTheme({ owner: true });
    expect(shown()).toBe(id);
    expect(style.textContent).toContain(MINE);
  });

  test("Ctrl+Alt+Shift+T puts the default back, also from a theme on trial", async () => {
    const { useThemeStore, startTheme, THEME_ESCAPE_KEYS, shown, id } = await seed();
    expect(THEME_ESCAPE_KEYS).toBe("Ctrl+Alt+Shift+T");
    const win = fakeWindow("");
    globals.window = win;
    startTheme({ owner: true });
    useThemeStore.getState().choose("nord");
    useThemeStore.getState().choose(id); // on trial over Nord
    expect(shown()).toBe(id);
    expect(style.textContent).toContain(MINE);

    const press = (init: Record<string, unknown>) => {
      const e = { code: "KeyT", altKey: true, shiftKey: true, ctrlKey: true, metaKey: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...init };
      for (const fn of win.keydown) fn(e);
      return e;
    };
    // a different chord does nothing
    expect(press({ altKey: false }).prevented).toBe(false);
    expect(shown()).toBe(id);

    expect(press({}).prevented).toBe(true);
    const s = useThemeStore.getState();
    expect(shownThemeId(s)).toBe("default");
    expect(s.trial).toBeNull();
    expect(s.custom.map((t) => t.id)).toEqual([id]);
    expect(fakeDocument.documentElement.dataset.theme).toBe("default");
    expect(style.textContent).toBe("");
  });
});

describe("corrupted storage", () => {
  const BAD: [string, string][] = [
    ["not JSON", "{not json"],
    ["a JSON string", '"nord"'],
    ["null", "null"],
    ["a persisted envelope without state", '{"version":1}'],
    ["state of the wrong type", '{"state":"nord","version":1}'],
    ["fields of the wrong type", '{"state":{"active":42,"activeCss":{},"custom":"x"},"version":1}'],
    ["an unknown active theme", '{"state":{"active":"gone","custom":[]},"version":1}'],
    ["a custom active theme without its CSS", '{"state":{"active":"custom-a","custom":[{"id":"custom-a","name":"A","css":":root{}"}]},"version":1}'],
  ];
  for (const [what, raw] of BAD) {
    test(`${what}: a fresh start applies the default without throwing`, async () => {
      const { restart, startTheme } = await load();
      mem.set(KEY, raw);
      const started = await restart();
      expect(shownThemeId(started)).toBe("default");
      expect(started.trial).toBeNull();
      globals.window = fakeWindow("");
      expect(() => startTheme({ owner: false })).not.toThrow();
      expect(fakeDocument.documentElement.dataset.theme).toBe("default");
      expect(style.textContent).toBe("");
    });
  }

  test("a valid theme next to a broken one survives", async () => {
    const { restart } = await load();
    mem.set(KEY, JSON.stringify({ state: { active: "nord", custom: [null, { id: "custom-a", name: "A", css: ":root{}" }, 7] }, version: 1 }));
    const started = await restart();
    expect(started.active).toBe("nord");
    expect(started.custom.map((t) => t.id)).toEqual(["custom-a"]);
  });
});
