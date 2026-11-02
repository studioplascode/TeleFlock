//! Windows login item: while at least one automation is enabled, or the agent ledger holds agents to
//! bring back after a reboot (`crate::restart`, with auto-resume on), a per-user Task Scheduler task,
//! `TeleFlock host service <hash of TF_HOSTD_HOME>`, runs `tf-hostd ensure` (start the daemon if it is
//! not running) a minute after the user logs on and every 10 minutes after, so schedules fire and
//! agents come back with no app connected. Nothing per-user starts before logon on Windows without an
//! administrator, so that is not offered. Only the real home installs one: a task cannot carry
//! `TF_HOSTD_HOME`, so another home's task could only start the real daemon.
//!
//! The task is made from XML (`schtasks /Create /TN <name> /XML <file> /F`, the file kept as
//! `<home>\login-task.xml`) for the current user, by SID: a logon trigger of that user, the user's own
//! token while they are logged on, least privilege, so no administrator rights and no password. It
//! shows in Task Scheduler and is removed with `schtasks /Delete /TN <name> /F`.
//!
//! `ensure` is a console program, and Task Scheduler cannot start one without a console window (it has
//! no `CREATE_NO_WINDOW`, which is how the app starts tf-hostd): at every logon and every 10 minutes a
//! window would flash and take the focus. So the task runs a copy of `tf-hostd.exe` made for it,
//! `<home>\bin\tf-hostd-login.exe` ([`LAUNCHER`]), whose PE header says "GUI program" where the
//! original says "console program" ([`as_windowless`]): Windows gives such a program no console, and
//! the copy is otherwise the same file. It is made when the task is, refreshed when `tf-hostd.exe`
//! changed and deleted with the task; the daemon its `ensure` starts runs from `tf-hostd.exe`
//! ([`canonical`]), detached as `attach` starts it. Task Scheduler runs a task in a job object: the
//! daemon breaks away from it where the job allows that, else it belongs to the task's run, which
//! therefore never ends by time or battery (no execution time limit, no stop on battery power) and
//! makes every later trigger a no-op (`IgnoreNew`) while the daemon lives.

use std::io;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

use tf_proto::{AutomationScheduler, BootService};

use super::boot::{self, Tool};
use crate::paths::Paths;

/// `AutomationScheduler.kind` and `BootService.kind` of this mechanism.
pub const KIND: &str = "taskScheduler";

/// The windowless copy of [`PROGRAM`] the task runs, in `<home>\bin`.
pub const LAUNCHER: &str = "tf-hostd-login.exe";

/// The program the launcher is a copy of, and what `ensure` starts the daemon from.
const PROGRAM: &str = "tf-hostd.exe";

/// What the Settings row says about this mechanism besides its state.
const NOTE: &str = "Starts when you log in to Windows, then every 10 minutes; starting before login is not offered.";

/// Name of this home's task: `TeleFlock host service <hash of the home>`.
pub fn task_name(paths: &Paths) -> String {
    format!("TeleFlock host service {}", paths.home_hash())
}

/// Where this home's windowless launcher is.
pub fn launcher_path(paths: &Paths) -> PathBuf {
    paths.bin.join(LAUNCHER)
}

/// The program `exe` stands for: `tf-hostd.exe` next to the windowless launcher, else `exe` itself.
/// The launcher only runs `ensure`; the daemon it starts is the real program (a daemon of another
/// file name would look like another binary to `attach --replace`).
pub fn canonical(exe: &Path) -> PathBuf {
    let launcher = exe.file_name().is_some_and(|n| n.eq_ignore_ascii_case(LAUNCHER));
    let program = exe.with_file_name(PROGRAM);
    if launcher && program.is_file() { program } else { exe.to_path_buf() }
}

/// `image`, a Windows program, as one that runs without a console window: its subsystem field
/// changed from console (3) to GUI (2), the one byte `editbin /subsystem:windows` changes. A GUI
/// program already is one. `None` for anything that is not a PE image of either kind.
fn as_windowless(mut image: Vec<u8>) -> Option<Vec<u8>> {
    // The PE header sits where the DOS header points: "PE\0\0", the 20-byte file header, then the
    // optional header, whose subsystem field is 68 bytes in for both PE32 and PE32+.
    let pe = usize::try_from(u32::from_le_bytes(image.get(0x3c..0x40)?.try_into().ok()?)).ok()?;
    if image.get(..2)? != b"MZ" || image.get(pe..pe.checked_add(4)?)? != b"PE\0\0" {
        return None;
    }
    let magic = u16::from_le_bytes([*image.get(pe + 24)?, *image.get(pe + 25)?]);
    if magic != 0x10b && magic != 0x20b {
        return None;
    }
    let at = pe.checked_add(24 + 68)?;
    match [*image.get(at)?, *image.get(at + 1)?] {
        [3, 0] => {
            image[at] = 2;
            Some(image)
        }
        [2, 0] => Some(image),
        _ => None,
    }
}

