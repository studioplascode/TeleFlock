import { describe, expect, test } from "bun:test";
import type { AuthFlow, GhAuthStatus, GitIdentity, SetupStatus } from "../gen";
import { reduceEvents } from "../store/reduce";
import { type CoreEvent, type CoreState, initialCoreState } from "../store/state";
import { DemoAuthFlows } from "./auth";
import { ManualClock } from "./clock";
import { DemoEngine } from "./engine";
import { DemoGithub, SET_GIT_IDENTITY, SIGN_IN_GH } from "./github";

/** Demo engine on a manual clock, `forge` online, its published state followed like the app's. */
function rig() {
  const clock = new ManualClock();
  const engine = new DemoEngine({ mode: "backend", clock });
  let state: CoreState = initialCoreState("demo");
  engine.subscribe((e) => {
    state = reduceEvents(state, [e as CoreEvent]).state;
  });
  clock.advance(5000);
  const call = async <T = unknown>(hostId: string | null, method: string, params: unknown = {}): Promise<T> => {
    const p = hostId === null ? engine.callApp(method, params) : engine.callHost(hostId, method, params);
    clock.advance(400);
    return (await p) as T;
  };
  /** The flow once `pred` holds, long-polled the way the app does. */
  const until = async (flowId: string, pred: (f: AuthFlow) => boolean, budgetMs = 30_000): Promise<AuthFlow> => {
    let f = await call<AuthFlow>("forge", "auth.wait", { flowId });
    for (let spent = 0; !pred(f) && spent < budgetMs; spent += 1000) {
      const next = engine.callHost("forge", "auth.wait", { flowId, afterRev: f.rev, waitMs: 1000 });
      clock.advance(1000);
      f = (await next) as AuthFlow;
    }
    return f;
  };
  const published = (): SetupStatus | undefined => state.hosts.forge?.state.info.setup;
  return { clock, call, until, published };
}

const ids = (s: SetupStatus) => s.issues.map((i) => i.id);

