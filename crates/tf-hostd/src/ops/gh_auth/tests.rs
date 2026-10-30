use super::*;

/// `gh auth login --web` on stderr without a terminal (gh 2.102.0, no clipboard utility).
const LOGIN_NO_TTY: &str = "\n! Failed to copy one-time code to clipboard\n  No clipboard utilities available. Please install xsel, xclip, wl-clipboard or Termux:API add-on for termux-clipboard-get/set.\n! First copy your one-time code: E047-C611\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
/// What follows once GitHub approved the device.
const LOGIN_DONE: &str = "✓ Authentication complete.\n- gh config set -h github.com git_protocol https\n✓ Configured git protocol\n! Authentication credentials saved in plain text\n✓ Logged in as octocat\n";
/// `gh auth status --json hosts` with a bad `GH_TOKEN` (gh 2.102.0).
const STATUS_BAD_TOKEN: &str = r#"{"hosts":{"github.com":[{"state":"error","error":"non-200 OK status code: 401 Unauthorized body: \"{\\r\\n  \\\"message\\\": \\\"Bad credentials\\\",\\r\\n  \\\"documentation_url\\\": \\\"https://docs.github.com/rest\\\",\\r\\n  \\\"status\\\": \\\"401\\\"\\r\\n}\"","active":true,"host":"github.com","login":"","tokenSource":"GH_TOKEN","gitProtocol":"https"}]}}"#;
const STATUS_SIGNED_IN: &str = r#"{"hosts":{"ghe.example.com":[{"state":"timeout","active":true,"host":"ghe.example.com","login":"me","tokenSource":"keyring","gitProtocol":"https"}],"github.com":[{"state":"success","active":false,"host":"github.com","login":"old-me","tokenSource":"keyring","scopes":"gist, read:org, repo","gitProtocol":"ssh"},{"state":"success","active":true,"host":"github.com","login":"octocat","tokenSource":"/home/u/.config/gh/hosts.yml","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}"#;

fn events(p: &mut LoginParser, s: &str) -> Vec<LoginEvent> {
    p.feed(s.as_bytes())
}

#[test]
fn reads_gh_versions() {
    assert_eq!(parse_version("gh version 2.102.0 (2026-09-30)").as_deref(), Some("2.102.0"));
    assert_eq!(parse_version("gh version 2.4.0+dfsg1-2 (Ubuntu 2.4.0+dfsg1-2)").as_deref(), Some("2.4.0+dfsg1-2"));
    assert_eq!(parse_version("  "), None);
    assert_eq!(version_at_least("2.102.0", STATUS_JSON_SINCE), Some(true));
    assert_eq!(version_at_least("2.81.0", STATUS_JSON_SINCE), Some(true));
    assert_eq!(version_at_least("2.80.1", STATUS_JSON_SINCE), Some(false));
    assert_eq!(version_at_least("2.4.0+dfsg1-2", CLIPBOARD_FLAG_SINCE), Some(false));
    assert_eq!(version_at_least("v2.79", CLIPBOARD_FLAG_SINCE), Some(true));
    assert_eq!(version_at_least("dev", STATUS_JSON_SINCE), None);
}

