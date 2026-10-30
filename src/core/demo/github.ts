/**
 * Demo GitHub CLI sign-in and git identity (`gh.authStatus`, `gh.authStart`, `git.identity`,
 * `git.setIdentity`) with their Host setup items (`sign-in-gh`, `set-git-identity`), answered the
 * way tf-hostd's `ops/gh_auth.rs` answers them.
 *
 * - forge: gh installed but signed in nowhere, git's name and email unset. Its sign-in is a device
 *   code through `./auth`: it finishes ~5 s after the app opened github.com/login/device; after
 *   that git.identity suggests the account's name and no-reply address.
 * - studio-pc: signed in, git's identity set.
 */
import type { AuthFlow, GhAccount, GhAuthStatus, GitIdentity, SetupIssue, SetupStatus } from "../gen";
import { apiError } from "../errors";
import type { DemoAuthFlows } from "./auth";

export const SIGN_IN_GH = "sign-in-gh";
export const SET_GIT_IDENTITY = "set-git-identity";

const GH_VERSION = "2.102.0";
const DEFAULT_HOST = "github.com";
/** The account every demo sign-in signs in as (`gh api user`). */
const USER = { login: "flock-dev", id: 48151623, name: "Flock Dev" };
/** One-time codes the demo hands out, in turn. */
const CODES = ["8F3A-C21D", "2D6B-91E4", "C0FE-7A35"];
const MAX_IDENTITY = 200;

export interface DemoGithubOptions {
  /** Signed in to github.com with git's identity set (studio-pc), else neither (forge). */
  signedIn: boolean;
  home: string;
  auth: DemoAuthFlows;
  /** gh's sign-in or git's identity changed: Host setup's items follow. */
  changed(): void;
}

function account(host: string): GhAccount {
  return { host, login: USER.login, active: true, ok: true, tokenSource: "keyring", scopes: "gist, read:org, repo", gitProtocol: "https" };
}

const SIGN_IN_ISSUE: SetupIssue = {
  id: SIGN_IN_GH,
  severity: "info",
  title: "Sign in to GitHub",
  detail:
    "Pull request status, checks and merges on the board come from the GitHub CLI. It is not signed in on this host. Sign in from Host setup in the app with a one-time code (or run `gh auth login` on the host).",
  fixable: false,
  recommended: true,
};

function identityIssue(name: boolean, email: boolean): SetupIssue {
  const missing = !name && !email ? "user.name and user.email are not set" : !name ? "user.name is not set" : "user.email is not set";
  return {
    id: SET_GIT_IDENTITY,
    severity: "warn",
    title: "Set your git name and email",
    detail: `Commits made on this host need git's user.name and user.email (${missing}). Set them from Host setup in the app (or run \`git config --global user.name "Your Name"\` and \`git config --global user.email you@example.com\` on the host).`,
    fixable: false,
    recommended: true,
  };
}

/** gh's host names (`github.com`, `ghe.example.com[:port]`), lowercased; tf-hostd's `check_host`. */
function checkHost(raw: unknown): string {
  const h = (typeof raw === "string" ? raw : DEFAULT_HOST).trim().toLowerCase();
  const [name = "", port, extra] = h.split(":");
  const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  const ok = name.length > 0 && name.length <= 253 && name.split(".").every((l) => label.test(l)) && extra === undefined && (port === undefined || (/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) < 65536));
  if (!ok) throw apiError("invalid_params", `hostname: \`${h}\` is not a GitHub host name`);
  return h;
}

