//! The planner and the applier against a recording [`System`]: no test changes a real unit or
//! process (the trampoline's own tests in `work.rs` start throwaway shells).

use std::sync::Mutex;

use super::*;

fn unit(manager: Manager, cgroup: &str) -> Unit {
    let name = cgroup.rsplit('/').next().unwrap().to_string();
    Unit { manager, name, cgroup: cgroup.into() }
}

fn proc_in(pid: u32, manager: Manager, cgroup: &str, weights: bool) -> Proc {
    Proc { pid, unit: Some(unit(manager, cgroup)), weights, autogroup: false }
}

const OWN: &str = "/system.slice/teleflock-hostd-4809-1794591303200.scope";

/// This very host: Debian with systemd and cgroup v2 CPU control, tf-hostd as root in its scope,
/// sshd and tailscaled as services.
fn cgroup_root_host() -> Facts {
    Facts {
        os: Os::Linux,
        privileged: true,
        own: proc_in(4833, Manager::System, OWN, true),
        herdr_in_own_cgroup: false,
        services: vec![
            (Target::Ssh, vec![proc_in(109, Manager::System, "/system.slice/ssh.service", true)]),
            (Target::Tailscale, vec![proc_in(93, Manager::System, "/system.slice/tailscaled.service", true)]),
        ],
    }
}

/// A host without cgroup CPU control (or without systemd): nice values compete, in autogroups.
fn nice_host(privileged: bool) -> Facts {
    let p = |pid| Proc { pid, unit: None, weights: false, autogroup: true };
    Facts { os: Os::Linux, privileged, own: p(500), herdr_in_own_cgroup: false, services: vec![(Target::Ssh, vec![p(109)]), (Target::Tailscale, vec![p(93)])] }
}

/// Records every call; answers from what the test set.
struct Recorder {
    facts: Mutex<Facts>,
    probe_ok: Mutex<bool>,
    /// pids (nice, class) and unit names (weights) that are refused.
    denied: Vec<String>,
    calls: Mutex<Vec<String>>,
    seen: Mutex<Vec<Services>>,
}

impl Recorder {
    fn new(facts: Facts) -> Recorder {
        Recorder { facts: Mutex::new(facts), probe_ok: Mutex::new(true), denied: Vec::new(), calls: Mutex::new(Vec::new()), seen: Mutex::new(Vec::new()) }
    }

    fn denying(mut self, what: &[&str]) -> Recorder {
        self.denied = what.iter().map(|s| s.to_string()).collect();
        self
    }

    fn calls(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    fn call(&self, line: String, key: &str) -> Result<(), Fail> {
        self.calls.lock().unwrap().push(line);
        if self.denied.iter().any(|d| d == key) { Err(Fail::Denied) } else { Ok(()) }
    }
}

impl System for Recorder {
    fn observe(&self, services: &Services) -> Facts {
        self.seen.lock().unwrap().push(services.clone());
        let mut facts = self.facts.lock().unwrap().clone();
        // Only what this home may touch is looked for.
        if *services == Services::Untouched {
            facts.services.clear();
        }
        facts
    }

    fn probe(&self, manager: Manager) -> bool {
        self.calls.lock().unwrap().push(format!("probe {manager:?}"));
        *self.probe_ok.lock().unwrap()
    }

    fn raise_weights(&self, unit: &Unit) -> Result<Replaced, Fail> {
        self.call(format!("weights {}", unit.name), &unit.name).map(|()| Replaced { cpu: Some(100), io: Some(100) })
    }

    fn restore_weights(&self, unit: &Unit, replaced: &Replaced) -> Result<(), Fail> {
        self.call(format!("restore {} cpu {:?} io {:?}", unit.name, replaced.cpu, replaced.io), &unit.name)
    }

    fn renice(&self, pid: u32, autogroup: bool) -> Result<(), Fail> {
        self.call(format!("nice {pid}{}", if autogroup { " +autogroup" } else { "" }), &pid.to_string())
    }