#[test]
fn parses_gh_auth_status_json() {
    let bad = parse_status_json(STATUS_BAD_TOKEN).unwrap();
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].standing, Standing::Failed);
    assert_eq!(bad[0].account.error.as_deref(), Some("GitHub no longer accepts its token"));
    assert_eq!((bad[0].account.login.as_str(), bad[0].account.token_source.as_deref()), ("", Some("GH_TOKEN")));

    let all = parse_status_json(STATUS_SIGNED_IN).unwrap();
    // Active accounts first, github.com's before others.
    let order: Vec<(&str, &str, bool)> = all.iter().map(|e| (e.account.host.as_str(), e.account.login.as_str(), e.account.ok)).collect();
    assert_eq!(order, [("github.com", "octocat", true), ("ghe.example.com", "me", false), ("github.com", "old-me", true)]);
    assert_eq!(all[0].account.scopes.as_deref(), Some("gist, read:org, repo, workflow"));
    assert_eq!(all[0].account.git_protocol.as_deref(), Some("https"));
    assert_eq!(all[1].standing, Standing::Unchecked);
    assert_eq!(all[1].account.error.as_deref(), Some("GitHub didn't answer in time"));

    assert_eq!(parse_status_json(r#"{"hosts":{}}"#), Some(vec![]));
    assert_eq!(parse_status_json("unknown flag: --json"), None);
}

#[test]
fn parses_gh_auth_status_text() {
    // gh 2.40 – 2.80.
    let text = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n  - Token scopes: 'gist', 'read:org', 'repo'\n\n  X Failed to log in to github.com account old-me (/home/u/.config/gh/hosts.yml)\n  - Active account: false\n  - The token in /home/u/.config/gh/hosts.yml is invalid.\n  - To re-authenticate, run: gh auth login -h github.com\n";
    let e = parse_status_text(text);
    assert_eq!(e.len(), 2);
    assert_eq!((e[0].account.login.as_str(), e[0].account.active, e[0].standing), ("octocat", true, Standing::Ok));
    assert_eq!(e[0].account.scopes.as_deref(), Some("gist, read:org, repo"));
    assert_eq!(e[0].account.token_source.as_deref(), Some("keyring"));
    assert_eq!((e[1].account.login.as_str(), e[1].account.active, e[1].standing), ("old-me", false, Standing::Failed));
    assert_eq!(e[1].account.error.as_deref(), Some("The token in /home/u/.config/gh/hosts.yml is invalid"));

    // Before gh 2.40: one account per host, no "Active account" lines.
    let old = "github.com\n  ✓ Logged in to github.com as hubot (/home/u/.config/gh/hosts.yml)\n  ✓ Git operations for github.com configured to use ssh protocol.\n  ✓ Token: *******************\nghe.example.com\n  X ghe.example.com: authentication failed\n  - The ghe.example.com token in /home/u/.config/gh/hosts.yml is no longer valid.\n";
    let e = parse_status_text(old);
    assert_eq!(e.len(), 2);
    assert_eq!((e[0].account.login.as_str(), e[0].account.active, e[0].account.git_protocol.as_deref()), ("hubot", true, Some("ssh")));
    assert_eq!((e[1].account.host.as_str(), e[1].standing), ("ghe.example.com", Standing::Failed));
    assert_eq!(e[1].account.error.as_deref(), Some("The ghe.example.com token in /home/u/.config/gh/hosts.yml is no longer valid"));

    assert!(parse_status_text("You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n").is_empty());
    let token = parse_status_text("github.com\n  X Timeout trying to log in to github.com using token (GH_TOKEN)\n  - Active account: true\n");
    assert_eq!((token[0].account.login.as_str(), token[0].standing, token[0].account.token_source.as_deref()), ("", Standing::Unchecked, Some("GH_TOKEN")));
}

#[test]
fn parses_gh_auth_login_output() {
    let mut p = LoginParser::new();
    assert_eq!(
        events(&mut p, LOGIN_NO_TTY),
        vec![LoginEvent::Code("E047-C611".into()), LoginEvent::Url("https://github.com/login/device".into())],
        "the clipboard failure and its indented reason are not shown"
    );
    assert_eq!(
        events(&mut p, LOGIN_DONE),
        vec![LoginEvent::Approved, LoginEvent::PlainText, LoginEvent::LoggedIn("octocat".into())]
    );
    // A gh that could copy the code says so instead.
    assert_eq!(events(&mut p, "! One-time code (WDJB-MJHT) copied to clipboard\n"), vec![LoginEvent::Code("WDJB-MJHT".into())]);
    // Lines may arrive in pieces.
    assert!(events(&mut p, "! First copy your one-").is_empty());
    assert_eq!(events(&mut p, "time code: 1A2B-3C4D\n"), vec![LoginEvent::Code("1A2B-3C4D".into())]);
    // Whatever else gh says is the reason when it fails.
    assert_eq!(
        events(&mut p, "failed to authenticate via web browser: access_denied\n"),
        vec![LoginEvent::Other("failed to authenticate via web browser: access_denied".into())]
    );
}

#[test]
fn answers_the_interactive_wording() {
    // gh that thinks it can prompt asks for Enter on an unterminated line.
    let mut p = LoginParser::new();
    assert_eq!(events(&mut p, "! First copy your one-time code: 0145-D77D\n"), vec![LoginEvent::Code("0145-D77D".into())]);
    assert!(events(&mut p, "Press Enter to open https://github.com/login/device in your bro").is_empty(), "half a prompt waits");
    assert_eq!(events(&mut p, "wser... "), vec![LoginEvent::Url("https://github.com/login/device".into()), LoginEvent::Enter]);
    // What gh prints after the answer starts a line of its own.
    assert_eq!(events(&mut p, "✓ Authentication complete.\n"), vec![LoginEvent::Approved]);

    // gh before 2.40 names the host instead of the page, and asks again after the approval.
    let mut old = LoginParser::new();
    assert_eq!(
        events(&mut old, "- Press Enter to open github.com in your browser... "),
        vec![LoginEvent::Url("https://github.com/login/device".into()), LoginEvent::Enter]
    );
    assert_eq!(events(&mut old, "✓ Authentication complete. Press Enter to continue...\n"), vec![LoginEvent::Approved, LoginEvent::Enter]);
    assert_eq!(old.finish(), vec![]);
}

#[test]
fn explains_failures() {
    let said: VecDeque<String> = ["first", "failed to authenticate via web browser: expired_token"].map(String::from).into();
    assert_eq!(failure_reason(&said).as_deref(), Some("failed to authenticate via web browser: expired_token"));
    let env: VecDeque<String> = ["The value of the GH_TOKEN environment variable is being used for authentication.", "To have GitHub CLI store credentials instead, first clear the value from the environment."]
        .map(String::from)
        .into();
    assert_eq!(
        failure_reason(&env).as_deref(),
        Some("The value of the GH_TOKEN environment variable is being used for authentication. Remove it from tf-hostd's environment to store a sign-in.")
    );
    assert_eq!(failure_reason(&VecDeque::new()), None);
    assert_eq!(done_message("github.com", Some("octocat"), true, Some(Ok(()))), "Signed in to github.com as octocat. gh keeps the token in its config folder (this host has no system keyring). git uses it for HTTPS to github.com.");
    assert_eq!(done_message("github.com", None, false, Some(Err("no git".into()))), "Signed in to github.com. Couldn't set git up to use it: no git");
}

#[test]
fn checks_host_names() {
    assert_eq!(check_host("GitHub.com").unwrap(), "github.com");
    assert_eq!(check_host("ghe.example.com:8443").unwrap(), "ghe.example.com:8443");
    for bad in ["", "-x.com", "a..b", "a b", "x.com:0", "x.com:http", "a/b"] {
        let e = check_host(bad).unwrap_err();
        assert!(e.code == "invalid_params" && e.message.starts_with("hostname: "), "{bad}: {e:?}");
    }
}

#[test]
fn validates_identities() {
    let p = |name: &str, email: &str| check_identity(&GitIdentityParams { name: name.into(), email: email.into() });
    assert_eq!(p("  Ada Lovelace ", " ada@example.com ").unwrap(), ("Ada Lovelace".to_string(), "ada@example.com".to_string()));
    let err = |name: &str, email: &str| p(name, email).unwrap_err().message;
    assert_eq!(err(" ", "a@b.c"), "name: can't be empty");
    assert_eq!(err("Ada\nLovelace", "a@b.c"), "name: can't contain line breaks or control characters");
    assert_eq!(err(&"x".repeat(201), "a@b.c"), "name: use at most 200 characters");
    assert!(p(&"é".repeat(200), "a@b.c").is_ok(), "characters, not bytes");
    assert_eq!(err("Ada", ""), "email: can't be empty");
    assert_eq!(err("Ada", "ada example.com"), "email: can't contain spaces");
    assert_eq!(err("Ada", "ada.example.com"), "email: needs an @ (like you@example.com)");
    assert_eq!(err("Ada", "a@b\u{7}"), "email: can't contain line breaks or control characters");
    assert_eq!(p("", "x").unwrap_err().code, "invalid_params");
    assert!(p("-x --global", "a@b").is_ok(), "git takes values after the key literally");
}

#[test]
fn reads_identities_and_profiles() {
    assert_eq!(parse_identity(b"user.name\nA B\0user.email\na@b.c\0"), (Some("A B".into()), Some("a@b.c".into())));
    // The last value wins; an empty one is unset.
    assert_eq!(parse_identity(b"user.name\nOld\0user.name\nNew\0user.email\n\0"), (Some("New".into()), None));
    assert_eq!(parse_identity(b""), (None, None));

    let user = parse_user(r#"{"login":"octocat","id":583231,"name":null,"email":null,"type":"User"}"#).unwrap();
    assert_eq!(suggestion("github.com", &user), ("octocat".into(), "583231+octocat@users.noreply.github.com".into()));
    let named = parse_user(r#"{"login":"octocat","id":1,"name":"The Octocat","email":"octo@example.com"}"#).unwrap();
    assert_eq!(suggestion("github.com", &named), ("The Octocat".into(), "octo@example.com".into()));
    assert_eq!(parse_user("{}"), None);
}

#[test]
fn finds_git_global_config_file() {
    let td = tempfile::tempdir().unwrap();
    let home = td.path().to_string_lossy().into_owned();
    fn lookup(vars: Vec<(&'static str, String)>) -> impl Fn(&str) -> Option<OsString> {
        move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v))
    }
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    assert_eq!(global_file(lookup(vec![("GIT_CONFIG_GLOBAL", "/x/cfg".into()), (home_var, home.clone())])), PathBuf::from("/x/cfg"));
    assert_eq!(global_file(lookup(vec![(home_var, home.clone())])), td.path().join(".gitconfig"));
    // Only the XDG file exists: git writes there.
    let xdg = td.path().join(".config/git/config");
    std::fs::create_dir_all(xdg.parent().unwrap()).unwrap();
    std::fs::write(&xdg, "").unwrap();
    assert_eq!(global_file(lookup(vec![(home_var, home.clone())])), xdg);
    std::fs::write(td.path().join(".gitconfig"), "").unwrap();
    assert_eq!(global_file(lookup(vec![(home_var, home.clone())])), td.path().join(".gitconfig"));
}

fn entry(login: &str, standing: Standing) -> Entry {
    Entry {
        account: GhAccount {
            host: "github.com".into(),
            login: login.into(),
            active: true,
            ok: standing == Standing::Ok,
            error: (standing == Standing::Failed).then(|| "GitHub no longer accepts its token".into()),
            token_source: Some("keyring".into()),
            scopes: None,
            git_protocol: None,
        },
        standing,
    }
}

#[test]
fn setup_items() {
    fn ids(p: &SetupPart) -> Vec<&str> {
        p.issues.iter().map(|i| i.id.as_str()).collect()
    }
    // Neither gh nor git: nothing to say (Host setup offers their installs).
    let none = setup_from(None, None, false);
    assert_eq!((ids(&none), none.gh_signed_in, none.git_identity), (vec![], None, None));
    // gh signed in nowhere, git without an email.
    let out = setup_from(Some(Ok(&[])), Some((true, false)), false);
    assert_eq!(ids(&out), [ISSUE_SIGN_IN, ISSUE_GIT_IDENTITY]);
    assert_eq!((out.gh_signed_in, out.git_identity), (Some(false), Some(false)));
    let sign_in = &out.issues[0];
    assert_eq!((sign_in.severity, sign_in.fixable, sign_in.recommended), (Severity::Info, false, true));
    assert!(sign_in.detail.contains("It is not signed in on this host.") && sign_in.detail.contains("`gh auth login`"), "{}", sign_in.detail);
    let identity = &out.issues[1];
    assert_eq!((identity.severity, identity.fixable, identity.recommended), (Severity::Warn, false, true));
    assert!(identity.detail.contains("(user.email is not set)") && identity.detail.contains("`git config --global user.name"), "{}", identity.detail);
    // A token that stopped working is named.
    let failed = [entry("octocat", Standing::Failed)];
    let out = setup_from(Some(Ok(&failed)), Some((true, true)), false);
    assert_eq!(ids(&out), [ISSUE_SIGN_IN]);
    assert!(out.issues[0].detail.contains("Its sign-in as octocat on github.com no longer works (GitHub no longer accepts its token)."), "{}", out.issues[0].detail);
    // GH_TOKEN in the daemon's environment: signing in can't help.
    assert_eq!(ids(&setup_from(Some(Ok(&failed)), Some((true, true)), true)), Vec::<&str>::new());
    // A sign-in gh couldn't check (offline) counts.
    let unchecked = [entry("octocat", Standing::Unchecked), entry("old", Standing::Failed)];
    let out = setup_from(Some(Ok(&unchecked)), Some((true, true)), false);
    assert_eq!((ids(&out), out.gh_signed_in, out.git_identity), (vec![], Some(true), Some(true)));
    // gh couldn't tell: no verdict, no issue.
    let out = setup_from(Some(Err(())), None, false);
    assert_eq!((ids(&out), out.gh_signed_in), (vec![], None));
}

// ── against a scripted gh (a shell script: unix only) ──

/// Tests that use the status cache or sign in (which resets it) run one at a time.
#[cfg(unix)]
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A stand-in `gh`. `--version` prints `version`; `auth status` prints `status.json` (`--json`) or
/// `status.txt` from its folder (`status-signed.json` once `hosts.yml` exists), sleeping
/// `status.sleep` seconds first and counting its runs in `status.runs`; `status.nojson` makes it
/// refuse `--json` like gh before 2.81. `auth login` runs `login.sh`; `auth setup-git` records its
/// arguments.
#[cfg(unix)]
fn fake_gh(dir: &Path, version: &str, login: &str) -> PathBuf {
    let script = r#"#!/bin/sh
DIR=$(dirname "$0")
if [ "$1" = --version ]; then
  echo "gh version @VERSION@ (2026-09-30)"
  echo "https://github.com/cli/cli/releases/tag/v@VERSION@"
  exit 0
fi
[ "$1" = auth ] || exit 64
case "$2" in
status)
  echo run >> "$DIR/status.runs"
  [ -f "$DIR/status.sleep" ] && sleep "$(cat "$DIR/status.sleep")"
  if [ "$3" = --json ]; then
    if [ -f "$DIR/status.nojson" ]; then echo 'unknown flag: --json' >&2; echo 'Usage:  gh auth status [flags]' >&2; exit 1; fi
    if [ -f "$DIR/hosts.yml" ]; then cat "$DIR/status-signed.json"; else cat "$DIR/status.json"; fi
  else
    cat "$DIR/status.txt"
  fi
  exit 0 ;;
login)
  printf '%s\n' "$@" > "$DIR/login.args"
  printf '%s|%s|%s|%s\n' "$NO_COLOR" "$GH_PROMPT_DISABLED" "$GH_NO_UPDATE_NOTIFIER" "$GH_BROWSER" > "$DIR/login.env"
  . "$DIR/login.sh" ;;
setup-git)
  printf '%s\n' "$@" > "$DIR/setup-git.args"
  exit 0 ;;