/// Makes `launcher` the windowless copy of `program` (module docs) unless it already is current: the
/// same size, and not older than `program`. True when it was written. An older copy that cannot be
/// replaced (it is running right now) is good enough until the next time.
fn ensure_launcher(program: &Path, launcher: &Path) -> io::Result<bool> {
    let source = std::fs::metadata(program)?;
    let existing = std::fs::metadata(launcher).ok();
    if let Some(copy) = &existing
        && copy.len() == source.len()
        && matches!((copy.modified(), source.modified()), (Ok(c), Ok(s)) if c >= s)
    {
        return Ok(false);
    }
    let image = as_windowless(std::fs::read(program)?).ok_or_else(|| io::Error::other(format!("{} is not a Windows program", program.display())))?;
    if let Some(dir) = launcher.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = launcher.with_extension("tmp");
    std::fs::write(&tmp, &image)?;
    if let Ok(modified) = source.modified() {
        // So the copy is current for as long as `program` stays as it is.
        let _ = std::fs::File::options().write(true).open(&tmp).and_then(|f| f.set_modified(modified));
    }
    match std::fs::rename(&tmp, launcher) {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            if existing.is_some() { Ok(false) } else { Err(e) }
        }
    }
}

/// What the task is made of.
pub struct TaskSpec<'a> {
    /// Whose task it is, and for whom the logon trigger fires: the SID of the current user.
    pub user: &'a str,
    /// This hostd home (the description names it).
    pub home: &'a str,
    /// The windowless launcher ([`LAUNCHER`]) the task runs.
    pub launcher: &'a str,
    pub relay_port: u16,
}

/// The task as XML. Element order is the one Task Scheduler itself exports. Priority 5 is a normal
/// process (the default, 7, is below normal, and the agents the daemon starts would inherit it).
pub fn render(spec: &TaskSpec) -> String {
    let text = boot::xml_text;
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         \x20 <RegistrationInfo>\n\
         \x20   <Description>Starts the TeleFlock host daemon (tf-hostd) when you log in and every 10 minutes if it is not running, so agents come back after a reboot and automations keep their schedule. Written by tf-hostd (TeleFlock automations and agent recovery); removed when neither needs it. Home: {home}</Description>\n\
         \x20 </RegistrationInfo>\n\
         \x20 <Triggers>\n\
         \x20   <LogonTrigger>\n\
         \x20     <Repetition>\n\
         \x20       <Interval>PT10M</Interval>\n\
         \x20       <StopAtDurationEnd>false</StopAtDurationEnd>\n\
         \x20     </Repetition>\n\
         \x20     <Enabled>true</Enabled>\n\
         \x20     <UserId>{user}</UserId>\n\
         \x20     <Delay>PT1M</Delay>\n\
         \x20   </LogonTrigger>\n\
         \x20 </Triggers>\n\
         \x20 <Principals>\n\
         \x20   <Principal id=\"Author\">\n\
         \x20     <UserId>{user}</UserId>\n\
         \x20     <LogonType>InteractiveToken</LogonType>\n\
         \x20     <RunLevel>LeastPrivilege</RunLevel>\n\
         \x20   </Principal>\n\
         \x20 </Principals>\n\
         \x20 <Settings>\n\
         \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
         \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
         \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
         \x20   <StartWhenAvailable>true</StartWhenAvailable>\n\
         \x20   <Enabled>true</Enabled>\n\
         \x20   <Hidden>false</Hidden>\n\
         \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
         \x20   <Priority>5</Priority>\n\
         \x20 </Settings>\n\
         \x20 <Actions Context=\"Author\">\n\
         \x20   <Exec>\n\
         \x20     <Command>{launcher}</Command>\n\
         \x20     <Arguments>ensure --relay-port {port}</Arguments>\n\
         \x20   </Exec>\n\
         \x20 </Actions>\n\
         </Task>\n",
        home = text(spec.home),
        user = text(spec.user),
        launcher = text(spec.launcher),
        port = spec.relay_port,
    )
}

/// What `schtasks /Create /XML` reads: UTF-16 little endian with a byte-order mark, the form Task
/// Scheduler exports (the XML names `UTF-16` itself).
fn encode(xml: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    out.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
    out
}

/// The `schtasks` calls for one task, as arguments.
pub struct Cli<'a> {
    pub name: &'a str,
    /// The task XML on disk.
    pub xml: &'a str,
}

impl Cli<'_> {
    /// Creates the task from the XML, replacing one of that name (`/F`).
    pub fn create(&self) -> Vec<String> {
        ["/Create", "/TN", self.name, "/XML", self.xml, "/F"].map(String::from).to_vec()
    }

    /// Deletes the task without asking (`/F`).
    pub fn delete(&self) -> Vec<String> {
        ["/Delete", "/TN", self.name, "/F"].map(String::from).to_vec()
    }

    /// Whether the task exists (exit status only).
    pub fn query(&self) -> Vec<String> {
        ["/Query", "/TN", self.name].map(String::from).to_vec()
    }
}

