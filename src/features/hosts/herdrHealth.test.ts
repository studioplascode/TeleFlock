import { describe, expect, test } from "bun:test";
import type { HerdrHealth, HerdrUpdate } from "@/core/gen";
import {
  forceRestartWarning,
  herdrAgentLine,
  herdrAgentWord,
  herdrBackUp,
  herdrClock,
  herdrConfigNote,
  herdrDown,
  herdrHeadline,
  herdrNotRunning,
  herdrNotUp,
  herdrStatus,
  herdrUpdateNote,
  inWords,
  isHerdrDownError,
  loadNowConfirm,
} from "./herdrHealth";

const NOW = new Date(2026, 9, 29, 14, 5, 0).getTime();
const DOWN_AT = new Date(2026, 9, 29, 13, 58, 30).getTime();

const health = (over: Partial<HerdrHealth> = {}): HerdrHealth => ({
  state: "down",
  since: DOWN_AT,
  epoch: 1,
  downAt: DOWN_AT,
  cause: "stopped",
  keptPanes: false,
  herdrResumes: false,
  endedAgents: 9,
  attempt: 0,
  restartHeld: false,
  configEdited: false,
  config: { autoRestart: true, idleUpdate: true, idleMinutes: 20 },
  ...over,
});

const update = (over: Partial<HerdrUpdate> = {}): HerdrUpdate => ({ state: "waiting", from: "0.9.5", to: "0.9.6", mode: "handoff", blockers: [], ...over });

describe("herdrDown / herdrNotUp", () => {
  test("down, starting, restarting and unresponsive are down; up and updating are not", () => {
    for (const state of ["down", "starting", "restarting", "unresponsive"] as const) expect(herdrDown(health({ state }))).toBe(true);
    for (const state of ["up", "updating"] as const) expect(herdrDown(health({ state }))).toBe(false);
    expect(herdrDown(undefined)).toBe(false);
  });
  test("a live handoff still gets a banner", () => {
    expect(herdrNotUp(health({ state: "updating" }))).toBe(true);
    expect(herdrNotUp(health({ state: "up" }))).toBe(false);
    expect(herdrNotUp(undefined)).toBe(false);
  });
});

describe("herdrHeadline", () => {
  test("stopped and crashed name the local time and the agents that ended", () => {
    expect(herdrClock(DOWN_AT)).toBe("13:58");
    expect(herdrHeadline(health())).toBe("herdr stopped at 13:58 · 9 agents ended");
    expect(herdrHeadline(health({ cause: "crashed", endedAgents: 1 }))).toBe("herdr crashed at 13:58 · 1 agent ended");
    expect(herdrHeadline(health({ endedAgents: 0, downAt: undefined, cause: undefined }))).toBe("herdr stopped");
  });
  test("the headline survives the start attempt", () => {
    expect(herdrHeadline(health({ state: "starting", attempt: 1 }))).toBe("herdr stopped at 13:58 · 9 agents ended");
  });
  test("not answering keeps agents running", () => {
    expect(herdrHeadline(health({ state: "unresponsive", cause: "notAnswering", endedAgents: 0 }))).toBe("herdr is not answering");
  });
  test("a restart TeleFlock asked for is not a stop", () => {
    expect(herdrHeadline(health({ state: "restarting", cause: "restart" }))).toBe("herdr is restarting");
    expect(herdrHeadline(health({ state: "starting", cause: "update", update: update() }))).toBe("herdr is restarting to load 0.9.6");
  });
  test("a live handoff", () => {
    expect(herdrHeadline(health({ state: "updating", cause: undefined, update: update({ state: "running" }) }))).toBe("herdr is loading 0.9.6");
  });
});

