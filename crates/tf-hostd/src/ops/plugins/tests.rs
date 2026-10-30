use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tf_proto::{InstallScope, Marketplace, PluginList, RegistrySkill, SkillList};

use super::*;

/// A stand-in omp (a shell script): the helper protocol when run with `-e` (it keeps a copy of the
/// request as `<answer file>.req`), else `cli` for CLI runs (recording its cwd and arguments).
fn fake_omp(dir: &Path, result: &str, cli: &str) -> PathBuf {
    let p = dir.join("omp");
    crate::test_exe::write_exe(
        &p,
        format!(
            "#!/bin/sh\ncase \"$*\" in *-e*teleflock-plugins.ts*)\n  cp \"$TF_PLUGINS_IN\" \"$TF_PLUGINS_OUT.req\"; rm -f \"$TF_PLUGINS_IN\"\n  printf '{{\"t\":\"hello\",\"ompVersion\":\"18.13.3\"}}\\n' >> \"$TF_PLUGINS_OUT\"\n  cat <<'EOF' >> \"$TF_PLUGINS_OUT\"\n{result}\nEOF\n  exit 0;;\nesac\npwd > \"$0.cwd\"; echo \"$*\" > \"$0.args\"\n{cli}\n"
        ),
    );
    p
}

fn at(dir: &Path, omp: PathBuf) -> Plugins {
    Plugins {
        helper: HelperEnv { spec: &HELPER, omp: Some(omp), ext_dir: dir.join("ext"), run_dir: dir.join("run"), agent_dir: None, slots: Slots::new(2, 1) },
        agent_dir: dir.join("agent"),
        neutral: dir.join("neutral"),
    }
}

fn registry(id: &str, version: &str) -> RegistrySkill {
    RegistrySkill {
        id: id.into(),
        scope: InstallScope::User,
        range: Some("^1.0.0".into()),
        version: Some(version.into()),
        stored: true,
        update: None,
        latest: None,
        description: None,
        deprecated: None,
        yanked: false,
        update_error: None,
    }
}

fn plain(entries: Vec<RegistrySkill>) -> SkillList {
    serde_json::from_value(json!({"skills": [], "registryUrl": "https://skills.omp.sh", "registry": entries})).unwrap()
}

/// The request the fake helper read.
fn request_copy(dir: &Path) -> Value {
    let copy = std::fs::read_dir(dir.join("run")).unwrap().filter_map(|e| e.ok()).find(|e| e.file_name().to_string_lossy().ends_with(".req")).unwrap();
    serde_json::from_str(&std::fs::read_to_string(copy.path()).unwrap()).unwrap()
}

#[tokio::test]
async fn skill_lists_come_from_the_helper_with_cached_update_checks() {
    let td = tempfile::tempdir().unwrap();
    let answer = r#"{"t":"result","skills":[{"name":"pdf","description":"PDFs","path":"/s/pdf/SKILL.md","provider":"skillshare","providerName":"Skill Registry","level":"user","registryId":"@alice/pdf","enabled":false,"hidden":false}],"registry":[{"id":"@alice/pdf","scope":"user","range":"^1.0.0","version":"1.0.0","stored":true,"update":"1.1.0","latest":"2.0.0","yanked":false}],"warnings":[],"registryUrl":"https://skills.omp.sh","updatesCheckedAt":1700000000000}"#;
    let pl = at(td.path(), fake_omp(td.path(), answer, "exit 0"));
    let list = skills::list(&pl, None, true).await.unwrap();
    assert_eq!((list.omp_version.as_deref(), list.skills[0].enabled, list.cwd.as_deref()), (Some("18.13.3"), false, None));
    assert_eq!(list.registry[0].update.as_deref(), Some("1.1.0"));
    let req = request_copy(td.path());
    assert_eq!((req["op"].as_str(), req["updates"].as_bool(), req["project"].as_bool()), (Some("skills"), Some(true), Some(false)));
    assert_eq!(req["agentDir"].as_str(), pl.agent_dir.to_str());

    // A plain list gets the last check's findings for installs whose version is unchanged …
    let mut later = plain(vec![registry("@alice/pdf", "1.0.0"), registry("@bob/new", "1.0.0")]);
    skills::merge_check(&mut later, &(1_700_000_000_000, list.registry.clone()));
    assert_eq!((later.registry[0].latest.as_deref(), later.registry[1].latest.as_deref()), (Some("2.0.0"), None));
    assert_eq!(later.updates_checked_at, Some(1_700_000_000_000));
    // … not for one that was updated since; the check's time stays the folder's.
    let mut moved = plain(vec![registry("@alice/pdf", "1.1.0")]);
    skills::merge_check(&mut moved, &(1, list.registry));
    assert_eq!((moved.registry[0].update.as_deref(), moved.updates_checked_at), (None, Some(1)));
    // Nothing installed: the check still ran.
    let mut empty = plain(vec![]);
    skills::merge_check(&mut empty, &(2, vec![]));
    assert_eq!(empty.updates_checked_at, Some(2));
}