esac
exit 64
"#
    .replace("@VERSION@", version);
    let bin = dir.join("gh");
    crate::test_exe::write_exe(&bin, script);
    std::fs::write(dir.join("login.sh"), login).unwrap();
    bin
}

/// The device code and page, then waits for the test to `approve` (or `deny`) it.
#[cfg(unix)]
const LOGIN_SCRIPT: &str = r#"echo $$ > "$DIR/login.pid"
printf '\n! Failed to copy one-time code to clipboard\n  No clipboard utilities available.\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n' >&2
while [ ! -f "$DIR/approve" ]; do sleep 0.05; done
if [ "$(cat "$DIR/approve")" = deny ]; then
  echo 'failed to authenticate via web browser: access_denied' >&2
  exit 1
fi
printf '✓ Authentication complete.\n- gh config set -h %s git_protocol https\n✓ Configured git protocol\n! Authentication credentials saved in plain text\n✓ Logged in as octocat\n' "$4" >&2
: > "$DIR/hosts.yml"
exit 0
"#;

#[cfg(unix)]
fn run_of(bin: &Path, host: &str, setup_git: bool, shim: Option<PathBuf>) -> Run {
    Run { bin: bin.to_path_buf(), host: host.into(), setup_git, shim, env: Vec::new(), ctx: None }
}

