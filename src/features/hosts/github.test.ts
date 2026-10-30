import { describe, expect, test } from "bun:test";
import { apiError } from "@/core";
import { ManualClock } from "@/core/demo/clock";
import { DemoEngine } from "@/core/demo/engine";
import type { AuthFlow, GhAuthStatus } from "@/core/gen";
import { RemoteAuthController, type RemoteAuthDeps } from "@/features/auth";
import { ghLogin, identityError, isUnknownMethod } from "./github";

describe("Host setup's GitHub items", () => {
  test("host errors land under the field they name", () => {
    expect(identityError(apiError("invalid_params", "email: needs an @ (like you@example.com)"))).toEqual({ field: "email", text: "Needs an @ (like you@example.com)" });
    expect(identityError(apiError("invalid_params", "name: can't be empty"))).toEqual({ field: "name", text: "Can't be empty" });
    // Anything else is about the whole form.
    expect(identityError(apiError("git_error", "email: could not lock config file"))).toEqual({ field: null, text: "email: could not lock config file" });
    expect(identityError(apiError("invalid_params", "nothing to save"))).toEqual({ field: null, text: "nothing to save" });
    expect(isUnknownMethod(apiError("unknown_method", "unknown method `git.identity`"))).toBe(true);
    expect(isUnknownMethod(apiError("gh_error", "x"))).toBe(false);
  });

  test("the signed-in login: the first working account, its host when not github.com", () => {
    const status = (accounts: GhAuthStatus["accounts"]): GhAuthStatus => ({ installed: true, accounts, gitCredentialHelper: false, flows: [] });
    const acc = (login: string, host: string, ok: boolean) => ({ host, login, active: true, ok });
    expect(ghLogin(status([acc("broken", "github.com", false), acc("octocat", "github.com", true)]))).toBe("octocat");
    expect(ghLogin(status([acc("me", "ghe.example.com", true)]))).toBe("me (ghe.example.com)");
    expect(ghLogin(status([]))).toBeUndefined();
  });

  test("the sheet's sign-in against the demo host: a device code, then done", async () => {
    const clock = new ManualClock();
    const engine = new DemoEngine({ mode: "backend", clock });
    clock.advance(5000);
    const deps: RemoteAuthDeps = {
      hostId: "forge",
      host: (method, params) => Promise.resolve(engine.callHost("forge", method, params)),
      app: (method, params) => Promise.resolve(engine.callApp(method, params)),
      externalOpen: () => true,
      windowOpen: () => {},
      reach: () => "tunnel",
      autoOpen: false,
      copy: () => Promise.resolve(),
      // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
      sleep: (ms) => new Promise((resolve) => clock.after(ms, resolve)),
    };
    const done: AuthFlow[] = [];
    const ctl = new RemoteAuthController(deps, { start: () => engine.callHost("forge", "gh.authStart", { setupGit: true }) as Promise<AuthFlow>, onDone: (f) => done.push(f) });
    ctl.retain();
    const until = async (pred: () => boolean) => {
      for (let spent = 0; !pred() && spent < 30_000; spent += 100) {
        for (let i = 0; i < 40; i++) await Promise.resolve();
        clock.advance(100);
      }
    };
    await until(() => ctl.getSnapshot().stage === "device");
    const s = ctl.getSnapshot();
    expect([s.stage, s.flow?.url, s.tunnel.state]).toEqual(["device", "https://github.com/login/device", "none"]);
    expect(s.flow?.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    ctl.openUrl();
    await until(() => ctl.getSnapshot().stage === "done");
    expect(ctl.getSnapshot().stage).toBe("done");
    expect(done.map((f) => f.account)).toEqual(["flock-dev"]);
    ctl.release();
  });
});