describe("herdrStatus", () => {
  test("down with a retry counts down", () => {
    expect(herdrStatus(health({ retryAt: NOW + 12_000 }), NOW)).toBe("Starting it again in 12s");
    expect(herdrStatus(health({ retryAt: NOW - 1 }), NOW)).toBe("Starting it again…");
  });
  test("a failed attempt shows its error and the next try", () => {
    expect(herdrStatus(health({ attempt: 3, error: "port busy", retryAt: NOW + 60_000 }), NOW)).toBe("Attempt 3 failed: port busy · next try in 1m 00s");
  });
  test("starting", () => {
    expect(herdrStatus(health({ state: "starting", attempt: 1 }), NOW)).toBe("Starting herdr…");
    expect(herdrStatus(health({ state: "starting", attempt: 2 }), NOW)).toBe("Starting herdr… (attempt 2)");
  });
  test("automatic restart off", () => {
    const config = { autoRestart: false, idleUpdate: true, idleMinutes: 20 };
    expect(herdrStatus(health({ config }), NOW)).toBe("Automatic restart is off for this host");
    expect(herdrStatus(health({ config, attempt: 1, error: "boom" }), NOW)).toBe("Attempt 1 failed: boom · automatic restart is off for this host");
  });
  test("unresponsive says nothing ended and that TeleFlock does not restart it", () => {
    expect(herdrStatus(health({ state: "unresponsive" }), NOW)).toContain("keep running");
  });
});

describe("back up", () => {
  test("says it only for a server that is up again, not the first one ever seen", () => {
    const up = health({ state: "up", since: NOW - 10_000, epoch: 2, downAt: undefined });
    expect(herdrBackUp(up)).toBe("herdr is running again");
    expect(herdrBackUp({ ...up, epoch: 1 })).toBeNull();
    expect(herdrBackUp(health({ state: "down" }))).toBeNull();
  });
  test("a live handoff says the panes stayed", () => {
    expect(herdrBackUp(health({ state: "up", epoch: 3, keptPanes: true, version: "0.9.6" }))).toBe("herdr 0.9.6 is loaded: agents and terminals kept running");
  });
});

describe("agent words", () => {
  test("session strip, header word and composer reason say herdr, not the collab room", () => {
    expect(herdrAgentLine(health())).toBe("herdr stopped at 13:58, so this agent's omp ended. TeleFlock brings it back when herdr runs again.");
    expect(herdrAgentLine(health({ cause: "crashed" }))).toContain("herdr crashed at 13:58");
    expect(herdrAgentWord(health())).toBe("herdr stopped");
    expect(herdrAgentWord(health({ state: "restarting" }))).toBe("herdr restarting");
    expect(herdrAgentWord(health({ state: "unresponsive" }))).toBe("herdr not answering");
    expect(herdrNotRunning("forge", health())).toBe("herdr isn't running on forge");
    expect(herdrNotRunning("forge", health({ state: "unresponsive" }))).toBe("herdr isn't answering on forge");
  });
  test("forced restart names the consequence", () => {
    expect(forceRestartWarning("forge")).toContain("Every agent and terminal of this session ends");
  });
});

describe("isHerdrDownError", () => {
  test("the raw attach error and the stable code", () => {
    const raw = "transport: herdr: failed to connect to server: No such file or directory (os error 2) Is herdr server running? Start it with `herdr server`.";
    expect(isHerdrDownError({ code: "herdr_error", message: raw })).toBe(true);
    expect(isHerdrDownError({ code: "server_not_running", message: "x" })).toBe(true);
    expect(isHerdrDownError({ message: "no herdr server is reachable" })).toBe(true);
    expect(isHerdrDownError({ code: "busy", message: "another client drives it" })).toBe(false);
    expect(isHerdrDownError(undefined)).toBe(false);
  });
});

describe("inWords", () => {
  test("seconds, minutes with seconds, then minutes, then hours", () => {
    expect([inWords(0), inWords(12_000), inWords(61_000), inWords(13 * 60_000), inWords(150 * 60_000), inWords(180 * 60_000)]).toEqual(["0s", "12s", "1m 01s", "13 min", "2h 30m", "3h"]);
  });
});