    fn raise_class(&self, pid: u32) -> Result<(), Fail> {
        self.call(format!("class {pid}"), &pid.to_string())
    }

    fn place(&self, manager: Manager, unit: &str, _description: &str, pid: u32) -> Result<(), Fail> {
        self.calls.lock().unwrap().push(format!("place {pid} {manager:?} {unit}"));
        Ok(())
    }
}

fn run(sys: &Recorder, services: &Services, state: &mut State) -> (Outcome, PriorityStatus) {
    let (facts, _, outcome) = check(sys, services, state, Instant::now(), false);
    let status = status(&outcome, facts.os, 1);
    (outcome, status)
}

fn labels(s: &PriorityStatus) -> Vec<&str> {
    s.raised.iter().map(String::as_str).collect()
}

#[test]
fn with_cgroup_weights_root_raises_its_scope_ssh_and_tailscale_units() {
    let sys = Recorder::new(cgroup_root_host());
    let mut state = State::default();
    let (o, s) = run(&sys, &Services::Discover, &mut state);
    assert_eq!(
        sys.calls(),
        ["probe System", "weights teleflock-hostd-4809-1794591303200.scope", "weights ssh.service", "weights tailscaled.service"],
        "the unit weights alone: nice values do not compete across cgroups"
    );
    assert_eq!(labels(&s), ["TeleFlock", "SSH server", "Tailscale"]);
    assert_eq!(s.note, None);
    assert_eq!(o.own_unit.as_ref().map(|u| u.name.as_str()), Some("teleflock-hostd-4809-1794591303200.scope"), "forwarded commands move out of it");
}

#[test]
fn a_failed_scope_probe_leaves_teleflocks_unit_alone() {
    let sys = Recorder::new(cgroup_root_host());
    *sys.probe_ok.lock().unwrap() = false;
    let (o, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["probe System", "weights ssh.service", "weights tailscaled.service"], "the services still go up");
    assert_eq!(labels(&s), ["SSH server", "Tailscale"]);
    assert_eq!(o.own_unit, None, "forwarded commands start as always");
    assert_eq!(s.note.as_deref(), Some("TeleFlock stays at normal priority: systemd could not give the commands it starts a scope of their own"));
}

#[test]
fn a_successful_probe_counts_for_an_hour_and_a_failed_move_probes_again() {
    let sys = Recorder::new(cgroup_root_host());
    let mut state = State::default();
    let t0 = Instant::now();
    check(&sys, &Services::Untouched, &mut state, t0, false);
    check(&sys, &Services::Untouched, &mut state, t0 + Duration::from_secs(10 * 60), false);
    let probes = |calls: Vec<String>| calls.iter().filter(|c| c.starts_with("probe")).count();
    assert_eq!(probes(sys.calls()), 1, "a fresh probe is reused");
    check(&sys, &Services::Untouched, &mut state, t0 + Duration::from_secs(11 * 60), true);
    assert_eq!(probes(sys.calls()), 1, "after a failed move");
    check(&sys, &Services::Untouched, &mut state, t0 + Duration::from_secs(80 * 60), false);
    assert_eq!(probes(sys.calls()), 1, "an hour later");
    // A failed probe is redone at every check.
    *sys.probe_ok.lock().unwrap() = false;
    check(&sys, &Services::Untouched, &mut state, t0 + Duration::from_secs(150 * 60), false);
    check(&sys, &Services::Untouched, &mut state, t0 + Duration::from_secs(151 * 60), false);
    assert_eq!(probes(sys.calls()), 2);
}

#[test]
fn a_probe_that_starts_failing_puts_teleflocks_weights_back() {
    let sys = Recorder::new(cgroup_root_host());
    let mut state = State::default();
    let t0 = Instant::now();
    let (_, _, o) = check(&sys, &Services::Untouched, &mut state, t0, false);
    assert!(o.own_unit.is_some());
    *sys.probe_ok.lock().unwrap() = false;
    let (_, _, o) = check(&sys, &Services::Untouched, &mut state, t0 + Duration::from_secs(60), true);
    assert_eq!(sys.calls(), ["probe System", "weights teleflock-hostd-4809-1794591303200.scope", "probe System", "restore teleflock-hostd-4809-1794591303200.scope cpu Some(100) io Some(100)"]);
    assert_eq!(o.own_unit, None);
    assert!(!o.raised.contains(&Target::TeleFlock));
}

#[test]
fn a_herdr_server_in_teleflocks_own_cgroup_gets_nice_instead_of_weights() {
    let sys = Recorder::new(cgroup_root_host());
    let mut state = State::default();
    let (o, _) = run(&sys, &Services::Untouched, &mut state);
    assert!(o.own_unit.is_some());
    sys.calls();
    // herdr started directly (its scope failed): raising tf-hostd's unit would raise every agent.
    sys.facts.lock().unwrap().herdr_in_own_cgroup = true;
    let (o, s) = run(&sys, &Services::Untouched, &mut state);
    assert_eq!(sys.calls(), ["restore teleflock-hostd-4809-1794591303200.scope cpu Some(100) io Some(100)", "nice 4833"], "no probe: the unit is not raised");
    assert_eq!((o.own_unit, labels(&s)), (None, vec!["TeleFlock"]), "nice competes inside the shared cgroup");
    // Raised again later: what the first raise replaced is what goes back.
    sys.facts.lock().unwrap().herdr_in_own_cgroup = false;
    run(&sys, &Services::Untouched, &mut state);
    assert_eq!(sys.calls(), ["weights teleflock-hostd-4809-1794591303200.scope"], "the probe from before still counts");
}

#[test]
fn without_cgroup_weights_root_renices_every_process_and_its_autogroup() {
    let sys = Recorder::new(nice_host(true));
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["nice 500 +autogroup", "nice 109 +autogroup", "nice 93 +autogroup"]);
    assert_eq!(labels(&s), ["TeleFlock", "SSH server", "Tailscale"]);
}