/// What reconciling needs from the machine (tests bring their own).
struct Host {
    /// The current user's SID.
    user: Option<String>,
    /// The running program (`tf-hostd.exe`, or the launcher).
    exe: Option<PathBuf>,
}

/// `<SystemRoot>\System32\schtasks.exe` by its full path, so a PATH with the user's directories in
/// it never picks another one.
fn schtasks_exe() -> PathBuf {
    let root = std::env::var("SystemRoot").ok().map(|r| r.trim_end_matches('\\').to_string()).filter(|r| !r.is_empty());
    PathBuf::from(format!(r"{}\System32\schtasks.exe", root.as_deref().unwrap_or(r"C:\Windows")))
}

#[cfg(windows)]
fn current_user() -> Option<String> {
    crate::secure::current_user_sid_string().ok()
}

#[cfg(not(windows))]
fn current_user() -> Option<String> {
    None
}

/// Installs (`want`) or removes this home's task and reports the resulting scheduler. `allowed`:
/// whether this home installs a login task at all ([`boot::allowed`]); one that does not never
/// reaches schtasks.
pub async fn reconcile(paths: &Paths, relay_port: u16, want: bool, allowed: bool) -> AutomationScheduler {
    if !allowed {
        return boot::daemon_only(NOT_THIS_HOME);
    }
    let host = Host { user: current_user(), exe: boot::exe_path() };
    apply(&boot::RealTool(schtasks_exe()), &host, paths, relay_port, want).await
}

async fn apply<T: Tool>(tool: &T, host: &Host, paths: &Paths, relay_port: u16, want: bool) -> AutomationScheduler {
    let name = task_name(paths);
    let xml_path = paths.home.join("login-task.xml");
    let xml_arg = xml_path.to_string_lossy().into_owned();
    let launcher = launcher_path(paths);
    let cli = Cli { name: &name, xml: &xml_arg };
    if !want {
        return boot::status(KIND, false, remove(tool, &cli, &xml_path, &launcher).await);
    }
    let Some(user) = host.user.as_deref() else {
        return boot::daemon_only("Cannot tell which Windows user this is, so no Task Scheduler task is installed. Automations run while tf-hostd runs.");
    };
    let (Some(program), Some(home), Some(launcher_arg)) = (host.exe.as_deref().map(canonical), paths.home.to_str(), launcher.to_str()) else {
        return boot::daemon_only("Cannot locate the tf-hostd binary to install the Task Scheduler task. Automations run while tf-hostd runs.");
    };
    if let Err(e) = ensure_launcher(&program, &launcher) {
        warn!(launcher = %launcher.display(), "automations: cannot make the login task's launcher: {e}");
        return boot::status(
            KIND,
            false,
            Some(format!("Could not make {} for the Task Scheduler task: {e}. Automations run while tf-hostd runs.", launcher.display())),
        );
    }
    let xml = render(&TaskSpec { user, home, launcher: launcher_arg, relay_port });
    let changed = match boot::write_if_changed(&xml_path, &encode(&xml)) {
        Ok(changed) => changed,
        Err(e) => {
            warn!(path = %xml_path.display(), "automations: cannot write the Task Scheduler task file: {e}");
            return boot::status(
                KIND,
                false,
                Some(format!("Could not write {}: {e}. Automations run while tf-hostd runs.", xml_path.display())),
            );
        }
    };
    let mut registered = tool.run(&cli.query()).await.is_ok();
    let mut err = None;
    if changed || !registered {
        err = tool.run(&cli.create()).await.err();
        registered = tool.run(&cli.query()).await.is_ok();
        if registered {
            info!(task = %name, "automations: Task Scheduler login task installed");
        }
    }
    boot::status(
        KIND,
        registered,
        (!registered).then(|| match err {
            Some(e) => format!("The Task Scheduler task is not active ({e}). Automations run while tf-hostd runs."),
            None => "The Task Scheduler task is not active. Automations run while tf-hostd runs.".into(),
        }),
    )
}