describe("herdrUpdateNote", () => {
  test("waiting with blockers", () => {
    const n = herdrUpdateNote(update({ blockers: ["2 agents working", "a terminal runs vim"] }), NOW, 20);
    expect(n.text).toBe("herdr 0.9.6 is installed; the running herdr is 0.9.5. Loads by itself after 20 min with nothing running.");
    expect(n.mode).toBe("Agents and terminals keep running.");
    expect(n.wait).toBe("Waiting: 2 agents working, a terminal runs vim");
  });
  test("waiting while idle counts down to dueAt", () => {
    const n = herdrUpdateNote(update({ mode: "restart", idleSince: NOW - 7 * 60_000, dueAt: NOW + 13 * 60_000 }), NOW, 20);
    expect(n.mode).toBe("herdr restarts: running programs end, TeleFlock brings omp agents back.");
    expect(n.wait).toBe("Idle for 7 min · loads in 13 min");
    expect(herdrUpdateNote(update({ idleSince: NOW - 21 * 60_000, dueAt: NOW - 1000 }), NOW, 20).wait).toBe("Idle for 21 min · loads any moment");
  });
  test("manual, running, done, failed", () => {
    expect(herdrUpdateNote(update({ state: "manual" }), NOW, 20).text).toContain("Automatic loading is off: Load now.");
    expect(herdrUpdateNote(update({ state: "running" }), NOW, 20).text).toBe("Loading herdr 0.9.6…");
    expect(herdrUpdateNote(update({ state: "done", at: NOW - 5 * 60_000 }), NOW, 20)).toMatchObject({ tone: "ok", text: "Loaded herdr 0.9.6 5m ago: agents kept running" });
    expect(herdrUpdateNote(update({ state: "done", mode: "restart", at: NOW - 3000 }), NOW, 20).text).toBe("Loaded herdr 0.9.6 3s ago");
    expect(herdrUpdateNote(update({ state: "failed", error: "exec failed" }), NOW, 20)).toMatchObject({ tone: "warn", text: expect.stringContaining("exec failed") });
  });
});

describe("loadNowConfirm", () => {
  test("handoff keeps everything running", () => {
    const c = loadNowConfirm(update(), "forge");
    expect(c.body).toBe("herdr moves every pane to 0.9.6; agents and terminals keep running; open terminals reconnect.");
    expect(c.danger).toBe(false);
  });
  test("restart ends everything on the host", () => {
    const c = loadNowConfirm(update({ mode: "restart" }), "forge");
    expect(c.body).toBe("This herdr is too old to hand its panes over, so it stops: every agent and terminal on forge ends and programs running there stop. TeleFlock brings omp agents back.");
    expect(c.danger).toBe(true);
  });
});

describe("a herdr that keeps dying, a restart-only update, an edited managed config", () => {
  test("held automatic restarts say so and point at Restart herdr", () => {
    const s = herdrStatus(health({ restartHeld: true, attempt: 3, retryAt: undefined }), NOW);
    expect(s).toContain("stopped restarting it by itself");
    expect(s).toContain("Restart herdr starts it");
  });
  test("an update that needs a restart is ready, never scheduled", () => {
    const n = herdrUpdateNote(update({ state: "ready", mode: "restart" }), NOW, 20);
    expect(n.text).toBe("herdr update ready · Restart herdr to load 0.9.6 (the running herdr is 0.9.5).");
    expect(n.mode).toContain("never does that by itself");
    expect(n.wait).toBeUndefined();
  });
  test("a failed restart-only load is retried by the user, not by TeleFlock", () => {
    expect(herdrUpdateNote(update({ state: "failed", mode: "restart", error: "x" }), NOW, 20).text).toContain("Restart herdr to try again.");
    expect(herdrUpdateNote(update({ state: "failed", mode: "handoff", error: "x" }), NOW, 20).text).toContain("next idle window");
  });
  test("the config note only shows once the managed copy was edited", () => {
    expect(herdrConfigNote(health({ configEdited: false }))).toBeNull();
    expect(herdrConfigNote(health({ configEdited: true }))).toContain("herdr-config.toml");
  });
});