#[test]
fn without_root_only_teleflock_itself_is_tried() {
    let sys = Recorder::new(nice_host(false)).denying(&["500"]);
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["nice 500 +autogroup"], "system services are never tried without root");
    assert!(s.raised.is_empty());
    assert_eq!(s.note.as_deref(), Some("needs root to raise TeleFlock, the SSH server and Tailscale"));
}

#[test]
fn a_user_raises_its_own_scope_in_its_user_manager_and_not_the_services() {
    let mut facts = cgroup_root_host();
    facts.privileged = false;
    facts.own = proc_in(4833, Manager::User, "/user.slice/user-1000.slice/user@1000.service/app.slice/teleflock-hostd-1-2.scope", true);
    let sys = Recorder::new(facts);
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["probe User", "weights teleflock-hostd-1-2.scope"]);
    assert_eq!(labels(&s), ["TeleFlock"]);
    assert_eq!(s.note.as_deref(), Some("needs root to raise the SSH server and Tailscale"));
}

#[test]
fn a_daemon_outside_its_own_scope_never_weighs_the_unit_it_is_in() {
    // Started by hand in a login session: that scope holds whatever the login runs.
    let mut facts = cgroup_root_host();
    facts.own = proc_in(4833, Manager::System, "/user.slice/user-0.slice/session-c11.scope", true);
    facts.services.clear();
    let sys = Recorder::new(facts);
    run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["nice 4833"]);
}

