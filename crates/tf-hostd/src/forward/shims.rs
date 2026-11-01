//! `tf-forward` and the tool shims (architecture §3.30): `<home>/bin/tf-forward` and
//! `<home>/forward/bin/tf-forward` run `tf-hostd forward …`; `<home>/forward/bin/<tool>` runs
//! `tf-hostd forward --tool <tool> <name> -- "$@"` for every tool an app relays to this host,
//! kept equal to the offers (`.cmd` files on Windows). One PATH entry (`<home>/forward/bin`)
//! covers both. Shims carry [`MARKER`]; files without it are the user's and never touched.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tracing::{info, warn};

/// The launcher's name (`tf-forward`, `.cmd` on Windows).
pub const LAUNCHER: &str = "tf-forward";
/// Marks a file this module wrote for a tool.
const MARKER: &str = "tf-hostd forward shim";

/// What one shim runs: the forward's name, and the to-host's display name for its comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shim {
    pub name: String,
    pub to: String,
}

fn file_name(stem: &str) -> String {
    if cfg!(windows) { format!("{stem}.cmd") } else { stem.to_string() }
}

/// POSIX single-quoted.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A display name fit for a comment line.
fn comment(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || " .-_()".contains(c) { c } else { ' ' }).collect::<String>().trim().to_string()
}

/// A path for a `.cmd` file: `%` doubled, or cmd expands it.
fn cmd_path(p: &Path) -> String {
    p.to_string_lossy().replace('%', "%%")
}

fn launcher_text(home: &Path, exe: &Path) -> String {
    if cfg!(windows) {
        let (home, exe) = (cmd_path(home), cmd_path(exe));
        format!(
            "@echo off\r\nsetlocal DisableDelayedExpansion\r\nset \"TF_HOSTD_HOME={home}\"\r\n\"{exe}\" forward %*\r\nexit /b %ERRORLEVEL%\r\nrem tf-forward: runs a command on another host through a TeleFlock app (tf-forward --help). Written by tf-hostd.\r\n"
        )
    } else {
        let (home, exe) = (home.to_string_lossy(), exe.to_string_lossy());
        format!(
            "#!/bin/sh\n# tf-forward: runs a command on another host through a TeleFlock app (tf-forward --help).\n# Written by tf-hostd at start.\nexport TF_HOSTD_HOME={}\nexec {} forward \"$@\"\n",
            sq(&home),
            sq(&exe)
        )
    }
}

fn shim_text(home: &Path, exe: &Path, tool: &str, shim: &Shim) -> String {
    let to = comment(&shim.to);
    // Tool and forward names are plain (`[A-Za-z0-9._+-]`, `[a-z0-9-]`): safe in both languages.
    if cfg!(windows) {
        // cmd reads a running batch file again at the offset it reached after each command: what
        // may change while one runs (the comment) comes after the last line it executes.
        let (home, exe) = (cmd_path(home), cmd_path(exe));
        format!(
            "@echo off\r\nsetlocal DisableDelayedExpansion\r\nset \"TF_HOSTD_HOME={home}\"\r\n\"{exe}\" forward --tool {tool} {name} -- %*\r\nexit /b %ERRORLEVEL%\r\nrem {MARKER}: {tool} runs on {to} through forward {name}. Written by tf-hostd while a TeleFlock app relays it.\r\n",
            name = shim.name
        )
    } else {
        format!(
            "#!/bin/sh\n# {MARKER}: \"{tool}\" runs on {to} through forward \"{name}\".\n# Written by tf-hostd while a TeleFlock app relays it; do not edit.\nexport TF_HOSTD_HOME={home}\nexec {exe} forward --tool {tool_q} {name_q} -- \"$@\"\n",
            name = shim.name,
            home = sq(&home.to_string_lossy()),
            exe = sq(&exe.to_string_lossy()),
            tool_q = sq(tool),
            name_q = sq(&shim.name)
        )
    }
}

/// Writes `path` (0755) through a temp file in its directory, unless it already holds `text`.
fn put(path: &Path, text: &str) -> io::Result<bool> {
    if std::fs::read_to_string(path).is_ok_and(|t| t == text) {
        return Ok(false);
    }
    let dir = path.parent().ok_or_else(|| io::Error::other("no parent dir"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.{}.tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("shim"), std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(true)
}

/// Writes the `tf-forward` launcher into `<home>/bin` and `forward_bin` (daemon start).
pub(crate) fn write_launchers(home: &Path, forward_bin: &Path, exe: &Path) -> io::Result<()> {
    let text = launcher_text(home, exe);
    for dir in [home.join("bin"), forward_bin.to_path_buf()] {
        put(&dir.join(file_name(LAUNCHER)), &text)?;
    }
    Ok(())
}

/// Makes `dir`'s shims exactly `want` (tool → what it runs): writes missing and changed ones,
/// removes shims of tools no longer relayed. A user's own file of a tool's name stays (that tool
/// then gets no shim). Returns the tools whose shims exist now.
pub(crate) fn sync(dir: &Path, home: &Path, exe: &Path, want: &BTreeMap<String, Shim>) -> Vec<String> {
    let launcher = file_name(LAUNCHER);
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == launcher {
                continue;
            }
            let tool = if cfg!(windows) { name.strip_suffix(".cmd").unwrap_or(&name).to_string() } else { name.clone() };
            if want.contains_key(&tool) || !is_shim(&e.path()) {
                continue;
            }
            match std::fs::remove_file(e.path()) {
                Ok(()) => info!(tool, "forward shim removed (no longer relayed)"),
                Err(err) => warn!(tool, "removing forward shim: {err}"),
            }
        }
    }
    let mut have = Vec::new();
    for (tool, shim) in want {
        let path = dir.join(file_name(tool));
        if path.exists() && !is_shim(&path) {
            warn!(tool, path = %path.display(), "a file of this tool's name is not a TeleFlock shim; leaving it");
            continue;
        }
        match put(&path, &shim_text(home, exe, tool, shim)) {
            Ok(true) => {
                info!(tool, forward = %shim.name, "forward shim written");
                have.push(tool.clone());
            }
            Ok(false) => have.push(tool.clone()),
            Err(e) => warn!(tool, "writing forward shim: {e}"),
        }
    }
    have
}