#[tokio::test]
async fn plugin_lists_are_asked_for_the_project() {
    let td = tempfile::tempdir().unwrap();
    let project = td.path().join("proj");
    std::fs::create_dir(&project).unwrap();
    let pl = at(td.path(), fake_omp(td.path(), r#"{"t":"result","packages":[],"marketplace":[],"marketplaces":[]}"#, "exit 0"));
    let list = packages::list(&pl, Some(&project)).await.unwrap();
    assert_eq!(list.cwd.as_deref(), project.to_str());
    let req = request_copy(td.path());
    assert_eq!((req["op"].as_str(), req["project"].as_bool(), req["v"].as_u64()), (Some("plugins"), Some(true), Some(1)));
    assert!(req["deadlineAt"].as_i64().is_some());
}

#[tokio::test]
async fn changes_run_omps_cli_in_the_right_folder_and_report_its_words() {
    let td = tempfile::tempdir().unwrap();
    let omp = fake_omp(td.path(), "", "echo '✗ Failed to install foo@bar: Error: Plugin \"foo\" not found in marketplace \"bar\"' >&2; exit 1");
    let pl = at(td.path(), omp.clone());
    let neutral = pl.cwd_for(None).unwrap();
    let err = apply(&pl, &neutral, &["plugin", "install", "foo@bar"], Duration::from_secs(20), cli::plugin_failure).await.unwrap_err();
    assert_eq!(err.code, "not_found");
    assert_eq!(std::fs::read_to_string(format!("{}.args", omp.display())).unwrap().trim(), "plugin install foo@bar");
    assert_eq!(std::fs::read_to_string(format!("{}.cwd", omp.display())).unwrap().trim(), neutral.to_str().unwrap(), "user-level changes run in no project");

    let pl = at(td.path(), fake_omp(td.path(), "", "echo '+ @alice/pdf@1.0.0'; echo 'Saved /a/skills.json'"));
    let out = apply(&pl, td.path(), &["skill", "install", "@alice/pdf", "-g"], Duration::from_secs(20), cli::skill_failure).await.unwrap();
    assert_eq!(cli::changes(&out), ["+ @alice/pdf@1.0.0"]);
}

#[test]
fn skill_switches_edit_disabled_extensions() {
    let cur = vec![json!("skill:a"), json!("ext:x")];
    assert_eq!(skills::switched(&cur, "b", false).unwrap(), vec![json!("skill:a"), json!("ext:x"), json!("skill:b")]);
    assert!(skills::switched(&cur, "a", false).is_none(), "already off");
    assert_eq!(skills::switched(&cur, "a", true).unwrap(), vec![json!("ext:x")]);
    assert!(skills::switched(&cur, "b", true).is_none(), "already on");
    // A namespaced skill is off by its bare name too.
    assert_eq!(skills::switched(&cur, "team/a", true).unwrap(), vec![json!("ext:x")]);
}

#[test]
fn marketplace_plugins_are_told_from_packages() {
    let list = PluginList {
        packages: vec![],
        marketplace: vec![],
        marketplaces: vec![Marketplace {
            name: "claude-plugins-official".into(),
            source_type: "github".into(),
            source: "anthropics/claude-plugins-official".into(),
            description: None,
            owner: None,
            plugins: 3,
            updated_at: None,
            error: None,
        }],
        cwd: None,
        warnings: vec![],
        omp_version: None,
    };
    assert!(packages::is_marketplace_plugin("review@claude-plugins-official", &list));
    assert!(!packages::is_marketplace_plugin("@scope/pkg@1.2.0", &list), "an npm spec with a version");
    assert!(!packages::is_marketplace_plugin("github:me/plugin", &list));
}