#[test]
fn services_outside_a_service_unit_are_reniced_never_weighed() {
    let mut facts = cgroup_root_host();
    facts.services = vec![
        (Target::Ssh, vec![proc_in(300, Manager::System, "/user.slice/user-0.slice/session-3.scope", true)]),
        (Target::Tailscale, vec![proc_in(301, Manager::System, "/init.scope", true)]),
    ];
    let sys = Recorder::new(facts);
    run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls()[2..], ["nice 300", "nice 301"]);
    // An sshd an agent started in a pane, gone to init as its parent: weighing its unit would
    // raise every agent of that herdr server.
    let mut facts = cgroup_root_host();
    facts.services = vec![(Target::Ssh, vec![proc_in(302, Manager::System, "/system.slice/teleflock-herdr-default-1-2.scope", true)])];
    let sys = Recorder::new(facts);
    run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls()[2..], ["nice 302"]);
}

#[test]
fn services_that_do_not_run_are_not_mentioned() {
    let mut facts = cgroup_root_host();
    facts.services = vec![(Target::Ssh, vec![proc_in(109, Manager::System, "/system.slice/ssh.service", true)]), (Target::Tailscale, vec![])];
    let sys = Recorder::new(facts);
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(labels(&s), ["TeleFlock", "SSH server"]);
    assert_eq!(s.note, None);
    // Not running and not root: nothing to say about them either.
    let mut facts = nice_host(false);
    facts.services = vec![(Target::Ssh, vec![]), (Target::Tailscale, vec![])];
    let (_, s) = run(&Recorder::new(facts), &Services::Discover, &mut State::default());
    assert_eq!((labels(&s), s.note.as_deref()), (vec!["TeleFlock"], None));
}

#[test]
fn only_the_real_home_touches_the_services_unless_a_lab_names_stand_ins() {
    assert_eq!(Services::from_env(true, None), Services::Discover);
    assert_eq!(Services::from_env(false, None), Services::Untouched, "a lab adjusts only itself");
    assert_eq!(Services::from_env(false, Some("")), Services::Untouched);
    assert_eq!(Services::from_env(true, Some("none")), Services::Untouched, "the real home can opt out");
    assert_eq!(
        Services::from_env(false, Some(" ssh=tf-lab-prio-ssh.scope, tailscale=tf-lab-prio-ts.service, bogus, x=y ")),
        Services::StandIns(vec![(Target::Ssh, "tf-lab-prio-ssh.scope".into()), (Target::Tailscale, "tf-lab-prio-ts.service".into())])
    );
    let sys = Recorder::new(cgroup_root_host());
    let (_, s) = run(&sys, &Services::Untouched, &mut State::default());
    assert_eq!(sys.calls(), ["probe System", "weights teleflock-hostd-4809-1794591303200.scope"]);
    assert_eq!(*sys.seen.lock().unwrap(), [Services::Untouched], "the lab never even looks for the services");
    assert_eq!(labels(&s), ["TeleFlock"]);
}

#[test]
fn a_stand_in_unit_is_weighed_like_the_service() {
    let mut facts = cgroup_root_host();
    facts.services = vec![(Target::Ssh, vec![proc_in(700, Manager::System, "/system.slice/tf-lab-prio-ssh.service", true)])];
    let sys = Recorder::new(facts);
    run(&sys, &Services::StandIns(vec![(Target::Ssh, "tf-lab-prio-ssh.service".into())]), &mut State::default());
    assert_eq!(sys.calls()[2..], ["weights tf-lab-prio-ssh.service"]);
}

#[test]
fn windows_raises_classes_and_names_administrator_rights() {
    let p = Proc::plain;
    let facts = Facts { os: Os::Windows, privileged: false, own: p(10), herdr_in_own_cgroup: false, services: vec![(Target::Ssh, vec![p(20), p(21)]), (Target::Tailscale, vec![p(30)])] };
    let sys = Recorder::new(facts.clone());
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["class 10"]);
    assert_eq!(labels(&s), ["TeleFlock"]);
    assert_eq!(s.note.as_deref(), Some("needs administrator rights to raise the SSH server and Tailscale"));
    // Elevated: every process; one refused sshd (another session's) leaves the SSH server raised.
    let sys = Recorder::new(Facts { privileged: true, ..facts }).denying(&["21"]);
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["class 10", "class 20", "class 21", "class 30"]);
    assert_eq!((labels(&s), s.note.as_deref()), (vec!["TeleFlock", "SSH server", "Tailscale"], None));
}