fn is_shim(path: &Path) -> bool {
    std::fs::read(path).is_ok_and(|b| b.len() < 4096 && String::from_utf8_lossy(&b).contains(MARKER))
}

/// The tf-hostd binary the launchers run: this executable (as it was installed; a replaced binary
/// shows as `… (deleted)`), else `<home>/bin/tf-hostd`.
pub(crate) fn exe_path(home: &Path) -> PathBuf {
    let installed = home.join("bin").join(if cfg!(windows) { "tf-hostd.exe" } else { "tf-hostd" });
    match std::env::current_exe() {
        Ok(p) => {
            let s = p.to_string_lossy();
            match s.strip_suffix(" (deleted)") {
                Some(_) => installed,
                None => p,
            }
        }
        Err(_) => installed,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn shims_follow_the_offers_and_leave_other_files_alone() {
        let td = tempfile::tempdir().unwrap();
        let home = td.path().join("home with 'quote'");
        let dir = home.join("forward").join("bin");
        let exe = td.path().join("tf-hostd");
        write_launchers(&home, &dir, &exe).unwrap();
        let launcher = std::fs::read_to_string(dir.join(LAUNCHER)).unwrap();
        assert_eq!(launcher, std::fs::read_to_string(home.join("bin").join(LAUNCHER)).unwrap());
        assert!(launcher.contains(&format!("exec {} forward \"$@\"", sq(&exe.to_string_lossy()))), "{launcher}");
        std::fs::write(dir.join("mine"), "#!/bin/sh\necho user file\n").unwrap();

        let shim = |name: &str| Shim { name: name.into(), to: "Studio Mac\n; rm -rf /".into() };
        let mut want = BTreeMap::from([("agent-browser".to_string(), shim("mac")), ("adb".to_string(), shim("mac"))]);
        assert_eq!(sync(&dir, &home, &exe, &want), vec!["adb".to_string(), "agent-browser".to_string()]);
        let text = std::fs::read_to_string(dir.join("agent-browser")).unwrap();
        assert!(text.contains("forward --tool 'agent-browser' 'mac' -- \"$@\""), "{text}");
        assert!(!text.contains("rm -rf /\n") && text.lines().count() == 5, "names stay in their comment: {text}");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("adb")).unwrap().permissions().mode() & 0o777, 0o755);

        // One tool is no longer relayed: its shim goes; the user's file and the launcher stay.
        want.remove("adb");
        // A user's own file of a relayed tool's name is not replaced.
        std::fs::write(dir.join("code"), "#!/bin/sh\nmy code\n").unwrap();
        want.insert("code".into(), shim("mac"));
        assert_eq!(sync(&dir, &home, &exe, &want), vec!["agent-browser".to_string()]);
        assert!(!dir.join("adb").exists());
        assert_eq!(std::fs::read_to_string(dir.join("code")).unwrap(), "#!/bin/sh\nmy code\n");
        assert!(dir.join("mine").exists() && dir.join(LAUNCHER).exists());
        sync(&dir, &home, &exe, &BTreeMap::new());
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["code", "mine", "tf-forward"]);
    }

    /// The shim really runs `tf-hostd forward --tool …` with the arguments as they were.
    #[test]
    fn a_shim_passes_its_arguments_exactly() {
        let td = tempfile::tempdir().unwrap();
        let home = td.path().join("h");
        let dir = home.join("forward").join("bin");
        let exe = td.path().join("fake-hostd");
        crate::test_exe::write_exe(&exe, "#!/bin/sh\nprintf '%s\\n' \"$TF_HOSTD_HOME\" \"$@\"\n");
        sync(&dir, &home, &exe, &BTreeMap::from([("tool".to_string(), Shim { name: "mac".into(), to: "Mac".into() })]));
        // A thread of this test binary that forked meanwhile may hold the fresh shim open for a
        // moment (`ETXTBSY`, see `test_exe`).
        let out = (0..100)
            .find_map(|_| match std::process::Command::new(dir.join("tool")).args(["a b", "--cwd", "-t", "$HOME"]).output() {
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    None
                }
                other => Some(other.unwrap()),
            })
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), format!("{}\nforward\n--tool\ntool\nmac\n--\na b\n--cwd\n-t\n$HOME\n", home.display()));
    }
}