/** `git.setIdentity`'s checks and messages (tf-hostd `check_identity`). */
function checkIdentity(p: Record<string, unknown>): { name: string; email: string } {
  const field = (key: "name" | "email"): string => {
    const v = (typeof p[key] === "string" ? (p[key] as string) : "").trim();
    const bad = (msg: string) => apiError("invalid_params", `${key}: ${msg}`);
    if (!v) throw bad("can't be empty");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
    if (/[\u0000-\u001f\u007f-\u009f]/.test(v)) throw bad("can't contain line breaks or control characters");
    if ([...v].length > MAX_IDENTITY) throw bad(`use at most ${MAX_IDENTITY} characters`);
    return v;
  };
  const name = field("name");
  const email = field("email");
  if (/\s/.test(email)) throw apiError("invalid_params", "email: can't contain spaces");
  if (!email.includes("@")) throw apiError("invalid_params", "email: needs an @ (like you@example.com)");
  return { name, email };
}

export class DemoGithub {
  private accounts: GhAccount[];
  private helper: boolean;
  private name?: string;
  private email?: string;
  private codes = 0;

  constructor(private readonly o: DemoGithubOptions) {
    this.accounts = o.signedIn ? [account(DEFAULT_HOST)] : [];
    this.helper = o.signedIn;
    if (o.signedIn) {
      this.name = USER.name;
      this.email = "you@flock.dev";
    }
  }

  /** `setup` with this host's GitHub items and fields (any earlier ones replaced), at the end like tf-hostd's. */
  applyTo(setup: SetupStatus): SetupStatus {
    const issues = setup.issues.filter((i) => i.id !== SIGN_IN_GH && i.id !== SET_GIT_IDENTITY);
    const signedIn = this.accounts.some((a) => a.ok);
    if (!signedIn) issues.push({ ...SIGN_IN_ISSUE });
    const identity = !!this.name && !!this.email;
    if (!identity) issues.push(identityIssue(!!this.name, !!this.email));
    return { ...setup, issues, ghSignedIn: signedIn, gitIdentity: identity };
  }

  call(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "gh.authStatus":
        return this.status();
      case "gh.authStart":
        return this.start(p);
      case "git.identity":
        return this.identity();
      case "git.setIdentity": {
        const { name, email } = checkIdentity(p);
        this.name = name;
        this.email = email;
        this.o.changed();
        return this.identity();
      }
      default:
        throw apiError("unknown_method", `Unknown method ${method}`);
    }
  }

  private status(): GhAuthStatus {
    return {
      installed: true,
      version: GH_VERSION,
      accounts: this.accounts.map((a) => ({ ...a })),
      gitCredentialHelper: this.helper,
      flows: this.o.auth.list().filter((f) => f.kind === "gh"),
    };
  }

  private start(p: Record<string, unknown>): AuthFlow {
    const host = checkHost(p.hostname);
    const setupGit = p.setupGit !== false;
    // One sign-in per GitHub host: asking again follows the running one.
    const running = this.o.auth.list().find((f) => f.kind === "gh" && f.subject === host && (f.state === "starting" || f.state === "waiting"));
    if (running) return running;
    const code = CODES[this.codes++ % CODES.length] ?? "8F3A-C21D";
    const done = `Signed in to ${host} as ${USER.login}.${setupGit ? ` git uses it for HTTPS to ${host}.` : ""}`;
    return this.o.auth.start({
      kind: "gh",
      title: `GitHub (${host})`,
      subject: host,
      method: "device",
      url: `https://${host}/login/device`,
      userCode: code,
      instructions: `Enter the code ${code} on that page and authorize GitHub CLI.`,
      account: USER.login,
      starting: "Starting gh…",
      doneMessage: done,
      onDone: () => {
        this.accounts = [account(host), ...this.accounts.filter((a) => a.host !== host).map((a) => ({ ...a, active: a.host !== host && a.active }))];
        if (setupGit) this.helper = true;
        this.o.changed();
      },
    });
  }

  private identity(): GitIdentity {
    const suggest = this.accounts.find((a) => a.ok);
    return {
      name: this.name,
      email: this.email,
      file: `${this.o.home}/.gitconfig`,
      suggestedName: suggest ? USER.name : undefined,
      suggestedEmail: suggest ? `${USER.id}+${USER.login}@users.noreply.${suggest.host}` : undefined,
    };
  }
}