#[cfg(unix)]
async fn until(flow_id: &str, pred: impl Fn(&AuthFlow) -> bool) -> AuthFlow {
    let mut rev = None;
    for _ in 0..100 {
        let f = authflow::wait(flow_id, rev, Some(200)).await.unwrap();
        if pred(&f) {
            return f;
        }
        rev = Some(f.rev);
    }
    panic!("flow never got there: {:?}", authflow::wait(flow_id, None, None).await.unwrap());
}

/// The process exists and is not a zombie (a killed child nobody reaped yet is gone too).
#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |s| s.rsplit(')').next().and_then(|r| r.split_whitespace().next()) != Some("Z"))
}

#[cfg(unix)]
fn pid_in(path: &Path) -> i32 {
    std::fs::read_to_string(path).unwrap().trim().parse().unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn sign_in_with_a_device_code() {
    let _serial = SERIAL.lock().await;
    let td = tempfile::tempdir().unwrap();
    let bin = fake_gh(td.path(), "2.102.0", LOGIN_SCRIPT);
    std::fs::write(td.path().join("status.json"), r#"{"hosts":{}}"#).unwrap();
    std::fs::write(td.path().join("status-signed.json"), STATUS_SIGNED_IN).unwrap();
    let shim = crate::ops::accounts::no_browser_dir(td.path());
    let flow = start_sign_in(run_of(&bin, "fake-done.test", true, shim.clone()));
    assert_eq!((flow.kind.as_str(), flow.title.as_str(), flow.subject.as_deref()), (KIND, "GitHub (fake-done.test)", Some("fake-done.test")));
    assert_eq!(flow.message.as_deref(), Some("Starting gh…"));
    let id = flow.flow_id.clone();
    let waiting = until(&id, |f| f.user_code.is_some() && f.url.is_some()).await;
    assert_eq!(waiting.state, AuthFlowState::Waiting);
    assert_eq!(waiting.user_code.as_deref(), Some("AB12-CD34"));
    assert_eq!(waiting.url.as_deref(), Some("https://github.com/login/device"));
    assert_eq!((waiting.callback_port, waiting.paste), (None, AuthPaste::None), "nothing comes back to the host");
    assert_eq!(waiting.message.as_deref(), Some("Waiting for you to enter the code…"));
    // The same host again: the running sign-in, not a second gh.
    assert_eq!(start_sign_in(run_of(&bin, "fake-done.test", true, None)).flow_id, id);
    // A device code has nothing to paste.
    assert_eq!(authflow::submit(&id, "AB12-CD34").await.unwrap_err().code, "invalid_params");
    let args = std::fs::read_to_string(td.path().join("login.args")).unwrap();
    assert_eq!(args.lines().collect::<Vec<_>>(), ["auth", "login", "--hostname", "fake-done.test", "--git-protocol", "https", "--web", "--clipboard=false"]);
    let env = std::fs::read_to_string(td.path().join("login.env")).unwrap();
    assert_eq!(env.trim(), format!("1|1|1|{}", shim.unwrap().join("xdg-open").display()));

    std::fs::write(td.path().join("approve"), "ok").unwrap();
    let done = until(&id, |f| f.state.is_final()).await;
    assert_eq!(done.state, AuthFlowState::Done, "{done:?}");
    assert_eq!(done.account.as_deref(), Some("octocat"));
    assert_eq!(done.user_code, None);
    assert_eq!(
        done.message.as_deref(),
        Some("Signed in to fake-done.test as octocat. gh keeps the token in its config folder (this host has no system keyring). git uses it for HTTPS to fake-done.test.")
    );
    let setup_git = std::fs::read_to_string(td.path().join("setup-git.args")).unwrap();
    assert_eq!(setup_git.lines().collect::<Vec<_>>(), ["auth", "setup-git", "--hostname", "fake-done.test"]);
    // `done` comes with the status looked up again: the checklist reads it right then.
    let p = probe(&bin, Some(Duration::ZERO), None).await.expect("a fresh status is cached");
    assert_eq!(p.signed_in(), Some(true));
    let status = p.status(Vec::new()).unwrap();
    assert_eq!((status.installed, status.version.as_deref(), status.accounts[0].login.as_str()), (true, Some("2.102.0"), "octocat"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_sign_in_says_why() {
    let _serial = SERIAL.lock().await;
    let td = tempfile::tempdir().unwrap();
    let bin = fake_gh(td.path(), "2.102.0", LOGIN_SCRIPT);
    let flow = start_sign_in(run_of(&bin, "fake-fail.test", true, None));
    until(&flow.flow_id, |f| f.user_code.is_some()).await;
    std::fs::write(td.path().join("approve"), "deny").unwrap();
    let failed = until(&flow.flow_id, |f| f.state.is_final()).await;
    assert_eq!(failed.state, AuthFlowState::Failed);
    assert_eq!(failed.message.as_deref(), Some("failed to authenticate via web browser: access_denied"));
    assert!(!td.path().join("setup-git.args").exists(), "git is left alone");
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_kills_gh_and_what_it_started() {
    let _serial = SERIAL.lock().await;
    let td = tempfile::tempdir().unwrap();
    let login = format!("sleep 30 &\necho $! > \"$DIR/child.pid\"\n{LOGIN_SCRIPT}");
    let bin = fake_gh(td.path(), "2.102.0", &login);
    let flow = start_sign_in(run_of(&bin, "fake-cancel.test", true, None));
    until(&flow.flow_id, |f| f.user_code.is_some()).await;
    let (gh, child) = (pid_in(&td.path().join("login.pid")), pid_in(&td.path().join("child.pid")));
    assert!(alive(gh) && alive(child));
    authflow::cancel(&flow.flow_id).unwrap();
    let mut gone = false;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if !alive(gh) && !alive(child) {
            gone = true;
            break;
        }
    }
    assert!(gone, "gh and its background child were killed");
    assert_eq!(authflow::wait(&flow.flow_id, None, None).await.unwrap().state, AuthFlowState::Cancelled);
    assert!(!td.path().join("hosts.yml").exists() && !td.path().join("setup-git.args").exists(), "nothing else ran");
}

#[cfg(unix)]
#[tokio::test]
async fn an_interactive_gh_gets_its_enter() {
    let _serial = SERIAL.lock().await;
    let td = tempfile::tempdir().unwrap();
    let login = r#"printf '! First copy your one-time code: EF56-GH78\n' >&2
printf 'Press Enter to open https://github.com/login/device in your browser... ' >&2
read -r _ || exit 3
while [ ! -f "$DIR/approve" ]; do sleep 0.05; done
printf '✓ Authentication complete. Press Enter to continue...\n' >&2
read -r _ || exit 4
printf '✓ Logged in as hubot\n' >&2
exit 0
"#;
    let bin = fake_gh(td.path(), "2.40.0", login);
    let flow = start_sign_in(run_of(&bin, "fake-enter.test", false, None));
    let waiting = until(&flow.flow_id, |f| f.user_code.is_some() && f.url.is_some()).await;
    assert_eq!(waiting.user_code.as_deref(), Some("EF56-GH78"));
    let args = std::fs::read_to_string(td.path().join("login.args")).unwrap();
    assert!(!args.contains("--clipboard"), "gh 2.40 doesn't know the flag: {args}");
    std::fs::write(td.path().join("approve"), "ok").unwrap();
    let done = until(&flow.flow_id, |f| f.state.is_final()).await;
    assert_eq!(done.state, AuthFlowState::Done, "{done:?}");
    assert_eq!(done.account.as_deref(), Some("hubot"));
    assert_eq!(done.message.as_deref(), Some("Signed in to fake-enter.test as hubot."));
    assert!(!td.path().join("setup-git.args").exists(), "setupGit: false");
}

#[cfg(unix)]
#[tokio::test]
async fn status_from_json_text_and_an_older_gh() {
    let _serial = SERIAL.lock().await;
    let td = tempfile::tempdir().unwrap();
    let gitconfig = td.path().join("gitconfig");
    std::fs::write(&gitconfig, "[credential \"https://github.com\"]\n\thelper =\n\thelper = !/usr/bin/gh auth git-credential\n").unwrap();
    let cfg = gitconfig.to_string_lossy().into_owned();
    let env = [("GIT_CONFIG_GLOBAL", cfg.as_str())];
    let text = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n  - Git operations protocol: https\n";

    let json = tempfile::tempdir().unwrap();
    let bin = fake_gh(json.path(), "2.102.0", "exit 1");
    std::fs::write(json.path().join("status.json"), STATUS_SIGNED_IN).unwrap();
    let p = run_probe(&bin, &env).await;
    assert_eq!((p.version.as_deref(), p.signed_in(), p.git_helper), (Some("2.102.0"), Some(true), true));
    assert_eq!(p.suggest_from().map(|a| a.login.as_str()), Some("octocat"));

    // gh 2.45 has no `--json`: its text.
    let old = tempfile::tempdir().unwrap();
    let bin = fake_gh(old.path(), "2.45.0", "exit 1");
    std::fs::write(old.path().join("status.nojson"), "").unwrap();
    std::fs::write(old.path().join("status.txt"), text).unwrap();
    let p = run_probe(&bin, &[]).await;
    assert_eq!(p.signed_in(), Some(true));
    assert_eq!(std::fs::read_to_string(old.path().join("status.runs")).unwrap().lines().count(), 1, "text only");

    // A version gh doesn't tell plainly: `--json` first, its text after "unknown flag".
    let dev = tempfile::tempdir().unwrap();
    let bin = fake_gh(dev.path(), "dev", "exit 1");
    std::fs::write(dev.path().join("status.nojson"), "").unwrap();
    std::fs::write(dev.path().join("status.txt"), "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n").unwrap();
    let p = run_probe(&bin, &[]).await;
    assert_eq!((p.signed_in(), p.suggest_from()), (Some(false), None));
    assert_eq!(std::fs::read_to_string(dev.path().join("status.runs")).unwrap().lines().count(), 2);

    // Unreadable output: gh couldn't tell.
    let broken = tempfile::tempdir().unwrap();
    let bin = fake_gh(broken.path(), "2.102.0", "exit 1");
    std::fs::write(broken.path().join("status.json"), "not json").unwrap();
    let p = run_probe(&bin, &[]).await;
    assert_eq!(p.signed_in(), None);
    assert_eq!(p.entries.unwrap_err().code, "gh_error");
}

#[cfg(unix)]
#[tokio::test]
async fn the_checklist_does_not_wait_for_a_slow_gh() {
    let _serial = SERIAL.lock().await;
    let td = tempfile::tempdir().unwrap();
    let bin = fake_gh(td.path(), "2.102.0", "exit 1");
    std::fs::write(td.path().join("status.json"), r#"{"hosts":{}}"#).unwrap();
    std::fs::write(td.path().join("status.sleep"), "1").unwrap();
    let t = Instant::now();
    assert!(probe(&bin, Some(Duration::from_millis(200)), None).await.is_none(), "nothing cached yet");
    assert!(t.elapsed() < Duration::from_millis(900));
    // A caller that waits gets the same run's answer, and then it is cached.
    let p = probe(&bin, None, None).await.expect("the running look lands");
    assert_eq!(p.signed_in(), Some(false));
    let again = probe(&bin, Some(Duration::ZERO), None).await.expect("cached");
    assert!(Arc::ptr_eq(&p, &again));
    assert_eq!(std::fs::read_to_string(td.path().join("status.runs")).unwrap().lines().count(), 1);
}

#[tokio::test]
async fn git_identity_in_a_temp_global_config() {
    let Some(git) = resolve_bin("git") else {
        eprintln!("git is not installed; skipped");
        return;
    };
    let td = tempfile::tempdir().unwrap();
    let cfg = td.path().join("gitconfig");
    let (cfg_s, home) = (cfg.to_string_lossy().into_owned(), td.path().to_string_lossy().into_owned());
    let env = [("GIT_CONFIG_GLOBAL", cfg_s.as_str()), ("HOME", home.as_str()), ("XDG_CONFIG_HOME", home.as_str())];
    let id = identity_of(&git, &env, false).await.unwrap();
    assert_eq!((id.name, id.email, id.file.as_deref()), (None, None, Some(cfg_s.as_str())));
    assert!(!cfg.exists());

    let (name, email) = check_identity(&GitIdentityParams { name: " Ada \"The Countess\" Lovelace ".into(), email: "ada@example.com".into() }).unwrap();
    write_identity(&git, &name, &email, &env).await.unwrap();
    let id = identity_of(&git, &env, false).await.unwrap();
    assert_eq!((id.name.as_deref(), id.email.as_deref()), (Some("Ada \"The Countess\" Lovelace"), Some("ada@example.com")));
    // Again replaces (also a key set twice by hand).
    std::fs::write(&cfg, "[user]\n\tname = One\n\tname = Two\n").unwrap();
    write_identity(&git, "Ada", "ada@example.org", &env).await.unwrap();
    let id = identity_of(&git, &env, false).await.unwrap();
    assert_eq!((id.name.as_deref(), id.email.as_deref()), (Some("Ada"), Some("ada@example.org")));
    assert_eq!(std::fs::read_to_string(&cfg).unwrap().matches("name =").count(), 1);
}

/// The real gh, in a throwaway config: reaches GitHub's device code, then cancels (never completes
/// a sign-in). Needs network. `cargo test -p tf-hostd gh_real -- --ignored --nocapture`.
#[cfg(unix)]
#[tokio::test]
#[ignore = "runs the real gh against github.com"]
async fn gh_real_sign_in_reaches_the_device_code_and_cancels_cleanly() {
    let _serial = SERIAL.lock().await;
    let bin = resolve_bin("gh").expect("gh is installed");
    let td = tempfile::tempdir().unwrap();
    let dir = |name: &str| {
        let d = td.path().join(name);
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    };
    let (home, config, xdg_config, xdg_state, xdg_data, xdg_cache) = (dir("home"), dir("gh"), dir("xdg/config"), dir("xdg/state"), dir("xdg/data"), dir("xdg/cache"));
    let git_cfg = td.path().join("gitconfig").to_string_lossy().into_owned();
    let env: Vec<(String, String)> = [
        ("HOME", home.as_str()),
        ("GH_CONFIG_DIR", config.as_str()),
        ("XDG_CONFIG_HOME", xdg_config.as_str()),
        ("XDG_STATE_HOME", xdg_state.as_str()),
        ("XDG_DATA_HOME", xdg_data.as_str()),
        ("XDG_CACHE_HOME", xdg_cache.as_str()),
        ("GIT_CONFIG_GLOBAL", git_cfg.as_str()),
        // gh treats empty as unset: a token in this environment must not sign anything in.
        ("GH_TOKEN", ""),
        ("GITHUB_TOKEN", ""),
        ("GH_HOST", ""),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let extra: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    let p = run_probe(&bin, &extra).await;
    println!("gh {:?}: signed in {:?} ({:?})", p.version, p.signed_in(), p.entries.as_ref().map(Vec::len));
    assert_eq!(p.signed_in(), Some(false), "a fresh config is signed in nowhere");
    let part = setup_from(p.entries.as_ref().ok().map(|e| Ok(e.as_slice())), None, false);
    assert_eq!(part.issues.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), [ISSUE_SIGN_IN]);

    let shim = crate::ops::accounts::no_browser_dir(td.path());
    let started = Instant::now();
    let flow = start_sign_in(Run { bin: bin.clone(), host: DEFAULT_HOST.into(), setup_git: true, shim, env, ctx: None });
    let mut rev = None;
    let waiting = loop {
        let f = authflow::wait(&flow.flow_id, rev, Some(1000)).await.unwrap();
        if f.state.is_final() || (f.user_code.is_some() && f.url.is_some()) || started.elapsed() > Duration::from_secs(20) {
            break f;
        }
        rev = Some(f.rev);
    };
    println!("after {:?}: {:?} code {:?} at {:?} ({:?})", started.elapsed(), waiting.state, waiting.user_code, waiting.url, waiting.message);
    assert_eq!(waiting.state, AuthFlowState::Waiting, "{waiting:?}");
    assert_eq!(waiting.url.as_deref(), Some("https://github.com/login/device"));
    assert!(waiting.user_code.as_deref().is_some_and(|c| c.len() == 9 && c.as_bytes()[4] == b'-'), "{waiting:?}");

    // gh runs with this test's config: find it by its environment.
    let ours = || -> Vec<i32> {
        let needle = format!("GH_CONFIG_DIR={config}");
        std::fs::read_dir("/proc")
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok())
            .filter(|pid| std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|env| env.split(|b| *b == 0).any(|v| v == needle.as_bytes())))
            .filter(|pid| alive(*pid))
            .collect()
    };
    let running = ours();
    assert!(!running.is_empty(), "gh auth login runs");
    authflow::cancel(&flow.flow_id).unwrap();
    let mut left = running.clone();
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        left = ours();
        if left.is_empty() {
            break;
        }
    }
    println!("gh processes before cancel {running:?}, after {left:?}");
    assert!(left.is_empty(), "no gh process is left: {left:?}");
    assert_eq!(authflow::wait(&flow.flow_id, None, None).await.unwrap().state, AuthFlowState::Cancelled);
    assert!(!Path::new(&config).join("hosts.yml").exists(), "nothing was stored");
    assert!(!Path::new(&git_cfg).exists(), "git was left alone");
}