#[test]
fn a_refusal_as_root_is_the_systems_not_a_missing_right() {
    // A container without CAP_SYS_NICE refuses root too.
    let sys = Recorder::new(nice_host(true)).denying(&["500", "109", "93"]);
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert!(s.raised.is_empty());
    assert_eq!(s.note.as_deref(), Some("could not raise TeleFlock, the SSH server and Tailscale: the system does not permit it"));
}

#[test]
fn macos_renices_as_root() {
    let p = Proc::plain;
    let facts = Facts { os: Os::Macos, privileged: true, own: p(10), herdr_in_own_cgroup: false, services: vec![(Target::Ssh, vec![p(20)]), (Target::Tailscale, vec![])] };
    let sys = Recorder::new(facts);
    let (_, s) = run(&sys, &Services::Discover, &mut State::default());
    assert_eq!(sys.calls(), ["nice 10", "nice 20"]);
    assert_eq!(labels(&s), ["TeleFlock", "SSH server"]);
}

#[test]
fn errors_and_vanished_processes() {
    struct Failing;
    impl System for Failing {
        fn observe(&self, _: &Services) -> Facts {
            nice_host(true)
        }
        fn probe(&self, _: Manager) -> bool {
            false
        }
        fn raise_weights(&self, _: &Unit) -> Result<Replaced, Fail> {
            unreachable!()
        }
        fn restore_weights(&self, _: &Unit, _: &Replaced) -> Result<(), Fail> {
            unreachable!()
        }
        fn renice(&self, pid: u32, _: bool) -> Result<(), Fail> {
            match pid {
                109 => Err(Fail::Gone),
                93 => Err(Fail::Other("setpriority: I/O error\nmore".into())),
                _ => Ok(()),
            }
        }
        fn raise_class(&self, _: u32) -> Result<(), Fail> {
            unreachable!()
        }
        fn place(&self, _: Manager, _: &str, _: &str, _: u32) -> Result<(), Fail> {
            unreachable!()
        }
    }
    let (_, _, o) = check(&Failing, &Services::Discover, &mut State::default(), Instant::now(), false);
    let s = status(&o, Os::Linux, 7);
    assert_eq!(labels(&s), ["TeleFlock"], "sshd restarting right now: found again at the next check");
    assert_eq!(s.note.as_deref(), Some("could not raise Tailscale: setpriority: I/O error"));
    assert_eq!(s.checked_at, 7);
}

#[test]
fn notes_read_as_sentences() {
    assert_eq!(and_list(&["the SSH server"]), "the SSH server");
    assert_eq!(and_list(&["the SSH server", "Tailscale"]), "the SSH server and Tailscale");
    assert_eq!(and_list(&["TeleFlock", "the SSH server", "Tailscale"]), "TeleFlock, the SSH server and Tailscale");
    let o = Outcome { raised: BTreeSet::from([Target::TeleFlock, Target::Tailscale]), not: BTreeMap::from([(Target::Ssh, Why::NeedsRoot)]), own_unit: None };
    assert_eq!(note(&o, Os::Linux).as_deref(), Some("needs root to raise the SSH server"));
    assert_eq!(clip(&"x".repeat(200), 160).chars().count(), 161);
}

