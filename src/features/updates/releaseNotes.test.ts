import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type * as WhatsNew from "./releaseNotes";

// The record persists to `window.localStorage`, which bun doesn't provide: an in-memory stand-in,
// installed before the store module loads (it hydrates at load).
const mem: Record<string, string> = {};
const globals = globalThis as unknown as { window?: unknown };
let m: typeof WhatsNew;
beforeAll(async () => {
  const localStorage = {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => {
      mem[k] = v;
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
  };
  globals.window = { localStorage };
  // Dynamic: the store hydrates from localStorage at module load, so it loads after the stub.
  m = await import("./releaseNotes");
});
afterAll(() => {
  delete globals.window;
});

const v = (s: string) => {
  const p = m.parseVersion(s);
  if (!p) throw new Error(`not a version: ${s}`);
  return p;
};
const sorted = (versions: string[]) => [...versions].sort((a, b) => m.compareVersions(v(a), v(b)));

const note = (version: string, over: Partial<WhatsNew.ReleaseNote> = {}): WhatsNew.ReleaseNote => ({
  version,
  tag: `v${version}`,
  name: `TeleFlock ${version}`,
  body: `Notes of ${version}`,
  url: `https://github.com/studioplascode/TeleFlock/releases/tag/v${version}`,
  prerelease: version.includes("-"),
  ...over,
});
const LIST = ["0.9.0", "0.8.1", "0.8.0", "0.7.0", "0.6.1"].map((x) => note(x));

describe("versions", () => {
  test("parses releases, tags and build metadata; refuses what isn't semver", () => {
    expect(v("0.9.0")).toEqual({ major: 0, minor: 9, patch: 0, pre: [] });
    expect(v("v1.2.3-rc.1+build.5")).toEqual({ major: 1, minor: 2, patch: 3, pre: ["rc", "1"] });
    for (const bad of ["dev", "1.2", "1.2.3.4", "v1.2.x", "", "1.2.3-"]) expect(m.parseVersion(bad)).toBeNull();
  });

  test("orders numerically, not as text, and a pre-release sorts below its release", () => {
    expect(sorted(["0.10.0", "0.9.0", "0.9.10", "0.9.2", "1.0.0"])).toEqual(["0.9.0", "0.9.2", "0.9.10", "0.10.0", "1.0.0"]);
    expect(sorted(["1.0.0", "1.0.0-rc.1"])).toEqual(["1.0.0-rc.1", "1.0.0"]);
  });

  test("pre-release identifiers follow semver precedence (the spec's own example chain)", () => {
    const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    expect(sorted([...chain].reverse())).toEqual(chain);
  });

  test("build metadata and a leading v change nothing", () => {
    expect(m.compareVersions(v("v1.2.3+a"), v("1.2.3+b"))).toBe(0);
  });
});

describe("the skipped-versions range", () => {
  test("0.7.0 → 0.9.0 is 0.9.0, 0.8.1 and 0.8.0, newest first; the old ones stay out", () => {
    expect(m.releasesBetween(LIST, "0.7.0", "0.9.0").map((r) => r.version)).toEqual(["0.9.0", "0.8.1", "0.8.0"]);
  });

  test("a single step is that release; releases newer than the running version are left out", () => {
    expect(m.releasesBetween(LIST, "0.8.1", "0.9.0").map((r) => r.version)).toEqual(["0.9.0"]);
    expect(m.releasesBetween([note("0.9.1"), ...LIST], "0.7.0", "0.8.1").map((r) => r.version)).toEqual(["0.8.1", "0.8.0"]);
  });

  test("unordered input, repeated releases and a downgrade", () => {
    const messy = [note("0.8.0"), note("0.9.0"), note("0.8.1"), note("0.8.1")];
    expect(m.releasesBetween(messy, "0.7.0", "0.9.0").map((r) => r.version)).toEqual(["0.9.0", "0.8.1", "0.8.0"]);
    expect(m.releasesBetween(LIST, "0.9.0", "0.8.0")).toEqual([]);
    expect(m.releasesBetween(LIST, "0.9.0", "0.9.0")).toEqual([]);
  });

  test("release candidates only reach people on a release candidate", () => {
    const withRc = [note("0.9.0"), note("0.9.0-rc.2"), note("0.9.0-rc.1"), note("0.8.1")];
    expect(m.releasesBetween(withRc, "0.8.0", "0.9.0").map((r) => r.version)).toEqual(["0.9.0", "0.8.1"]);
    expect(m.releasesBetween(withRc, "0.8.0", "0.9.0-rc.2").map((r) => r.version)).toEqual(["0.9.0-rc.2", "0.9.0-rc.1", "0.8.1"]);
  });

  test("GitHub's list: drafts and tags that aren't versions are dropped, a missing body is empty", () => {
    const json = [
      { tag_name: "v0.9.0", name: "", body: null, html_url: "https://github.com/x/y/releases/tag/v0.9.0", published_at: "2026-10-01T00:00:00Z" },
      { tag_name: "v0.8.9", draft: true, body: "unpublished" },
      { tag_name: "nightly", body: "not a version" },
      { tag_name: "v0.8.1", name: "Flock", body: "  # Hi  ", prerelease: false, html_url: "javascript:alert(1)" },
    ];
    expect(m.parseReleases(json)).toEqual([
      { version: "0.9.0", tag: "v0.9.0", name: "v0.9.0", body: "", url: "https://github.com/x/y/releases/tag/v0.9.0", date: "2026-10-01T00:00:00Z", prerelease: false },
      { version: "0.8.1", tag: "v0.8.1", name: "Flock", body: "# Hi", url: "https://github.com/studioplascode/TeleFlock/releases/tag/v0.8.1", date: undefined, prerelease: false },
    ]);
    expect(m.parseReleases({ message: "API rate limit exceeded" })).toEqual([]);
  });
});

describe("when it may appear", () => {
  const NOW = 100_000;
  test("never over an open dialog, whatever the typing", () => {
    expect(m.canShowNow({ overlayOpen: true, lastTypedAt: undefined, now: NOW })).toBe(false);
  });

  test("waits for the user to stop typing, then appears", () => {
    expect(m.canShowNow({ overlayOpen: false, lastTypedAt: NOW - 500, now: NOW })).toBe(false);
    expect(m.canShowNow({ overlayOpen: false, lastTypedAt: NOW - m.TYPING_IDLE_MS + 1, now: NOW })).toBe(false);
    expect(m.canShowNow({ overlayOpen: false, lastTypedAt: NOW - m.TYPING_IDLE_MS, now: NOW })).toBe(true);
    expect(m.canShowNow({ overlayOpen: false, lastTypedAt: undefined, now: NOW })).toBe(true);
  });
});

describe("the per-device record", () => {
  beforeEach(() => m.whatsNewTesting.reset());

  /** A fetcher that counts its requests and answers `releases` (or fails). */
  const fetcher = (releases: WhatsNew.ReleaseNote[] | Error) => {
    const calls = { n: 0 };
    return {
      calls,
      run: async () => {
        calls.n++;
        if (releases instanceof Error) throw releases;
        return releases;
      },
    };
  };
  const state = () => m.useWhatsNew.getState();

  test("a plan per start: no record means fresh or from an older app, newer versions fetch, same or older do nothing", () => {
    expect(m.planStart(undefined, "0.9.0", false)).toEqual({ kind: "record" });
    expect(m.planStart("garbage", "0.9.0", false)).toEqual({ kind: "record" });
    expect(m.planStart(undefined, "0.9.0", true)).toEqual({ kind: "fetch", from: null });
    expect(m.planStart("garbage", "0.9.0", true)).toEqual({ kind: "fetch", from: null });
    // With a record, what the device holds is irrelevant.
    expect(m.planStart("0.7.0", "0.9.0", false)).toEqual({ kind: "fetch", from: "0.7.0" });
    expect(m.planStart("0.9.0-rc.1", "0.9.0", true)).toEqual({ kind: "fetch", from: "0.9.0-rc.1" });
    expect(m.planStart("0.9.0", "0.9.0", true)).toEqual({ kind: "skip" });
    expect(m.planStart("0.9.0", "0.8.1", true)).toEqual({ kind: "skip" });
    expect(m.planStart("0.8.1", "dev", true)).toEqual({ kind: "skip" });
  });

  test("a fresh install (no host yet) shows nothing, makes no request and records the version", async () => {
    const f = fetcher(LIST);
    await m.checkWhatsNew(false, "0.9.0", f.run);
    expect(f.calls.n).toBe(0);
    expect(state().seen).toBe("0.9.0");
    expect(state().waiting).toBeNull();
    expect(state().view).toBeNull();
  });

  test("an install from before the record existed (hosts configured, no record) is due the running version's notes only", async () => {
    const f = fetcher(LIST);
    await m.checkWhatsNew(true, "0.9.0", f.run);
    expect(f.calls.n).toBe(1);
    expect(state().seen).toBeUndefined();
    expect(state().waiting).toMatchObject({ kind: "notes", version: "0.9.0", releases: [{ version: "0.9.0" }] });
    m.showWaiting();
    m.dismissWhatsNew();
    expect(state().seen).toBe("0.9.0");
    // It is not shown again on the next launch.
    m.whatsNewTesting.launch();
    await m.checkWhatsNew(true, "0.9.0", f.run);
    expect(f.calls.n).toBe(1);
    expect(state().waiting).toBeNull();
  });

  test("such an install offline keeps the notes pending, then shows the link after three failed starts", async () => {
    const down = fetcher(new Error("offline"));
    for (let i = 0; i < 3; i++) {
      m.whatsNewTesting.launch();
      await m.checkWhatsNew(true, "0.9.0", down.run);
    }
    expect(state()).toMatchObject({ seen: undefined, failedStarts: 3, waiting: { kind: "link", version: "0.9.0" } });
  });

  test("after an update every skipped release waits for an idle moment, shows once and is recorded on dismissal", async () => {
    useSeen("0.7.0");
    const f = fetcher(LIST);
    await m.checkWhatsNew(true, "0.9.0", f.run);
    expect(f.calls.n).toBe(1);
    expect(state().view).toBeNull();
    expect(state().waiting).toMatchObject({ kind: "notes", version: "0.9.0" });
    expect(state().seen).toBe("0.7.0"); // not recorded until it was seen

    m.showWaiting();
    expect(state().view).toMatchObject({ kind: "notes", releases: [{ version: "0.9.0" }, { version: "0.8.1" }, { version: "0.8.0" }] });
    expect(state().waiting).toBeNull();
    m.dismissWhatsNew();
    expect(state().view).toBeNull();
    expect(state().seen).toBe("0.9.0");

    // The next launch has nothing to show.
    m.whatsNewTesting.launch();
    await m.checkWhatsNew(true, "0.9.0", f.run);
    expect(f.calls.n).toBe(1);
    expect(state().waiting).toBeNull();
  });

  test("it survives a restart before it was seen, and persists only the record", async () => {
    useSeen("0.7.0");
    await m.checkWhatsNew(true, "0.9.0", fetcher(LIST).run);
    m.whatsNewTesting.launch(); // quit with the notes still waiting
    expect(state().waiting).toBeNull();
    await m.checkWhatsNew(true, "0.9.0", fetcher(LIST).run);
    expect(state().waiting).toMatchObject({ kind: "notes" });

    m.showWaiting();
    m.dismissWhatsNew();
    const stored = mem["tf.whatsNew"]!;
    expect(JSON.parse(stored).state).toEqual({ seen: "0.9.0", failedStarts: 0 });
    useSeen(undefined); // a fresh page: memory empty, the stored record back
    mem["tf.whatsNew"] = stored;
    await m.useWhatsNew.persist.rehydrate();
    expect(state().seen).toBe("0.9.0");
  });

  test("a version without published notes is recorded silently", async () => {
    useSeen("0.8.1");
    await m.checkWhatsNew(true, "0.9.0", fetcher([note("0.8.1"), note("0.8.0")]).run);
    expect(state().waiting).toBeNull();
    expect(state().seen).toBe("0.9.0");
  });

  test("offline: the start is counted and the notes stay pending; the third failed start shows a link instead", async () => {
    useSeen("0.7.0");
    const down = fetcher(new Error("offline"));
    for (const failed of [1, 2]) {
      m.whatsNewTesting.launch();
      await m.checkWhatsNew(true, "0.9.0", down.run);
      expect(state()).toMatchObject({ failedStarts: failed, seen: "0.7.0", waiting: null, view: null });
    }
    m.whatsNewTesting.launch();
    await m.checkWhatsNew(true, "0.9.0", down.run);
    expect(down.calls.n).toBe(3);
    expect(state().waiting).toEqual({ kind: "link", version: "0.9.0" });
    m.showWaiting();
    m.dismissWhatsNew();
    expect(state()).toMatchObject({ seen: "0.9.0", failedStarts: 0 });
  });

  test("a later start that gets through shows the notes and clears the failures", async () => {
    useSeen("0.7.0");
    m.whatsNewTesting.launch();
    await m.checkWhatsNew(true, "0.9.0", fetcher(new Error("offline")).run);
    expect(state().failedStarts).toBe(1);
    m.whatsNewTesting.launch();
    await m.checkWhatsNew(true, "0.9.0", fetcher(LIST).run);
    expect(state().waiting).toMatchObject({ kind: "notes" });
    m.showWaiting();
    m.dismissWhatsNew();
    expect(state()).toMatchObject({ seen: "0.9.0", failedStarts: 0 });
  });

  test("one request per launch: the check runs once and reopening reuses the answer", async () => {
    useSeen("0.7.0");
    const f = fetcher(LIST);
    await Promise.all([m.checkWhatsNew(true, "0.9.0", f.run), m.checkWhatsNew(true, "0.9.0", f.run)]);
    await m.openWhatsNew("0.9.0", f.run);
    expect(f.calls.n).toBe(1);
  });

  test("reopening by hand shows the running version only and records nothing", async () => {
    useSeen("0.9.0");
    await m.openWhatsNew("0.8.1", fetcher(LIST).run);
    expect(state().view).toMatchObject({ kind: "notes", releases: [{ version: "0.8.1" }] });
    m.dismissWhatsNew();
    expect(state()).toMatchObject({ view: null, seen: "0.9.0" });
  });

  test("reopening offline, or for a version GitHub doesn't list, falls back to the release page", async () => {
    await m.openWhatsNew("0.9.0", fetcher(new Error("offline")).run);
    expect(state().view).toEqual({ kind: "link", version: "0.9.0" });
    m.whatsNewTesting.launch();
    await m.openWhatsNew("0.9.5", fetcher(LIST).run);
    expect(state().view).toEqual({ kind: "link", version: "0.9.5" });
    expect(m.releasePageUrl("0.9.5")).toBe("https://github.com/studioplascode/TeleFlock/releases/tag/v0.9.5");
  });

  test("closing while it loads stays closed", async () => {
    let answer!: (r: WhatsNew.ReleaseNote[]) => void;
    const slow = new Promise<WhatsNew.ReleaseNote[]>((r) => {
      answer = r;
    });
    const open = m.openWhatsNew("0.9.0", () => slow);
    expect(state().view).toEqual({ kind: "loading", version: "0.9.0" });
    m.dismissWhatsNew();
    answer(LIST);
    await open;
    expect(state().view).toBeNull();
  });

  test("an automatic modal waiting behind a manual one still appears after it", async () => {
    useSeen("0.7.0");
    await m.checkWhatsNew(true, "0.9.0", fetcher(LIST).run);
    await m.openWhatsNew("0.9.0", fetcher(LIST).run);
    m.showWaiting(); // a manual view is on screen: nothing replaces it
    expect(state().view).toMatchObject({ kind: "notes", releases: [{ version: "0.9.0" }] });
    expect(state().waiting).not.toBeNull();
    m.dismissWhatsNew();
    m.showWaiting();
    expect(state().view).toMatchObject({ releases: [{ version: "0.9.0" }, { version: "0.8.1" }, { version: "0.8.0" }] });
  });
});

function useSeen(seen: string | undefined): void {
  m.useWhatsNew.setState({ seen });
}
