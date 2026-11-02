import { describe, expect, test } from "bun:test";
import { FreshFrames } from "./fresh";

/** The watchdog on a manual clock; `log` is what it asked the panel and the screencast to do. */
function rig(driven: boolean) {
  let now = 0;
  let shown: string | null = "t1";
  const timers: { at: number; fn: () => void }[] = [];
  const log: string[] = [];
  const fresh = new FreshFrames(
    {
      after(fn, ms) {
        const timer = { at: now + ms, fn };
        timers.push(timer);
        return () => void timers.splice(timers.indexOf(timer) >>> 0, timers.includes(timer) ? 1 : 0);
      },
      shown: () => shown,
      driven: () => driven,
      stale: (id) => void log.push(`stale ${id}`),
      restart: () => void log.push("restart"),
    },
    500,
  );
  return {
    fresh,
    log,
    show(id: string) {
      shown = id;
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

describe("fresh frames", () => {
  test("a frame that follows the navigation keeps the picture: nothing restarts (the user's tab)", () => {
    const r = rig(true);
    r.fresh.expect("t1");
    r.advance(300);
    r.fresh.frame("t1");
    r.advance(5000);
    expect(r.log).toEqual(["stale null"]);
  });

  test("no frame in time: the picture is stale and the screencast restarts; the frame that follows clears it", () => {
    const r = rig(true);
    r.fresh.expect("t1");
    r.advance(499);
    expect(r.log).toEqual([]);
    r.advance(1);
    expect(r.log).toEqual(["stale t1", "restart"]);
    r.fresh.frame("t1");
    expect(r.log).toEqual(["stale t1", "restart", "stale null"]);
    r.advance(5000);
    expect(r.log).toHaveLength(3);
  });

  test("an agent's tab gets one more fresh frame once its first is in", () => {
    const r = rig(false);
    r.fresh.expect("t1");
    r.fresh.frame("t1");
    r.advance(499);
    expect(r.log).toEqual(["stale null"]);
    r.advance(1);
    expect(r.log).toEqual(["stale null", "restart"]);
    r.fresh.frame("t1");
    r.advance(5000);
    expect(r.log).toEqual(["stale null", "restart"]);
  });

  test("another tab's frame doesn't count, and a tab no longer shown isn't restarted for", () => {
    const r = rig(true);
    r.fresh.expect("t1");
    r.fresh.frame("t2");
    r.advance(500);
    expect(r.log).toEqual(["stale t1", "restart"]);

    const s = rig(true);
    s.fresh.expect("t1");
    s.show("t2");
    s.advance(500);
    expect(s.log).toEqual([]);
  });

  test("a new expectation replaces the pending one; reset forgets it", () => {
    const r = rig(true);
    r.fresh.expect("t1");
    r.advance(300);
    r.fresh.expect("t1");
    r.advance(300);
    expect(r.log).toEqual([]);
    r.advance(200);
    expect(r.log).toEqual(["stale t1", "restart"]);
    r.fresh.expect("t1");
    r.fresh.reset();
    r.advance(5000);
    expect(r.log).toEqual(["stale t1", "restart", "stale null"]);
  });
});