/// Deletes the task, its file and its launcher, whichever of them is there (asks Task Scheduler, so a
/// task whose file was deleted by hand still goes). A note when the task is still there afterwards;
/// the files then stay, so the next sync tries again. Only the real home gets this far ([`reconcile`]).
async fn remove<T: Tool>(tool: &T, cli: &Cli<'_>, xml_path: &Path, launcher: &Path) -> Option<String> {
    let registered = tool.run(&cli.query()).await.is_ok();
    let left_over = |p: &Path| p.symlink_metadata().is_ok();
    if !registered && !left_over(xml_path) && !left_over(launcher) {
        return None;
    }
    if registered {
        let refused = tool.run(&cli.delete()).await.err();
        if tool.run(&cli.query()).await.is_ok() {
            let why = refused.map(|e| format!(" ({e})")).unwrap_or_default();
            warn!(task = cli.name, "automations: the Task Scheduler task is still there{why}");
            return Some(format!("Could not remove the Task Scheduler task{why}. Delete it in Task Scheduler, or switch the setting off again."));
        }
    }
    // A launcher that runs right now cannot be deleted; the next sync takes it.
    for file in [xml_path, launcher, &launcher.with_extension("tmp")] {
        let _ = std::fs::remove_file(file);
    }
    info!(task = cli.name, "automations: Task Scheduler login task removed");
    None
}

/// What a development home reports: its login task is the real home's alone.
const NOT_THIS_HOME: &str = "Not installed by this tf-hostd home: only the default home (%USERPROFILE%\\.teleflock) installs a login task on Windows.";