describe("demo GitHub sign-in and git identity", () => {
  test("forge: gh signs in with a device code, then Host setup and the identity suggestions follow", async () => {
    const r = rig();
    const before = await r.call<SetupStatus>("forge", "host.setup");
    expect([before.ghSignedIn, before.gitIdentity]).toEqual([false, false]);
    expect(ids(before).slice(-2)).toEqual([SIGN_IN_GH, SET_GIT_IDENTITY]);
    const signIn = before.issues.find((i) => i.id === SIGN_IN_GH);
    expect([signIn?.severity, signIn?.fixable, signIn?.recommended]).toEqual(["info", false, true]);
    expect(signIn?.detail).toContain("`gh auth login`");
    expect(ids(before)).not.toContain("install-gh");

    const status = await r.call<GhAuthStatus>("forge", "gh.authStatus");
    expect([status.installed, status.version, status.accounts, status.gitCredentialHelper]).toEqual([true, "2.102.0", [], false]);
    const noSuggestion = await r.call<GitIdentity>("forge", "git.identity");
    expect([noSuggestion.name, noSuggestion.suggestedName, noSuggestion.file]).toEqual([undefined, undefined, "/home/demo/.gitconfig"]);

    const started = await r.call<AuthFlow>("forge", "gh.authStart", { setupGit: true });
    expect([started.kind, started.title, started.subject, started.state, started.message]).toEqual(["gh", "GitHub (github.com)", "github.com", "starting", "Starting gh…"]);
    const waiting = await r.until(started.flowId, (f) => f.state === "waiting");
    expect(waiting.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect([waiting.url, waiting.paste, waiting.callbackPort]).toEqual(["https://github.com/login/device", "none", undefined]);
    // One sign-in per GitHub host: asking again follows it.
    expect((await r.call<AuthFlow>("forge", "gh.authStart", {})).flowId).toBe(started.flowId);
    expect((await r.call<GhAuthStatus>("forge", "gh.authStatus")).flows.map((f) => f.flowId)).toEqual([started.flowId]);

    await r.call(null, "app.openExternal", { url: waiting.url });
    const done = await r.until(started.flowId, (f) => f.state === "done");
    expect([done.account, done.message]).toEqual(["flock-dev", "Signed in to github.com as flock-dev. git uses it for HTTPS to github.com."]);

    const after = await r.call<SetupStatus>("forge", "host.setup");
    expect(after.ghSignedIn).toBe(true);
    expect(ids(after)).not.toContain(SIGN_IN_GH);
    // Every app connected to forge sees it.
    expect(r.published()?.ghSignedIn).toBe(true);
    const signedIn = await r.call<GhAuthStatus>("forge", "gh.authStatus");
    expect([signedIn.accounts.map((a) => [a.login, a.ok, a.active]), signedIn.gitCredentialHelper]).toEqual([[["flock-dev", true, true]], true]);
    const suggested = await r.call<GitIdentity>("forge", "git.identity");
    expect([suggested.suggestedName, suggested.suggestedEmail]).toEqual(["Flock Dev", "48151623+flock-dev@users.noreply.github.com"]);
  });

  test("git.setIdentity checks each field like tf-hostd and clears the setup item", async () => {
    const r = rig();
    const refused = async (name: string, email: string) => {
      try {
        await r.call("forge", "git.setIdentity", { name, email });
      } catch (e) {
        return e as { code: string; message: string };
      }
      throw new Error("accepted");
    };
    expect(await refused(" ", "a@b.c")).toMatchObject({ code: "invalid_params", message: "name: can't be empty" });
    expect(await refused("Ada\nLovelace", "a@b.c")).toMatchObject({ message: "name: can't contain line breaks or control characters" });
    expect(await refused("x".repeat(201), "a@b.c")).toMatchObject({ message: "name: use at most 200 characters" });
    expect(await refused("Ada", "ada example.com")).toMatchObject({ message: "email: can't contain spaces" });
    expect(await refused("Ada", "ada.example.com")).toMatchObject({ message: "email: needs an @ (like you@example.com)" });
    expect((await r.call<SetupStatus>("forge", "host.setup")).gitIdentity).toBe(false);

    const saved = await r.call<GitIdentity>("forge", "git.setIdentity", { name: "  Ada Lovelace ", email: "ada@example.com" });
    expect([saved.name, saved.email]).toEqual(["Ada Lovelace", "ada@example.com"]);
    const after = await r.call<SetupStatus>("forge", "host.setup");
    expect(after.gitIdentity).toBe(true);
    expect(ids(after)).not.toContain(SET_GIT_IDENTITY);
    expect(r.published()?.gitIdentity).toBe(true);
  });

  test("a cancelled sign-in changes nothing; an Enterprise host gets its own device page", async () => {
    const r = rig();
    const started = await r.call<AuthFlow>("forge", "gh.authStart", { hostname: "GHE.Example.com", setupGit: false });
    expect([started.title, started.subject]).toEqual(["GitHub (ghe.example.com)", "ghe.example.com"]);
    const waiting = await r.until(started.flowId, (f) => f.state === "waiting");
    expect(waiting.url).toBe("https://ghe.example.com/login/device");
    await r.call("forge", "auth.cancel", { flowId: started.flowId });
    expect((await r.call<AuthFlow>("forge", "auth.wait", { flowId: started.flowId })).state).toBe("cancelled");
    expect((await r.call<SetupStatus>("forge", "host.setup")).ghSignedIn).toBe(false);
    await expect(r.call("forge", "gh.authStart", { hostname: "not a host" })).rejects.toMatchObject({ code: "invalid_params", message: "hostname: `not a host` is not a GitHub host name" });
  });

  test("studio-pc is signed in with its identity set", () => {
    const clock = new ManualClock();
    let changed = 0;
    const gh = new DemoGithub({ signedIn: true, home: "/home/demo", auth: new DemoAuthFlows(clock, () => false), changed: () => (changed += 1) });
    const setup = gh.applyTo({ herdrIntegration: true, globalSharing: true, globalBridge: true, relay: true, issues: [{ id: SIGN_IN_GH, severity: "info", title: "", detail: "", fixable: false, recommended: true }] });
    expect([setup.issues, setup.ghSignedIn, setup.gitIdentity]).toEqual([[], true, true]);
    const status = gh.call("gh.authStatus", {}) as GhAuthStatus;
    expect(status.accounts.map((a) => a.login)).toEqual(["flock-dev"]);
    const id = gh.call("git.identity", {}) as GitIdentity;
    expect([id.name, id.email]).toEqual(["Flock Dev", "you@flock.dev"]);
    expect(changed).toBe(0);
  });
});