#[test]
fn the_log_line_says_how_without_pids() {
    let sys = Recorder::new(cgroup_root_host());
    let mut state = State::default();
    let (facts, plan, o) = check(&sys, &Services::Discover, &mut state, Instant::now(), false);
    let s = status(&o, facts.os, 1);
    assert_eq!(
        summary(&plan, &o, &s),
        "raised TeleFlock (weights 1000 on teleflock-hostd-4809-1794591303200.scope); SSH server (weights 1000 on ssh.service); Tailscale (weights 1000 on tailscaled.service)"
    );
    // The probe starts failing: the weights go back, and the line says so once.
    *sys.probe_ok.lock().unwrap() = false;
    let (facts, plan, o) = check(&sys, &Services::Untouched, &mut state, Instant::now(), true);
    let s = status(&o, facts.os, 2);
    assert_eq!(
        summary(&plan, &o, &s),
        "nothing raised; tf-hostd's own weights on teleflock-hostd-4809-1794591303200.scope put back; TeleFlock stays at normal priority: systemd could not give the commands it starts a scope of their own"
    );
    // Per-connection processes come and go: the line names how, not which.
    let p = |pid| Proc { pid, unit: None, weights: false, autogroup: true };
    let mut facts = nice_host(true);
    facts.services[0].1 = vec![p(109), p(2001), p(2002)];
    let (facts, plan, o) = check(&Recorder::new(facts), &Services::Discover, &mut State::default(), Instant::now(), false);
    assert_eq!(
        summary(&plan, &o, &status(&o, facts.os, 3)),
        "raised TeleFlock (nice -10 with its autogroup); SSH server (nice -10 with its autogroup); Tailscale (nice -10 with its autogroup)"
    );
}

/// Forwarded commands get a gate only while tf-hostd's own unit carries raised weights; the gate
/// moves the held process into a fresh `teleflock-forward-…` scope of that unit's manager.
#[cfg(target_os = "linux")]
#[test]
fn forwarded_commands_move_out_only_while_teleflocks_unit_is_raised() {
    use std::os::unix::process::CommandExt;
    let sys = Arc::new(Recorder::new(cgroup_root_host()));
    assert!(gate_for(None, sys.clone()).is_none(), "not raised: they start as always");
    let gate = gate_for(Some(Manager::User), sys.clone()).expect("a gate while raised");
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args(["-c", "exit 7"]);
    let mut held = gate.wrap(&cmd);
    let fd = gate.child_fd();
    // SAFETY: dup2 and fcntl are async-signal-safe.
    unsafe { held.pre_exec(move || work::keep(fd)) };
    let mut child = held.spawn().unwrap();
    let pid = child.id();
    gate.go(Some(pid)).unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(7));
    let calls = sys.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(calls[0].starts_with(&format!("place {pid} User teleflock-forward-")) && calls[0].ends_with(".scope"), "{calls:?}");
}

