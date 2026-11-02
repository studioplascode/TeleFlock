//! macOS login item: while at least one automation is enabled, or the agent ledger holds agents to
//! bring back after a reboot (`crate::restart`, with auto-resume on), a per-user launchd agent runs
//! `tf-hostd ensure` (start the daemon if it is not running) when the user logs in (`RunAtLoad`) and
//! every 10 minutes (`StartInterval`), so schedules fire and agents come back with no app connected.
//! Nothing per-user starts before login on macOS, so that is not offered.
//!
//! The agent is `~/Library/LaunchAgents/dev.teleflock.hostd.<hash of TF_HOSTD_HOME>.plist`, one per
//! hostd home, and shows up in System Settings → General → Login Items. It is loaded with
//! `launchctl bootstrap gui/<uid>` (the older `load` where that is refused) and removed with
//! `bootout` (`unload`); a file in place is loaded by launchd at the next login anyway. `ensure`
//! starts the daemon in a session of its own (`setsid`), and `AbandonProcessGroup` keeps launchd from
//! sweeping it up when `ensure` exits.

use std::path::{Path, PathBuf};

use tracing::{debug, info, warn};

use tf_proto::{AutomationScheduler, BootService};

use super::boot::{self, Tool};
use crate::paths::Paths;

/// `AutomationScheduler.kind` and `BootService.kind` of this mechanism.
pub const KIND: &str = "launchd";

/// launchd's control tool, by absolute path (PATH holds the user's directories).
const LAUNCHCTL: &str = "/bin/launchctl";

/// Seconds between two `ensure` runs (the first is at login).
const INTERVAL_SECS: u32 = 600;

/// What the Settings row says about this mechanism besides its state.
const NOTE: &str = "Starts when you log in to this Mac, then every 10 minutes; starting before login is not offered.";

/// Label of this home's agent: `dev.teleflock.hostd.<hash of the home>`.
pub fn label(paths: &Paths) -> String {
    format!("dev.teleflock.hostd.{}", paths.home_hash())
}

/// The agent's property list. `home`: this hostd home (`TF_HOSTD_HOME`); `env`: what `ensure` needs
/// and launchd does not provide (`HOME`, the installing daemon's `PATH`, `USER`, `LANG`).
pub fn render(label: &str, exe: &str, home: &str, relay_port: u16, env: &[(&str, String)]) -> String {
    let string = |s: &str| format!("<string>{}</string>", boot::xml_text(s));
    let mut vars = format!("\t\t<key>TF_HOSTD_HOME</key>\n\t\t{}\n", string(home));
    for (k, v) in env {
        vars.push_str(&format!("\t\t<key>{}</key>\n\t\t{}\n", boot::xml_text(k), string(v)));
    }
    let port = relay_port.to_string();
    let args: String = [exe, "ensure", "--relay-port", &port].iter().map(|a| format!("\t\t{}\n", string(a))).collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <!-- Written by tf-hostd (TeleFlock automations and agent recovery); removed when neither needs it. -->\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t{}\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         {args}\
         \t</array>\n\
         \t<key>EnvironmentVariables</key>\n\
         \t<dict>\n\
         {vars}\
         \t</dict>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>StartInterval</key>\n\
         \t<integer>{INTERVAL_SECS}</integer>\n\
         \t<key>AbandonProcessGroup</key>\n\
         \t<true/>\n\
         </dict>\n\
         </plist>\n",
        string(label),
    )
}

/// The `launchctl` calls for one agent, as arguments.
pub struct Ctl<'a> {
    pub uid: u32,
    pub label: &'a str,
    /// The agent's plist.
    pub plist: &'a str,
}