/// What "Bring agents back after a reboot" can do on this Windows host: install this home's task
/// (`allowed`: the real home), and whether the scheduler `status` says it is there.
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

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";

    /// A Windows program as far as the header goes: the DOS header points at `PE\0\0` at 0x78, then the
    /// file header and an optional header of the given kind (`pe32plus`: PE32+) with `subsystem`, and
    /// a payload that must come through untouched.
    fn fake_pe(pe32plus: bool, subsystem: u16) -> Vec<u8> {
        let mut image = vec![0u8; 0x78 + 4 + 20 + if pe32plus { 112 } else { 96 } + 64];
        image[..2].copy_from_slice(b"MZ");
        image[0x3c..0x40].copy_from_slice(&0x78u32.to_le_bytes());
        image[0x78..0x7c].copy_from_slice(b"PE\0\0");
        image[0x7c..0x7e].copy_from_slice(&(if pe32plus { 0x8664u16 } else { 0x14cu16 }).to_le_bytes());
        let optional = 0x78 + 24;
        image[optional..optional + 2].copy_from_slice(&(if pe32plus { 0x20bu16 } else { 0x10bu16 }).to_le_bytes());
        image[optional + 68..optional + 70].copy_from_slice(&subsystem.to_le_bytes());
        let end = image.len();
        for (i, b) in image[end - 64..].iter_mut().enumerate() {
            *b = 0xA0 + i as u8 % 16;
        }
        image
    }

    #[test]
    fn a_console_program_becomes_a_gui_program_and_nothing_else_changes() {
        for pe32plus in [true, false] {
            let console = fake_pe(pe32plus, 3);
            let gui = as_windowless(console.clone()).unwrap();
            assert_eq!(gui, fake_pe(pe32plus, 2), "pe32plus {pe32plus}");
            let changed: Vec<usize> = (0..console.len()).filter(|&i| console[i] != gui[i]).collect();
            assert_eq!(changed, [0x78 + 24 + 68], "only the subsystem byte");
            assert_eq!(as_windowless(gui.clone()), Some(gui), "a GUI program already is windowless");
        }
    }

    #[test]
    fn anything_else_is_not_made_into_a_launcher() {
        assert_eq!(as_windowless(Vec::new()), None);
        assert_eq!(as_windowless(b"#!/bin/sh\necho hi\n".to_vec()), None, "not a PE file");
        assert_eq!(as_windowless(fake_pe(true, 1)), None, "native drivers and the like");
        assert_eq!(as_windowless(fake_pe(true, 9)), None, "Windows CE");
        let mut no_signature = fake_pe(true, 3);
        no_signature[0x78] = b'X';
        assert_eq!(as_windowless(no_signature), None);
        let mut odd_magic = fake_pe(true, 3);
        odd_magic[0x78 + 24] = 0x0b;
        odd_magic[0x78 + 25] = 0x99;
        assert_eq!(as_windowless(odd_magic), None, "neither PE32 nor PE32+");
        let mut wild_pointer = fake_pe(true, 3);
        wild_pointer[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(as_windowless(wild_pointer), None, "a header pointer past the file is no panic");
        assert_eq!(as_windowless(fake_pe(true, 3)[..0x78 + 24 + 40].to_vec()), None, "a truncated header");
    }

    #[test]
    fn the_launcher_is_made_refreshed_and_left_alone_when_current() {
        let td = tempfile::tempdir().unwrap();
        let (program, launcher) = (td.path().join("bin").join(PROGRAM), td.path().join("bin").join(LAUNCHER));
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        std::fs::write(&program, fake_pe(true, 3)).unwrap();
        assert!(ensure_launcher(&program, &launcher).unwrap(), "made");
        assert_eq!(std::fs::read(&launcher).unwrap(), fake_pe(true, 2));
        assert_eq!(std::fs::read(&program).unwrap(), fake_pe(true, 3), "the program itself is untouched");
        assert!(!launcher.with_extension("tmp").exists());
        assert!(!ensure_launcher(&program, &launcher).unwrap(), "current: not written again");
        // tf-hostd.exe was replaced by a build from later: the copy follows.
        let mut newer = fake_pe(true, 3);
        let len = newer.len();
        newer[len - 1] = 0x42;
        std::fs::write(&program, &newer).unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(&program).unwrap().set_modified(later).unwrap();
        assert!(ensure_launcher(&program, &launcher).unwrap(), "refreshed");
        assert_eq!(std::fs::read(&launcher).unwrap().last(), Some(&0x42));
        assert!(!ensure_launcher(&program, &launcher).unwrap());
        // Something that is not a Windows program makes no launcher.
        let other = td.path().join("elsewhere.exe");
        std::fs::write(&other, "not a program").unwrap();
        let err = ensure_launcher(&other, &td.path().join("bin").join("other-login.exe")).unwrap_err();
        assert!(err.to_string().contains("is not a Windows program"), "{err}");
    }

    #[test]
    fn the_daemon_runs_from_tf_hostd_exe_even_when_the_launcher_started_ensure() {
        let td = tempfile::tempdir().unwrap();
        let bin = td.path().join("Jörg Müller").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let (program, launcher) = (bin.join(PROGRAM), bin.join(LAUNCHER));
        assert_eq!(canonical(&launcher), launcher, "no tf-hostd.exe next to it: itself");
        std::fs::write(&program, "x").unwrap();
        assert_eq!(canonical(&launcher), program);
        assert_eq!(canonical(&bin.join("TF-HOSTD-LOGIN.EXE")), program, "Windows file names ignore case");
        assert_eq!(canonical(&program), program, "tf-hostd.exe stays itself");
        let dev = td.path().join("target").join("debug").join("tf-hostd");
        assert_eq!(canonical(&dev), dev, "any other program stays itself");
    }

    #[test]
    fn the_task_is_a_logon_trigger_that_repeats_for_this_user_only() {
        let xml = render(&TaskSpec {
            user: SID,
            home: r"C:\Users\ada\.teleflock",
            launcher: r"C:\Users\ada\.teleflock\bin\tf-hostd-login.exe",
            relay_port: 47605,
        });
        assert_eq!(
            xml,
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
             <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n  \
               <RegistrationInfo>\n    \
                 <Description>Starts the TeleFlock host daemon (tf-hostd) when you log in and every 10 minutes if it is not running, so agents come back after a reboot and automations keep their schedule. Written by tf-hostd (TeleFlock automations and agent recovery); removed when neither needs it. Home: C:\\Users\\ada\\.teleflock</Description>\n  \
               </RegistrationInfo>\n  \
               <Triggers>\n    \
                 <LogonTrigger>\n      \
                   <Repetition>\n        \
                     <Interval>PT10M</Interval>\n        \
                     <StopAtDurationEnd>false</StopAtDurationEnd>\n      \
                   </Repetition>\n      \
                   <Enabled>true</Enabled>\n      \
                   <UserId>S-1-5-21-1004336348-1177238915-682003330-1001</UserId>\n      \
                   <Delay>PT1M</Delay>\n    \
                 </LogonTrigger>\n  \
               </Triggers>\n  \
               <Principals>\n    \
                 <Principal id=\"Author\">\n      \
                   <UserId>S-1-5-21-1004336348-1177238915-682003330-1001</UserId>\n      \
                   <LogonType>InteractiveToken</LogonType>\n      \
                   <RunLevel>LeastPrivilege</RunLevel>\n    \
                 </Principal>\n  \
               </Principals>\n  \
               <Settings>\n    \
                 <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n    \
                 <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n    \
                 <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n    \
                 <StartWhenAvailable>true</StartWhenAvailable>\n    \
                 <Enabled>true</Enabled>\n    \
                 <Hidden>false</Hidden>\n    \
                 <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n    \
                 <Priority>5</Priority>\n  \
               </Settings>\n  \
               <Actions Context=\"Author\">\n    \
                 <Exec>\n      \
                   <Command>C:\\Users\\ada\\.teleflock\\bin\\tf-hostd-login.exe</Command>\n      \
                   <Arguments>ensure --relay-port 47605</Arguments>\n    \
                 </Exec>\n  \
               </Actions>\n\
             </Task>\n"
        );
    }

    #[test]
    fn spaces_non_ascii_letters_and_markup_in_paths_survive() {
        let spec = TaskSpec {
            user: SID,
            home: r"C:\Users\Jörg Müller\R&D <lab>\.teleflock",
            launcher: r"C:\Users\Jörg Müller\R&D <lab>\.teleflock\bin\tf-hostd-login.exe",
            relay_port: 1,
        };
        let xml = render(&spec);
        // The command is its own element: spaces need no quoting, markup needs escaping.
        assert!(xml.contains(r"<Command>C:\Users\Jörg Müller\R&amp;D &lt;lab&gt;\.teleflock\bin\tf-hostd-login.exe</Command>"), "{xml}");
        assert!(xml.contains("<Arguments>ensure --relay-port 1</Arguments>"), "{xml}");
        assert!(xml.contains(r"Home: C:\Users\Jörg Müller\R&amp;D &lt;lab&gt;\.teleflock</Description>"), "{xml}");
        assert!(!xml.contains("R&D") && !xml.contains("<lab>"), "nothing unescaped: {xml}");
    }

    #[test]
    fn the_file_task_scheduler_reads_is_utf16_with_a_byte_order_mark() {
        let bytes = encode("<a>é日😀</a>");
        assert_eq!(&bytes[..2], [0xFF, 0xFE]);
        let units: Vec<u16> = bytes[2..].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), "<a>é日😀</a>");
        assert_eq!(bytes.len(), 2 + 2 * "<a>é日😀</a>".encode_utf16().count());
    }

    #[test]
    fn every_home_gets_its_own_task() {
        let real = Paths::new(PathBuf::from("/Users/ada/.teleflock"), false);
        let lab = Paths::new(PathBuf::from("/tmp/tf-lab-x"), true);
        let n = task_name(&real);
        assert_eq!(n, format!("TeleFlock host service {}", real.home_hash()));
        assert!(n.strip_prefix("TeleFlock host service ").is_some_and(|h| h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit())), "{n}");
        assert_ne!(n, task_name(&lab));
        assert_eq!(launcher_path(&real), real.home.join("bin").join(LAUNCHER));
    }

    #[test]
    fn the_schtasks_command_lines() {
        let cli = Cli { name: "TeleFlock host service 0123abcd", xml: r"C:\Users\Jane Doe\.teleflock\login-task.xml" };
        assert_eq!(cli.create(), ["/Create", "/TN", "TeleFlock host service 0123abcd", "/XML", r"C:\Users\Jane Doe\.teleflock\login-task.xml", "/F"]);
        assert_eq!(cli.delete(), ["/Delete", "/TN", "TeleFlock host service 0123abcd", "/F"]);
        assert_eq!(cli.query(), ["/Query", "/TN", "TeleFlock host service 0123abcd"]);
    }

    /// A real home folder in a temp dir (nothing here touches the real `~\.teleflock`), whose
    /// `bin\tf-hostd.exe` is a console program, and a host that runs it.
    fn real_home(dir: &Path) -> (Paths, Host) {
        let paths = Paths::new(dir.join(".teleflock"), false);
        std::fs::create_dir_all(&paths.bin).unwrap();
        let exe = paths.bin.join(PROGRAM);
        std::fs::write(&exe, fake_pe(true, 3)).unwrap();
        (paths, Host { user: Some(SID.into()), exe: Some(exe) })
    }

    /// Task Scheduler as one fake: `/Query` says whether `registered` is set; `/Create` sets it
    /// (unless `refuse`), `/Delete` clears it (or fails when there was none).
    fn scheduler(registered: bool, refuse: &'static [&'static str]) -> (Arc<AtomicBool>, Recorder) {
        let state = Arc::new(AtomicBool::new(registered));
        let s = state.clone();
        let tool = Recorder::new(move |args, _| {
            let verb = args[0].as_str();
            if refuse.contains(&verb) {
                return Err(format!("schtasks {verb} failed: ERROR: Access is denied."));
            }
            match verb {
                "/Query" if !s.load(Ordering::SeqCst) => Err("schtasks /Query failed: ERROR: The system cannot find the file specified.".into()),
                "/Create" => {
                    s.store(true, Ordering::SeqCst);
                    Ok("SUCCESS: The scheduled task has successfully been created.".into())
                }
                "/Delete" => {
                    if s.swap(false, Ordering::SeqCst) { Ok(String::new()) } else { Err("schtasks /Delete failed: ERROR: The system cannot find the file specified.".into()) }
                }
                _ => Ok(String::new()),
            }
        });
        (state, tool)
    }

    #[tokio::test]
    async fn turning_it_on_makes_the_launcher_writes_the_task_file_and_creates_the_task() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, tool) = scheduler(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert_eq!((status.kind.as_str(), status.persistent, status.note), ("taskScheduler", true, None));
        let launcher = launcher_path(&paths);
        assert_eq!(std::fs::read(&launcher).unwrap(), fake_pe(true, 2), "a windowless copy of tf-hostd.exe");
        assert_eq!(std::fs::read(paths.bin.join(PROGRAM)).unwrap(), fake_pe(true, 3), "which itself stays a console program");
        let xml_path = paths.home.join("login-task.xml");
        let expected = render(&TaskSpec { user: SID, home: paths.home.to_str().unwrap(), launcher: launcher.to_str().unwrap(), relay_port: 47605 });
        assert_eq!(std::fs::read(&xml_path).unwrap(), encode(&expected), "the file Task Scheduler reads");
        let name = task_name(&paths);
        assert_eq!(
            tool.calls(),
            [format!("/Query /TN {name}"), format!("/Create /TN {name} /XML {} /F", xml_path.display()), format!("/Query /TN {name}")]
        );
    }

    #[tokio::test]
    async fn a_task_that_is_there_and_current_is_left_alone() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, first) = scheduler(false, &[]);
        apply(&first, &host, &paths, 47605, true).await;
        let (_, tool) = scheduler(true, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert!(status.persistent && status.note.is_none());
        assert_eq!(tool.calls(), [format!("/Query /TN {}", task_name(&paths))], "one read, nothing recreated");
    }

    #[tokio::test]
    async fn a_changed_definition_replaces_the_task() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, first) = scheduler(false, &[]);
        apply(&first, &host, &paths, 47605, true).await;
        // The relay port changed: the file differs from what was registered.
        let (_, tool) = scheduler(true, &[]);
        let status = apply(&tool, &host, &paths, 47999, true).await;
        assert!(status.persistent);
        let calls = tool.calls();
        assert_eq!(calls.len(), 3, "{calls:?}");
        assert!(calls[1].starts_with("/Create /TN ") && calls[1].ends_with(" /F"), "{calls:?}");
        let written = std::fs::read(paths.home.join("login-task.xml")).unwrap();
        let text = String::from_utf16_lossy(&written.chunks(2).skip(1).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>());
        assert!(text.contains("<Arguments>ensure --relay-port 47999</Arguments>"), "{text}");
    }

    #[tokio::test]
    async fn a_launcher_the_virus_scanner_took_comes_back_with_the_task_in_place() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, first) = scheduler(false, &[]);
        apply(&first, &host, &paths, 47605, true).await;
        std::fs::remove_file(launcher_path(&paths)).unwrap();
        let (_, tool) = scheduler(true, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert!(status.persistent && status.note.is_none());
        assert_eq!(std::fs::read(launcher_path(&paths)).unwrap(), fake_pe(true, 2));
        assert_eq!(tool.calls(), [format!("/Query /TN {}", task_name(&paths))], "the task did not need to change");
    }

    #[tokio::test]
    async fn a_task_the_user_deleted_comes_back() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, first) = scheduler(false, &[]);
        apply(&first, &host, &paths, 47605, true).await;
        let (state, tool) = scheduler(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert!(status.persistent && state.load(Ordering::SeqCst));
        let calls = tool.calls();
        assert!(calls[0].starts_with("/Query") && calls[1].starts_with("/Create") && calls[2].starts_with("/Query"), "{calls:?}");
    }

    #[tokio::test]
    async fn a_task_windows_refuses_is_reported_with_the_reason() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, tool) = scheduler(false, &["/Create"]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert_eq!((status.kind.as_str(), status.persistent), ("taskScheduler", false));
        let note = status.note.unwrap();
        assert!(note.starts_with("The Task Scheduler task is not active (schtasks /Create failed: ERROR: Access is denied.)"), "{note}");
        assert!(note.ends_with("Automations run while tf-hostd runs."), "{note}");
    }

    #[tokio::test]
    async fn without_a_user_or_a_binary_there_is_nothing_to_install() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        for (user, exe, what) in [(None, host.exe.clone(), "which Windows user"), (Some(SID.to_string()), None, "tf-hostd binary")] {
            let (_, tool) = scheduler(false, &[]);
            let status = apply(&tool, &Host { user, exe }, &paths, 47605, true).await;
            assert_eq!((status.kind.as_str(), status.persistent), ("daemon", false));
            assert!(status.note.unwrap().contains(what));
            assert!(tool.calls().is_empty() && !paths.home.join("login-task.xml").exists() && !launcher_path(&paths).exists());
        }
    }

    #[tokio::test]
    async fn a_program_that_cannot_be_copied_is_reported_before_any_task_is_made() {
        let td = tempfile::tempdir().unwrap();
        let (paths, mut host) = real_home(td.path());
        host.exe = Some(paths.bin.join("gone.exe"));
        let (_, tool) = scheduler(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, true).await;
        assert_eq!((status.kind.as_str(), status.persistent), ("taskScheduler", false));
        assert!(status.note.unwrap().starts_with("Could not make "), "the launcher is the task's program");
        assert!(tool.calls().is_empty() && !paths.home.join("login-task.xml").exists());
    }

    #[tokio::test]
    async fn turning_it_off_deletes_the_task_its_file_and_its_launcher() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let other = paths.home.join("login-task.other.xml");
        let (_, on) = scheduler(false, &[]);
        apply(&on, &host, &paths, 47605, true).await;
        std::fs::write(&other, "x").unwrap();
        let (state, tool) = scheduler(true, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert_eq!((status.kind.as_str(), status.persistent, status.note), ("taskScheduler", false, None));
        let name = task_name(&paths);
        assert_eq!(tool.calls(), [format!("/Query /TN {name}"), format!("/Delete /TN {name} /F"), format!("/Query /TN {name}")]);
        assert!(!state.load(Ordering::SeqCst) && !paths.home.join("login-task.xml").exists() && !launcher_path(&paths).exists());
        assert!(other.exists());
        assert!(paths.bin.join(PROGRAM).exists(), "tf-hostd.exe itself stays");
    }

    #[tokio::test]
    async fn a_task_that_is_already_gone_leaves_only_its_files_to_delete() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, on) = scheduler(false, &[]);
        apply(&on, &host, &paths, 47605, true).await;
        let (_, tool) = scheduler(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert!(status.note.is_none() && !paths.home.join("login-task.xml").exists() && !launcher_path(&paths).exists());
        assert_eq!(tool.calls(), [format!("/Query /TN {}", task_name(&paths))], "nothing to delete");
    }

    #[tokio::test]
    async fn a_task_whose_file_was_deleted_by_hand_still_goes() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (state, tool) = scheduler(true, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert!(status.note.is_none() && !state.load(Ordering::SeqCst), "Task Scheduler is asked, not the folder");
        assert!(tool.calls().iter().any(|c| c.starts_with("/Delete /TN ")), "{:?}", tool.calls());
    }

    #[tokio::test]
    async fn a_task_that_cannot_be_deleted_keeps_its_files_and_says_so() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, on) = scheduler(false, &[]);
        apply(&on, &host, &paths, 47605, true).await;
        let (_, tool) = scheduler(true, &["/Delete"]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        let note = status.note.unwrap();
        assert!(note.starts_with("Could not remove the Task Scheduler task (schtasks /Delete failed: ERROR: Access is denied.)"), "{note}");
        assert!(paths.home.join("login-task.xml").exists() && launcher_path(&paths).exists(), "the task still runs the launcher; the next sync tries again");
    }

    #[tokio::test]
    async fn the_real_home_with_nothing_installed_only_asks_task_scheduler() {
        let td = tempfile::tempdir().unwrap();
        let (paths, host) = real_home(td.path());
        let (_, tool) = scheduler(false, &[]);
        let status = apply(&tool, &host, &paths, 47605, false).await;
        assert_eq!((status.kind.as_str(), status.persistent, status.note), ("taskScheduler", false, None));
        assert_eq!(tool.calls(), [format!("/Query /TN {}", task_name(&paths))]);
        assert!(!launcher_path(&paths).exists() && !paths.home.join("login-task.xml").exists());
    }

    #[tokio::test]
    async fn a_development_home_says_why_and_never_reaches_schtasks() {
        // `reconcile` answers before it looks for System32 or the user, so this runs nothing, on any OS.
        let td = tempfile::tempdir().unwrap();
        let lab = Paths::new(td.path().join("tf-lab-x"), true);
        for want in [false, true] {
            let status = reconcile(&lab, 47605, want, false).await;
            assert_eq!((status.kind.as_str(), status.persistent), ("daemon", false), "want {want}");
            assert_eq!(status.note.as_deref(), Some(NOT_THIS_HOME));
        }
        assert!(!lab.home.exists(), "not even the folder is made");
    }

    #[test]
    fn the_setting_says_what_this_windows_host_can_do() {
        let status = |kind: &str, persistent: bool, note: Option<&str>| boot::status(kind, persistent, note.map(Into::into));
        let off = boot_service(true, &status("taskScheduler", false, None));
        assert_eq!((off.available, off.installed, off.kind.as_deref()), (true, false, Some("taskScheduler")));
        assert!(off.note.as_deref().is_some_and(|n| n.contains("when you log in") && n.contains("starting before login is not offered")), "{off:?}");
        let on = boot_service(true, &status("taskScheduler", true, None));
        assert!(on.available && on.installed && on.note.as_deref().is_some_and(|n| n.contains("when you log in")), "{on:?}");
        let broken = boot_service(true, &status("taskScheduler", false, Some("The Task Scheduler task is not active (boom).")));
        assert!(broken.available && !broken.installed && broken.note.as_deref() == Some("The Task Scheduler task is not active (boom)."), "{broken:?}");
        assert!(!boot_service(true, &status("daemon", true, None)).installed, "another mechanism's status is never installed");
        // A development home installs none, and no opt-in helps: its task could only start the real daemon.
        let lab = boot_service(false, &status("taskScheduler", false, None));
        assert!(!lab.available && !lab.installed && lab.note.as_deref().is_some_and(|n| n.contains("only the default home") && !n.contains("TF_HOSTD_KEEPALIVE")), "{lab:?}");
    }
}