/// `HostInfo.priority` stays as the worker published it: `follow` sets it while the context is
/// created, before `state::start` takes the first host facts (`adopt_first_info`), and later
/// probes come through `set_info`; both get facts without it (the lab caught the first one).
#[cfg(unix)]
#[tokio::test]
async fn the_published_status_survives_the_first_probe_and_later_ones() {
    let dir = tempfile::tempdir().unwrap();
    let persist = crate::state::persist::Persist::load(dir.path().join("state.json"));
    let cancel = CancellationToken::new();
    cancel.cancel();
    let bridge = crate::bridge::BridgeHandle::bind(crate::bridge::BridgeEndpoint::Unix(dir.path().join("bridge.sock")), "s".into()).unwrap();
    let omp = crate::omp::OmpHandle::start(0, persist.clone(), cancel, bridge.clone()).await;
    let h = crate::state::StateHandle::new("lab", persist, omp, bridge);
    let status = PriorityStatus { raised: vec!["TeleFlock".into(), "SSH server".into()], note: Some("needs root to raise Tailscale".into()), checked_at: 5 };
    h.set_priority(Some(status.clone()));
    let probed = |hostname: &str| {
        let mut info = h.snapshot().info;
        info.priority = None;
        info.hostname = hostname.into();
        info
    };
    h.adopt_first_info(probed("first"));
    let info = h.snapshot().info;
    assert_eq!((info.hostname.as_str(), info.priority.as_ref()), ("first", Some(&status)), "the first probe");
    h.set_info(probed("reprobed"));
    let info = h.snapshot().info;
    assert_eq!((info.hostname.as_str(), info.priority), ("reprobed", Some(status)), "a later probe");
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::system::linux::*;
    use super::*;

    #[test]
    fn units_from_cgroup_paths() {
        assert_eq!(unit_of("/system.slice/ssh.service"), Some(unit(Manager::System, "/system.slice/ssh.service")));
        assert_eq!(unit_of(OWN), Some(unit(Manager::System, OWN)));
        let user = "/user.slice/user-1000.slice/user@1000.service/app.slice/teleflock-hostd-1-2.scope";
        assert_eq!(unit_of(user), Some(unit(Manager::User, user)));
        assert_eq!(unit_of("/user.slice/user-0.slice/session-c11.scope").map(|u| (u.manager, u.name)), Some((Manager::System, "session-c11.scope".into())));
        // A sub-cgroup inside a unit (delegation): the unit it belongs to.
        assert_eq!(unit_of("/system.slice/docker-1.scope/init").map(|u| u.cgroup), Some("/system.slice/docker-1.scope".into()));
        assert_eq!(unit_of("/"), None);
        assert_eq!(unit_of("/user.slice"), None);
    }

    #[test]
    fn root_cpu_group_decides_whether_autogroups_compete() {
        let v2 = "0::/system.slice/ssh.service\n";
        assert!(!in_root_cpu_group(v2, true, true), "a cgroup with CPU control");
        assert!(in_root_cpu_group(v2, true, false), "no CPU controller below the root");
        assert!(in_root_cpu_group("0::/\n", true, true), "the root cgroup itself");
        let v1 = "5:cpu,cpuacct:/\n1:name=systemd:/system.slice/ssh.service\n";
        assert!(in_root_cpu_group(v1, false, false));
        assert!(!in_root_cpu_group(&v1.replace("cpuacct:/", "cpuacct:/system.slice"), false, false));
        assert!(in_root_cpu_group("1:name=systemd:/x\n", false, false), "no cpu hierarchy");
    }

    #[test]
    fn proc_files() {
        let stat = "4242 (my (odd) prog) S 1 4242 4242 0 -1 4194560 1503 0 0 0 10 5 0 0 20 -10 3 0 98765";
        assert_eq!(parse_stat(stat), Some(("my (odd) prog", 1, -10)));
        assert_eq!(parse_stat("garbage"), None);
        assert_eq!(autogroup_nice("/autogroup-3120693 nice 0\n"), Some(0));
        assert_eq!(autogroup_nice("/autogroup-1 nice -10\n"), Some(-10));
        assert_eq!(io_weight("default 100\n8:0 200\n"), Some(100));
        assert_eq!(io_weight(""), None);
        assert!(is_server_cmdline(b"herdr\0--session\0tf-lab\0server\0"));
        assert!(is_server_cmdline(b"/usr/local/bin/herdr\0server\0"));
        assert!(!is_server_cmdline(b"herdr\0status\0--json\0"));
        assert!(!is_server_cmdline(b"herdr\0terminal\0session\0control\0p1\0"));
    }

    #[test]
    fn services_are_the_processes_init_started() {
        let table = vec![
            (109, "sshd".to_string(), 1),
            (2000, "sshd".to_string(), 109),
            (2001, "sshd-session".to_string(), 109),
            (93, "tailscaled".to_string(), 1),
            (206005, "tailscaled".to_string(), 93),
            // A container's sshd: its parent is the container's init.
            (5000, "sshd".to_string(), 4999),
        ];
        assert_eq!(started_by_init(&table, "sshd"), [109]);
        assert_eq!(started_by_init(&table, "tailscaled"), [93]);
        assert_eq!(started_by_init(&table, "dropbear"), Vec::<u32>::new());
    }

    /// The real observation of this host is read-only: whatever it finds, it changes nothing.
    #[test]
    fn observing_this_host_reads_only() {
        let facts = observe(&Services::Untouched);
        assert_eq!(facts.own.pid, std::process::id());
        assert!(facts.services.is_empty());
    }
}