impl Ctl<'_> {
    fn domain(&self) -> String {
        format!("gui/{}", self.uid)
    }

    fn service(&self) -> String {
        format!("{}/{}", self.domain(), self.label)
    }

    /// Loads the agent into the user's GUI domain.
    pub fn bootstrap(&self) -> Vec<String> {
        vec!["bootstrap".into(), self.domain(), self.plist.into()]
    }

    /// Unloads it again (stopping what it runs).
    pub fn bootout(&self) -> Vec<String> {
        vec!["bootout".into(), self.service()]
    }

    /// Whether the GUI domain has it (exit status only).
    pub fn print(&self) -> Vec<String> {
        vec!["print".into(), self.service()]
    }

    /// `bootstrap` for a session without a GUI domain: the older command loads into the caller's own.
    pub fn load(&self) -> Vec<String> {
        vec!["load".into(), self.plist.into()]
    }

    /// `bootout`'s older counterpart.
    pub fn unload(&self) -> Vec<String> {
        vec!["unload".into(), self.plist.into()]
    }

    /// Whether the caller's own domain has it (what `load` fills).
    pub fn list(&self) -> Vec<String> {
        vec!["list".into(), self.label.into()]
    }
}

/// What reconciling needs from the machine (tests bring their own).
struct Host {
    /// `~/Library/LaunchAgents`.
    dir: PathBuf,
    uid: u32,
    exe: Option<PathBuf>,
    env: Vec<(&'static str, String)>,
}

impl Host {
    fn detect() -> Option<Host> {
        let home = crate::paths::home_dir();
        home.to_str().filter(|h| Path::new(h).is_absolute())?;
        Some(Host { dir: home.join("Library").join("LaunchAgents"), uid: uid()?, exe: boot::exe_path(), env: boot::daemon_env() })
    }
}

#[cfg(unix)]
fn uid() -> Option<u32> {
    // SAFETY: geteuid has no preconditions.
    Some(unsafe { libc::geteuid() })
}

#[cfg(not(unix))]
fn uid() -> Option<u32> {
    None
}

/// Installs (`want`) or removes this home's agent and reports the resulting scheduler. `allowed`:
/// whether this home installs a login item at all ([`boot::allowed`]); one that does not never
/// reaches launchctl.
pub async fn reconcile(paths: &Paths, relay_port: u16, want: bool, allowed: bool) -> AutomationScheduler {
    if !allowed {
        return boot::daemon_only(NOT_THIS_HOME);
    }
    match Host::detect() {
        Some(host) => apply(&boot::RealTool(PathBuf::from(LAUNCHCTL)), &host, paths, relay_port, want).await,
        None if want => boot::daemon_only("Cannot find your Library folder to install the launchd agent in. Automations run while tf-hostd runs."),
        None => boot::status(KIND, false, None),
    }
}

async fn apply<T: Tool>(tool: &T, host: &Host, paths: &Paths, relay_port: u16, want: bool) -> AutomationScheduler {
    let label = label(paths);
    let plist = host.dir.join(format!("{label}.plist"));
    let plist_arg = plist.to_string_lossy().into_owned();
    let ctl = Ctl { uid: host.uid, label: &label, plist: &plist_arg };
    if !want {
        return boot::status(KIND, false, remove(tool, &ctl, &plist).await);
    }
    let (Some(exe), Some(home)) = (host.exe.as_deref().and_then(Path::to_str), paths.home.to_str()) else {
        return boot::daemon_only("Cannot locate the tf-hostd binary to install the launchd agent. Automations run while tf-hostd runs.");
    };
    let changed = match boot::write_if_changed(&plist, render(&label, exe, home, relay_port, &host.env).as_bytes()) {
        Ok(changed) => changed,
        Err(e) => {
            warn!(dir = %host.dir.display(), "automations: cannot write the launchd agent: {e}");
            return boot::status(
                KIND,
                false,
                Some(format!("Could not install the launchd agent in {}: {e}. Automations run while tf-hostd runs.", host.dir.display())),
            );
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if changed {
            // launchd refuses an agent file that others can write.
            let _ = std::fs::set_permissions(&plist, std::fs::Permissions::from_mode(0o644));
        }
    }
    let mut active = loaded(tool, &ctl).await;
    let mut err = None;
    if changed || !active {
        if active {
            // What is loaded is the old definition: out it goes before the new one comes in.
            let _ = tool.run(&ctl.bootout()).await;
        }
        err = register(tool, &ctl).await.err();
        active = loaded(tool, &ctl).await;
        if active {
            info!(label = %label, "automations: launchd login item installed");
        }
    }
    boot::status(
        KIND,
        active,
        (!active).then(|| {
            let why = err.map(|e| format!(" ({e})")).unwrap_or_default();
            // A user who switched the item off in System Settings gets it back only from there.
            let hint = if why.to_lowercase().contains("disabled") { " Allow it in System Settings → General → Login Items." } else { "" };
            format!("The launchd agent is not active{why}.{hint} Automations run while tf-hostd runs.")
        }),
    )
}

/// Whether launchd has the agent: in the user's GUI domain, or in the caller's own (`load`).
async fn loaded<T: Tool>(tool: &T, ctl: &Ctl<'_>) -> bool {
    tool.run(&ctl.print()).await.is_ok() || tool.run(&ctl.list()).await.is_ok()
}

/// Loads the agent: `bootstrap` into the GUI domain, else the older `load`. What failed first is
/// what is reported (the older command's refusal says less).
async fn register<T: Tool>(tool: &T, ctl: &Ctl<'_>) -> Result<(), String> {
    let first = match tool.run(&ctl.bootstrap()).await {
        Ok(_) => return Ok(()),
        Err(e) => e,
    };
    match tool.run(&ctl.load()).await {
        Ok(_) => Ok(()),
        Err(second) => {
            debug!("automations: {second}");
            Err(first)
        }
    }
}

/// Unloads the agent and deletes its file, whichever of the two is there (asks launchd, so an agent
/// whose file was deleted by hand still goes). A note when it is still loaded afterwards; the file
/// then stays, so the next sync tries again. Only the real home gets this far ([`reconcile`]).
async fn remove<T: Tool>(tool: &T, ctl: &Ctl<'_>, plist: &Path) -> Option<String> {
    let was_loaded = loaded(tool, ctl).await;
    if !was_loaded && plist.symlink_metadata().is_err() {
        return None;
    }
    if was_loaded {
        // No such agent in the GUI domain (it was `load`ed into the caller's own): the older command.
        let refused = tool.run(&ctl.bootout()).await.err();
        if refused.is_some() {
            let _ = tool.run(&ctl.unload()).await;
        }
        if loaded(tool, ctl).await {
            let why = refused.map(|e| format!(" ({e})")).unwrap_or_default();
            warn!(label = ctl.label, "automations: the launchd agent is still loaded{why}");
            return Some(format!("Could not remove the launchd agent: it is still loaded{why}. Switch the setting off again, or log out, to stop it."));
        }
    }
    let _ = std::fs::remove_file(plist);
    info!(label = ctl.label, "automations: launchd login item removed");
    None
}

/// What a development home reports: its login item is the real home's alone.
const NOT_THIS_HOME: &str = "Not installed by this tf-hostd home: only the default home (~/.teleflock) installs a login item.";

/// What "Bring agents back after a reboot" can do on this Mac: install this home's agent (`allowed`:
/// the real home), and whether the scheduler `status` says it is loaded.
pub fn boot_service(allowed: bool, status: &AutomationScheduler) -> BootService {
    if !allowed {
        return BootService { available: false, installed: false, kind: Some(KIND.into()), note: Some(NOT_THIS_HOME.into()) };
    }
    let installed = status.kind == KIND && status.persistent;
    BootService {
        available: true,
        installed,
        kind: Some(KIND.into()),
        note: if installed { Some(NOTE.into()) } else { status.note.clone().or_else(|| Some(NOTE.into())) },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use super::boot::testing::Recorder;
    use super::*;

    const LABEL: &str = "dev.teleflock.hostd.0123abcd";

    fn env() -> Vec<(&'static str, String)> {
        vec![("HOME", "/Users/ada".into()), ("PATH", "/opt/homebrew/bin:/usr/bin".into()), ("USER", "ada".into()), ("LANG", "en_US.UTF-8".into())]
    }

    #[test]
    fn the_plist_runs_ensure_at_login_and_every_ten_minutes() {
        let plist = render(LABEL, "/Users/ada/.teleflock/bin/tf-hostd", "/Users/ada/.teleflock", 47605, &env());
        assert_eq!(
            plist,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <!-- Written by tf-hostd (TeleFlock automations and agent recovery); removed when neither needs it. -->\n\
             <plist version=\"1.0\">\n\
             <dict>\n\
             \t<key>Label</key>\n\
             \t<string>dev.teleflock.hostd.0123abcd</string>\n\
             \t<key>ProgramArguments</key>\n\
             \t<array>\n\
             \t\t<string>/Users/ada/.teleflock/bin/tf-hostd</string>\n\
             \t\t<string>ensure</string>\n\
             \t\t<string>--relay-port</string>\n\
             \t\t<string>47605</string>\n\
             \t</array>\n\
             \t<key>EnvironmentVariables</key>\n\
             \t<dict>\n\
             \t\t<key>TF_HOSTD_HOME</key>\n\
             \t\t<string>/Users/ada/.teleflock</string>\n\
             \t\t<key>HOME</key>\n\
             \t\t<string>/Users/ada</string>\n\
             \t\t<key>PATH</key>\n\
             \t\t<string>/opt/homebrew/bin:/usr/bin</string>\n\
             \t\t<key>USER</key>\n\
             \t\t<string>ada</string>\n\
             \t\t<key>LANG</key>\n\
             \t\t<string>en_US.UTF-8</string>\n\
             \t</dict>\n\
             \t<key>RunAtLoad</key>\n\
             \t<true/>\n\
             \t<key>StartInterval</key>\n\
             \t<integer>600</integer>\n\
             \t<key>AbandonProcessGroup</key>\n\
             \t<true/>\n\
             </dict>\n\
             </plist>\n"
        );
    }

    #[test]
    fn spaces_non_ascii_letters_and_markup_in_paths_survive() {
        let env = vec![("HOME", "/Users/Jörg Müller".into()), ("PATH", "/Users/Jörg Müller/.bun/bin:/a&b/<c>".into())];
        let plist = render(LABEL, "/Users/Jörg Müller/.teleflock/bin/tf-hostd", "/Users/Jörg Müller/Café & Co/.teleflock", 1, &env);
        assert!(plist.contains("\t\t<string>/Users/Jörg Müller/.teleflock/bin/tf-hostd</string>\n"), "{plist}");
        assert!(plist.contains("\t\t<key>TF_HOSTD_HOME</key>\n\t\t<string>/Users/Jörg Müller/Café &amp; Co/.teleflock</string>\n"), "{plist}");
        assert!(plist.contains("<string>/Users/Jörg Müller/.bun/bin:/a&amp;b/&lt;c&gt;</string>"), "{plist}");
        assert!(!plist.contains("&b") && !plist.contains("<c>"), "nothing unescaped: {plist}");
    }

    #[test]
    fn every_home_gets_its_own_label() {
        let real = Paths::new(PathBuf::from("/Users/ada/.teleflock"), false);
        let lab = Paths::new(PathBuf::from("/tmp/tf-lab-x"), true);
        let l = label(&real);
        assert_eq!(l, format!("dev.teleflock.hostd.{}", real.home_hash()));
        assert!(l.strip_prefix("dev.teleflock.hostd.").is_some_and(|h| h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit())), "{l}");
        assert_ne!(l, label(&lab));
    }

    #[test]
    fn the_launchctl_command_lines() {
        let ctl = Ctl { uid: 501, label: LABEL, plist: "/Users/ada/Library/LaunchAgents/dev.teleflock.hostd.0123abcd.plist" };
        let plist = ctl.plist;
        assert_eq!(ctl.bootstrap(), ["bootstrap", "gui/501", plist]);
        assert_eq!(ctl.bootout(), ["bootout", "gui/501/dev.teleflock.hostd.0123abcd"]);
        assert_eq!(ctl.print(), ["print", "gui/501/dev.teleflock.hostd.0123abcd"]);
        assert_eq!(ctl.load(), ["load", plist]);
        assert_eq!(ctl.unload(), ["unload", plist]);
        assert_eq!(ctl.list(), ["list", "dev.teleflock.hostd.0123abcd"]);
    }

    /// A host whose agent folder is `dir` (a temp dir: nothing here touches the real one).
    fn host(dir: &Path) -> Host {
        Host { dir: dir.join("Library").join("LaunchAgents"), uid: 501, exe: Some(PathBuf::from("/Users/ada/.teleflock/bin/tf-hostd")), env: env() }
    }

    fn home() -> Paths {
        Paths::new(PathBuf::from("/Users/ada/.teleflock"), false)
    }

    fn plist_path(host: &Host, paths: &Paths) -> PathBuf {
        host.dir.join(format!("{}.plist", label(paths)))
    }

    /// launchd as one fake: `print`/`list` say whether `loaded` is set; `bootstrap`/`load` set it
    /// (unless `refuse`), `bootout`/`unload` clear it. Failures read like [`boot::RealTool`]'s.
    fn launchd(loaded: bool, refuse: &'static [&'static str]) -> (Arc<AtomicBool>, Recorder) {
        let state = Arc::new(AtomicBool::new(loaded));
        let s = state.clone();
        let tool = Recorder::new(move |args, _| {
            let verb = args[0].as_str();
            let fail = |why: &str| Err(format!("launchctl {} failed: {why}", args.join(" ")));
            if refuse.contains(&verb) {
                return fail("Bootstrap failed: 125: Domain does not support specified action");
            }
            match verb {
                "print" | "list" if !s.load(Ordering::SeqCst) => fail("Could not find service"),
                "bootstrap" | "load" => {
                    s.store(true, Ordering::SeqCst);
                    Ok(String::new())
                }
                "bootout" | "unload" => {
                    if s.swap(false, Ordering::SeqCst) { Ok(String::new()) } else { fail("No such process") }
                }
                _ => Ok(String::new()),
            }
        });
        (state, tool)
    }

    #[tokio::test]
    async fn turning_it_on_writes_the_agent_and_loads_it() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, tool) = launchd(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert_eq!((status.kind.as_str(), status.persistent, status.note), ("launchd", true, None));
        let written = std::fs::read_to_string(plist_path(&host, &paths)).unwrap();
        assert_eq!(written, render(&label(&paths), "/Users/ada/.teleflock/bin/tf-hostd", "/Users/ada/.teleflock", 47605, &env()));
        let plist = plist_path(&host, &paths).display().to_string();
        assert_eq!(
            tool.calls(),
            [
                format!("print gui/501/{}", label(&paths)),
                format!("list {}", label(&paths)),
                format!("bootstrap gui/501 {plist}"),
                format!("print gui/501/{}", label(&paths)),
            ]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(plist_path(&host, &paths)).unwrap().permissions().mode() & 0o777, 0o644, "launchd refuses a writable agent");
        }
    }

    #[tokio::test]
    async fn an_agent_that_is_there_and_loaded_is_left_alone() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, tool) = launchd(false, &[]);
        apply(&tool, &host, &paths, 47605, true).await;
        let (_, again) = launchd(true, &[]);
        let status = apply(&again, &host, &paths, 47605, true).await;
        assert!(status.persistent && status.note.is_none());
        assert_eq!(again.calls(), [format!("print gui/501/{}", label(&paths))], "one read, nothing reloaded");
    }

    #[tokio::test]
    async fn a_changed_definition_replaces_the_loaded_one() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, first) = launchd(false, &[]);
        apply(&first, &host, &paths, 47605, true).await;
        // The relay port changed (or the binary moved, or PATH): the file differs from what is loaded.
        let (state, tool) = launchd(true, &[]);
        let status = apply(&tool, &host, &paths, 47999, true).await;
        assert!(status.persistent && state.load(Ordering::SeqCst));
        let (l, plist) = (label(&paths), plist_path(&host, &paths).display().to_string());
        assert_eq!(tool.calls(), [format!("print gui/501/{l}"), format!("bootout gui/501/{l}"), format!("bootstrap gui/501 {plist}"), format!("print gui/501/{l}")]);
        assert!(std::fs::read_to_string(&plist).unwrap().contains("<string>47999</string>"));
    }

    #[tokio::test]
    async fn the_older_load_stands_in_where_the_gui_domain_refuses() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, tool) = launchd(false, &["bootstrap"]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert!(status.persistent && status.note.is_none(), "{status:?}");
        let calls = tool.calls();
        assert!(calls.iter().any(|c| c.starts_with("bootstrap gui/501 ")) && calls.iter().any(|c| c.starts_with("load ")), "{calls:?}");
    }

    #[tokio::test]
    async fn an_agent_launchd_will_not_load_is_reported_with_the_reason() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, tool) = launchd(false, &["bootstrap", "load"]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert_eq!((status.kind.as_str(), status.persistent), ("launchd", false));
        let note = status.note.unwrap();
        assert!(note.starts_with("The launchd agent is not active (launchctl bootstrap gui/501 "), "{note}");
        assert!(note.contains("125") && note.ends_with("Automations run while tf-hostd runs."), "{note}");
        assert!(plist_path(&host, &paths).exists(), "the file stays: launchd loads it at the next login");
    }

    #[tokio::test]
    async fn an_unwritable_agent_folder_is_reported_not_attempted() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        // `Library` is a file, so the folder cannot be made.
        std::fs::write(td.path().join("Library"), "x").unwrap();
        let (_, tool) = launchd(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert!(!status.persistent && status.note.unwrap().starts_with("Could not install the launchd agent in "));
        assert!(tool.calls().is_empty(), "nothing was registered");
    }

    #[tokio::test]
    async fn without_the_binary_there_is_nothing_to_install() {
        let td = tempfile::tempdir().unwrap();
        let (mut host, paths) = (host(td.path()), home());
        host.exe = None;
        let (_, tool) = launchd(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert_eq!((status.kind.as_str(), status.persistent), ("daemon", false));
        assert!(status.note.unwrap().contains("Cannot locate the tf-hostd binary"));
        assert!(tool.calls().is_empty() && !plist_path(&host, &paths).exists());
    }

    #[tokio::test]
    async fn turning_it_off_unloads_the_agent_and_deletes_its_file() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let other = host.dir.join("dev.teleflock.hostd.0000beef.plist");
        let (_, on) = launchd(false, &[]);
        apply(&on, &host, &paths, 47605, true).await;
        std::fs::write(&other, "x").unwrap();
        let (state, tool) = launchd(true, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert_eq!((status.kind.as_str(), status.persistent, status.note), ("launchd", false, None));
        let l = label(&paths);
        assert_eq!(tool.calls(), [format!("print gui/501/{l}"), format!("bootout gui/501/{l}"), format!("print gui/501/{l}"), format!("list {l}")]);
        assert!(!state.load(Ordering::SeqCst) && !plist_path(&host, &paths).exists());
        assert!(other.exists(), "another home's agent stays");
    }

    #[tokio::test]
    async fn an_agent_that_never_loaded_is_still_deleted() {
        // No login session (SSH only): launchd has nothing, the file goes anyway.
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, on) = launchd(false, &["bootstrap", "load"]);
        apply(&on, &host, &paths, 47605, true).await;
        let (_, tool) = launchd(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert!(status.note.is_none() && !plist_path(&host, &paths).exists());
        let l = label(&paths);
        assert_eq!(tool.calls(), [format!("print gui/501/{l}"), format!("list {l}")], "nothing to unload");
    }

    #[tokio::test]
    async fn an_agent_whose_file_was_deleted_by_hand_still_goes() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        // Loaded in this login, its file gone: launchd is asked, not the folder.
        let (state, tool) = launchd(true, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert!(status.note.is_none() && !state.load(Ordering::SeqCst));
        assert!(tool.calls().iter().any(|c| c.starts_with("bootout gui/501/")), "{:?}", tool.calls());
    }

    #[tokio::test]
    async fn an_agent_that_stays_loaded_keeps_its_file_and_says_so() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, on) = launchd(false, &[]);
        apply(&on, &host, &paths, 47605, true).await;
        let (_, tool) = launchd(true, &["bootout", "unload"]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert!(status.note.unwrap().starts_with("Could not remove the launchd agent: it is still loaded"));
        assert!(plist_path(&host, &paths).exists(), "so the next sync tries again");
        let calls = tool.calls();
        assert!(calls.iter().any(|c| c.starts_with("bootout ")) && calls.iter().any(|c| c.starts_with("unload ")), "both were tried: {calls:?}");
    }

    #[tokio::test]
    async fn the_real_home_with_nothing_installed_only_asks_launchd() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let (_, tool) = launchd(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert_eq!((status.kind.as_str(), status.persistent, status.note), ("launchd", false, None));
        let l = label(&paths);
        assert_eq!(tool.calls(), [format!("print gui/501/{l}"), format!("list {l}")]);
        assert!(!host.dir.exists(), "not even the folder is made");
    }

    #[tokio::test]
    async fn a_development_home_says_why_and_never_reaches_launchctl() {
        // `reconcile` answers before it looks for the user's Library or for launchctl, so this runs
        // nothing, on any OS.
        let lab = Paths::new(PathBuf::from("/tmp/tf-lab-x"), true);
        for want in [false, true] {
            let status = reconcile(&lab, 47605, want, false).await;
            assert_eq!((status.kind.as_str(), status.persistent), ("daemon", false), "want {want}");
            assert_eq!(status.note.as_deref(), Some(NOT_THIS_HOME));
        }
    }

    #[tokio::test]
    async fn a_user_who_switched_the_login_item_off_in_system_settings_is_told_where() {
        let td = tempfile::tempdir().unwrap();
        let (host, paths) = (host(td.path()), home());
        let tool = Recorder::new(|args, _| match args[0].as_str() {
            "bootstrap" | "load" => Err(format!("launchctl {} failed: Bootstrap failed: 119: Service is disabled", args.join(" "))),
            _ => Err("launchctl print failed: Could not find service".into()),
        });
        let note = apply(&tool, &host, &paths, 47605, true).await.note.unwrap();
        assert!(note.contains("Service is disabled). Allow it in System Settings → General → Login Items. Automations run while tf-hostd runs."), "{note}");
    }

    #[test]
    fn the_setting_says_what_this_mac_can_do() {
        let status = |kind: &str, persistent: bool, note: Option<&str>| boot::status(kind, persistent, note.map(Into::into));
        // Not loaded yet: available, with what it will be.
        let off = boot_service(true, &status("launchd", false, None));
        assert_eq!((off.available, off.installed, off.kind.as_deref()), (true, false, Some("launchd")));
        assert!(off.note.as_deref().is_some_and(|n| n.contains("when you log in") && n.contains("starting before login is not offered")), "{off:?}");
        // Loaded.
        let on = boot_service(true, &status("launchd", true, None));
        assert!(on.available && on.installed && on.note.as_deref().is_some_and(|n| n.contains("when you log in")), "{on:?}");
        // Broken: the reason replaces the standing note.
        let broken = boot_service(true, &status("launchd", false, Some("The launchd agent is not active (boom).")));
        assert!(broken.available && !broken.installed && broken.note.as_deref() == Some("The launchd agent is not active (boom)."), "{broken:?}");
        // Another mechanism's status (the daemon-only fallback) is never "installed".
        assert!(!boot_service(true, &status("daemon", true, None)).installed);
        // A development home installs none, and no opt-in helps: a login item is the real home's alone.
        let lab = boot_service(false, &status("launchd", false, None));
        assert!(!lab.available && !lab.installed && lab.kind.as_deref() == Some("launchd"), "{lab:?}");
        assert!(lab.note.as_deref().is_some_and(|n| n.contains("only the default home") && !n.contains("TF_HOSTD_KEEPALIVE")), "{lab:?}");
    }
}
