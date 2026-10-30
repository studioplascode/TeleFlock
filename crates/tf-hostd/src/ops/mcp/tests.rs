use std::path::{Path, PathBuf};

use super::*;
use tf_proto::McpKeyValue;

fn mcp_at(dir: &Path, omp: Option<PathBuf>) -> Mcp {
    Mcp {
        agent_dir: dir.join("agent"),
        helper: HelperEnv { spec: &helper::MCP, omp, ext_dir: dir.join("ext"), run_dir: dir.join("run"), agent_dir: None, slots: helper::Slots::new(4, 2) },
        neutral: dir.join("neutral"),
    }
}

fn stdio(command: &str, args: &[&str], env: &[(&str, &str)]) -> McpServerDraft {
    McpServerDraft {
        transport: McpTransport::Stdio,
        command: Some(command.into()),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: None,
        env: env.iter().map(|(k, v)| McpKeyValue { key: k.to_string(), value: v.to_string(), secret: false }).collect(),
        url: None,
        headers: vec![],
        timeout_ms: None,
        oauth: None,
    }
}

fn http(url: &str) -> McpServerDraft {
    McpServerDraft { transport: McpTransport::Http, command: None, args: vec![], cwd: None, env: vec![], url: Some(url.into()), headers: vec![], timeout_ms: None, oauth: None }
}

fn save_params(scope: McpScope, cwd: Option<&Path>, name: &str, prev: Option<&str>, server: McpServerDraft) -> McpSaveParams {
    McpSaveParams { scope, cwd: cwd.map(|p| p.display().to_string()), name: name.into(), previous_name: prev.map(str::to_string), server, enabled: None }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn add_edit_rename_remove_round_trip_in_omps_format() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    let user = mcp.user_file();
    save_files(&mcp, &save_params(McpScope::User, None, "fs", None, stdio("npx", &["-y", "@modelcontextprotocol/server-filesystem", "/srv/My Docs"], &[("API_KEY", "sk-123")])))
        .await
        .unwrap();
    save_files(&mcp, &save_params(McpScope::User, None, "docs", None, http("https://mcp.context7.com/mcp"))).await.unwrap();
    assert_eq!(
        read(&user),
        format!(
            "{{\n  \"$schema\": \"{}\",\n  \"mcpServers\": {{\n    \"fs\": {{\n      \"type\": \"stdio\",\n      \"command\": \"npx\",\n      \"args\": [\n        \"-y\",\n        \"@modelcontextprotocol/server-filesystem\",\n        \"/srv/My Docs\"\n      ],\n      \"env\": {{\n        \"API_KEY\": \"sk-123\"\n      }}\n    }},\n    \"docs\": {{\n      \"type\": \"http\",\n      \"url\": \"https://mcp.context7.com/mcp\"\n    }}\n  }}\n}}",
            files::SCHEMA_URL
        )
    );
    let dup = save_files(&mcp, &save_params(McpScope::User, None, "docs", None, http("https://x.dev/mcp"))).await.unwrap_err();
    assert_eq!(dup.code, "already_exists");

    // Edit as the app does: the listed (masked) definition comes back with one change.
    let list = list_with(&mcp, None, false, 0, 0).await.unwrap();
    let fs = list.servers.iter().find(|s| s.name == "fs").unwrap();
    assert_eq!(fs.server.env[0].value, secrets::MASK, "secret never listed");
    assert!(!serde_json::to_string(&list).unwrap().contains("sk-123"));
    let mut draft = fs.server.clone();
    draft.args[2] = "/srv/other".into();
    save_files(&mcp, &save_params(McpScope::User, None, "files", Some("fs"), draft)).await.unwrap();
    let J::Obj(root) = json::parse(&read(&user)).unwrap() else { panic!() };
    let servers = root.obj("mcpServers").unwrap();
    assert_eq!(servers.keys().collect::<Vec<_>>(), ["files", "docs"], "renamed in place");
    assert_eq!(servers.obj("files").unwrap().obj("env").unwrap().str("API_KEY"), Some("sk-123"), "hidden value kept");

    remove_files(&mcp, &McpServerRef { cwd: None, name: "docs".into(), scope: None }).await.unwrap();
    assert_eq!(remove_files(&mcp, &McpServerRef { cwd: None, name: "docs".into(), scope: None }).await.unwrap_err().code, "not_found");
    assert!(!read(&user).contains("\"docs\""));
}

#[tokio::test]
async fn project_scope_writes_the_folders_omp_file() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    let proj = td.path().join("repo");
    std::fs::create_dir_all(&proj).unwrap();
    let err = save_files(&mcp, &save_params(McpScope::Project, None, "db", None, stdio("uvx", &["mcp-server-sqlite"], &[]))).await.unwrap_err();
    assert_eq!(err.code, "invalid_params", "project needs a folder");
    save_files(&mcp, &save_params(McpScope::Project, Some(&proj), "db", None, stdio("uvx", &["mcp-server-sqlite"], &[]))).await.unwrap();
    let real = std::fs::canonicalize(&proj).unwrap();
    assert!(read(&real.join(".omp").join("mcp.json")).contains("mcp-server-sqlite"));
    // A same-named user server is listed but shadowed by the project's.
    save_files(&mcp, &save_params(McpScope::User, None, "db", None, stdio("other", &[], &[]))).await.unwrap();
    let list = list_with(&mcp, Some(real.clone()), false, 0, 0).await.unwrap();
    let rows: Vec<_> = list.servers.iter().map(|s| (s.name.as_str(), s.origin, s.shadowed)).collect();
    assert_eq!(rows, [("db", McpOrigin::Project, false), ("db", McpOrigin::User, true)]);
    assert_eq!(list.project_path.as_deref(), Some(&*real.join(".omp").join("mcp.json").to_string_lossy()));
}

#[tokio::test]
async fn enabling_follows_omps_set_mcp_server_enabled() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    let user = mcp.user_file();
    save_files(&mcp, &save_params(McpScope::User, None, "docs", None, http("https://x.dev/mcp"))).await.unwrap();
    let switch = |name: &str, enabled: bool| McpEnableParams { cwd: None, name: name.into(), scope: None, enabled };

    // Own definition: the entry's flag (omp writes `true` back explicitly).
    set_enabled_files(&mcp, &switch("docs", false)).await.unwrap();
    assert!(read(&user).contains("\"enabled\": false"));
    set_enabled_files(&mcp, &switch("docs", true)).await.unwrap();
    assert!(read(&user).contains("\"enabled\": true"));
    assert!(!read(&user).contains("disabledServers") && !read(&user).contains("enabledServers"));

    // Another tool's server: the user-level lists, sorted, dropped when empty.
    set_enabled_files(&mcp, &switch("zeta", false)).await.unwrap();
    set_enabled_files(&mcp, &switch("claude-linear", false)).await.unwrap();
    let J::Obj(root) = json::parse(&read(&user)).unwrap() else { panic!() };
    assert_eq!(json::compact(root.get("disabledServers").unwrap()), r#"["claude-linear","zeta"]"#);
    set_enabled_files(&mcp, &switch("zeta", true)).await.unwrap();
    let J::Obj(root) = json::parse(&read(&user)).unwrap() else { panic!() };
    assert_eq!(json::compact(root.get("disabledServers").unwrap()), r#"["claude-linear"]"#);
    assert_eq!(json::compact(root.get("enabledServers").unwrap()), r#"["zeta"]"#, "force-enabled over its source's enabled:false");
    // Disabling clears the force-enable again.
    set_enabled_files(&mcp, &switch("zeta", false)).await.unwrap();
    let J::Obj(root) = json::parse(&read(&user)).unwrap() else { panic!() };
    assert!(root.get("enabledServers").is_none());

    // A stale denylist entry no longer hides a re-enabled own server.
    files::modify(&user, |r| {
        set_in_list(r, "disabledServers", "docs", true);
        Ok(())
    })
    .unwrap();
    let list = list_with(&mcp, None, false, 0, 0).await.unwrap();
    assert!(!list.servers.iter().find(|s| s.name == "docs").unwrap().enabled, "the denylist wins");
    set_enabled_files(&mcp, &switch("docs", true)).await.unwrap();
    let list = list_with(&mcp, None, false, 0, 0).await.unwrap();
    assert!(list.servers.iter().find(|s| s.name == "docs").unwrap().enabled);
}

#[tokio::test]
async fn a_rename_carries_list_entries_along() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    save_files(&mcp, &save_params(McpScope::User, None, "a", None, http("https://x.dev/mcp"))).await.unwrap();
    files::modify(&mcp.user_file(), |r| {
        set_in_list(r, "enabledServers", "a", true);
        Ok(())
    })
    .unwrap();
    save_files(&mcp, &save_params(McpScope::User, None, "b", Some("a"), http("https://x.dev/mcp"))).await.unwrap();
    assert!(read(&mcp.user_file()).contains("\"enabledServers\": [\n    \"b\"\n  ]"));
}

#[tokio::test]
async fn unreadable_files_are_reported_and_left_alone() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    std::fs::create_dir_all(&mcp.agent_dir).unwrap();
    std::fs::write(mcp.user_file(), "{ \"mcpServers\": { \"a\": {} }, }").unwrap();
    let list = list_with(&mcp, None, false, 0, 0).await.unwrap();
    assert_eq!(list.file_errors.len(), 1);
    assert_eq!(list.file_errors[0].path, mcp.user_file().display().to_string());
    let err = save_files(&mcp, &save_params(McpScope::User, None, "b", None, http("https://x.dev/mcp"))).await.unwrap_err();
    assert_eq!(err.code, "invalid_params");
    assert!(read(&mcp.user_file()).ends_with("}, }"), "untouched");
}

/// A stand-in omp for the helper's `probe`: logs each request and answers `answer`.
#[cfg(unix)]
fn fake_omp(dir: &Path, answer: &str) -> (PathBuf, PathBuf) {
    let log = dir.join("requests.log");
    let ans = dir.join("answer.json");
    std::fs::write(&ans, format!("{answer}\n")).unwrap();
    let p = dir.join("omp");
    crate::test_exe::write_exe(
        &p,
        format!(
            "#!/bin/sh\ncat \"$TF_MCP_IN\" >> {log}; echo >> {log}; rm -f \"$TF_MCP_IN\"\nprintf '{{\"t\":\"hello\",\"ompVersion\":\"18.13.2\"}}\\n' >> \"$TF_MCP_OUT\"\nsleep 0.2\ncat {ans} >> \"$TF_MCP_OUT\"\n",
            log = log.display(),
            ans = ans.display()
        ),
    );
    (p, log)
}

#[cfg(unix)]
fn requests(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[cfg(unix)]
#[tokio::test]
async fn checks_run_once_then_only_for_changed_servers() {
    let td = tempfile::tempdir().unwrap();
    let agent = td.path().join("agent");
    let user = agent.join("mcp.json").display().to_string();
    let answer = json!({ "t": "result", "servers": [
        { "name": "docs", "provider": "native", "path": user, "enabled": true, "status": "connected",
          "tools": [{ "name": "resolve-library-id", "description": "Find a library" }, { "name": "get-library-docs" }],
          "serverInfo": { "name": "Context7", "version": "1.0.13" } },
        { "name": "gh", "provider": "native", "path": user, "enabled": true, "status": "needsAuth", "authType": "oauth", "error": "HTTP 401" },
        { "name": "linear", "provider": "claude", "providerName": "Claude Code", "path": "/home/me/.claude.json", "enabled": false, "entryEnabled": false,
          "status": "disabled", "config": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_secret" } } }
    ]});
    let (omp, log) = fake_omp(td.path(), &answer.to_string());
    let mcp = mcp_at(td.path(), Some(omp));
    save_files(&mcp, &save_params(McpScope::User, None, "docs", None, http("https://mcp.context7.com/mcp"))).await.unwrap();
    save_files(&mcp, &save_params(McpScope::User, None, "gh", None, http("https://api.example.com/mcp"))).await.unwrap();

    let first = list_with(&mcp, None, false, 0, 0).await.unwrap();
    assert!(first.check.running);
    assert!(first.servers.iter().all(|s| s.status == McpStatus::Checking), "no earlier result: checking");
    let done = list_with(&mcp, None, false, 10_000, 3).await.unwrap();
    assert!(!done.check.running);
    assert_eq!(done.omp_version.as_deref(), Some("18.13.2"));
    assert_eq!(done.live_sessions, 3);
    let by = |l: &McpList, n: &str| l.servers.iter().find(|s| s.name == n).cloned().unwrap();
    let docs = by(&done, "docs");
    assert_eq!((docs.status, docs.tools.len()), (McpStatus::Connected, 2));
    assert_eq!(docs.server_info.unwrap().version.as_deref(), Some("1.0.13"));
    assert_eq!(by(&done, "gh").status, McpStatus::NeedsAuth);
    let linear = by(&done, "linear");
    assert_eq!((linear.origin, linear.status, linear.source_label.as_deref()), (McpOrigin::Imported, McpStatus::Disabled, Some("Claude Code")));
    assert_eq!(linear.server.headers[0].value, secrets::MASK);
    assert!(!serde_json::to_string(&done).unwrap().contains("lin_secret"), "other tools' secrets are masked too");
    assert_eq!(requests(&log).len(), 1);

    // Nothing changed: no new check.
    list_with(&mcp, None, false, 0, 0).await.unwrap();
    assert_eq!(requests(&log).len(), 1);

    // One server edited: only it is checked again; the other keeps its result meanwhile.
    save_files(&mcp, &save_params(McpScope::User, None, "gh", Some("gh"), http("https://api.example.com/v2/mcp"))).await.unwrap();
    let during = list_with(&mcp, None, false, 0, 0).await.unwrap();
    assert_eq!(by(&during, "gh").status, McpStatus::Checking);
    assert_eq!(by(&during, "docs").status, McpStatus::Connected);
    list_with(&mcp, None, false, 10_000, 0).await.unwrap();
    let reqs = requests(&log);
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[1]["only"], json!(["gh"]));
    assert_eq!((reqs[1]["op"].as_str(), reqs[1]["v"].as_u64()), (Some("probe"), Some(1)));

    // Signed in elsewhere (definition unchanged): marked dirty, checked again.
    mark_dirty(&mcp.neutral, "docs");
    list_with(&mcp, None, false, 10_000, 0).await.unwrap();
    assert_eq!(requests(&log).last().unwrap()["only"], json!(["docs"]));

    // `refresh` checks everything.
    list_with(&mcp, None, true, 10_000, 0).await.unwrap();
    assert_eq!(requests(&log).last().unwrap()["only"], Value::Null);
}

#[cfg(unix)]
#[tokio::test]
async fn a_failing_helper_is_reported_and_not_hammered() {
    let td = tempfile::tempdir().unwrap();
    let (omp, log) = fake_omp(td.path(), r#"{"t":"error","code":"unsupported","message":"omp 18.0.0 lacks mcp/manager"}"#);
    let mcp = mcp_at(td.path(), Some(omp));
    save_files(&mcp, &save_params(McpScope::User, None, "docs", None, http("https://x.dev/mcp"))).await.unwrap();
    let l = list_with(&mcp, None, false, 10_000, 0).await.unwrap();
    assert!(l.check.error.as_deref().unwrap().contains("lacks mcp/manager"));
    assert_eq!(l.servers[0].status, McpStatus::Unknown);
    for _ in 0..3 {
        list_with(&mcp, None, false, 0, 0).await.unwrap();
    }
    assert_eq!(requests(&log).len(), 1, "retried at most every 30 s unless refreshed");
    list_with(&mcp, None, true, 10_000, 0).await.unwrap();
    assert_eq!(requests(&log).len(), 2);
}

#[test]
fn registry_answers_become_drafts_with_inputs() {
    let v = json!({
        "id": "abc", "name": "acme/search", "title": "Acme Search", "useCount": 42, "verified": true, "remote": false,
        "config": { "type": "stdio", "command": "bunx", "args": ["-y", "@smithery/cli", "run", "@acme/search", "--config", "{}"] },
        "inputs": [{ "key": "apiKey", "label": "apiKey", "type": "string", "required": true, "sensitive": true },
                   { "key": "region", "label": "region", "type": "string", "required": false, "enumValues": ["eu", "us"] }],
        "warnings": ["Runs through Smithery CLI at runtime"], "tools": [{ "name": "search", "description": "Search" }]
    });
    let e = registry_entry(&v).unwrap();
    assert_eq!((e.name.as_str(), e.use_count, e.verified), ("acme/search", 42, true));
    assert_eq!(e.server.args.last().map(String::as_str), Some("{}"));
    assert!(e.inputs[0].secret && e.inputs[0].required);
    assert_eq!(e.inputs[1].choices, ["eu", "us"]);
    assert_eq!(e.tools[0].name, "search");
}

#[test]
fn folders_must_be_absolute_existing_directories() {
    assert_eq!(folder(Some("relative/x")).unwrap_err().code, "invalid_params");
    assert_eq!(folder(Some("/definitely/not/here")).unwrap_err().code, "not_found");
    assert_eq!(folder(Some("  ")).unwrap(), None);
    let td = tempfile::tempdir().unwrap();
    assert_eq!(folder(Some(&td.path().display().to_string())).unwrap(), Some(std::fs::canonicalize(td.path()).unwrap()));
}

/// Against the real omp (isolated agent dir): the helper's checks, test and sign-out, and the
/// config lock shared with omp's own writer. `cargo test -p tf-hostd mcp_real -- --ignored --nocapture`
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore]
async fn mcp_real_omp_helper() {
    let Some(omp) = omp_bin() else {
        eprintln!("omp not installed: skipped");
        return;
    };
    let td = tempfile::tempdir().unwrap();
    let mut mcp = mcp_at(td.path(), Some(omp));
    mcp.helper.agent_dir = Some(mcp.agent_dir.clone());
    std::fs::create_dir_all(&mcp.agent_dir).unwrap();
    let server = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/ops/mcp/testdata/stdio_server.py");
    save_files(&mcp, &save_params(McpScope::User, None, "lab", None, stdio("python3", &[&server.display().to_string()], &[("LAB_TOKEN", "t0p-secret")])))
        .await
        .unwrap();
    // Held by us, omp's writer must wait: its lock name is ours.
    let held = files::OmpFileLock::acquire(&mcp.user_file()).unwrap();
    let probe = r#"import * as u from "@oh-my-pi/pi-utils"; export default async function (pi) { const l = u.tryAcquireFileLock?.(process.env.F); require("fs").writeFileSync(process.env.O, l ? "free" : "held"); l?.release(); setTimeout(() => process.exit(0), 0); }"#;
    let ext = td.path().join("lockprobe.ts");
    std::fs::write(&ext, probe).unwrap();
    let out = td.path().join("lock.out");
    let status = std::process::Command::new(mcp.helper.omp.as_ref().unwrap())
        .args(["--mode", "rpc", "--no-session", "--no-extensions", "--no-tools", "-e"])
        .arg(&ext)
        .env("PI_CODING_AGENT_DIR", &mcp.agent_dir)
        .env("F", mcp.user_file())
        .env("O", &out)
        .stdin(std::process::Stdio::null())
        .status()
        .unwrap();
    eprintln!("lock probe exit: {status}");
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "held", "omp sees the lock tf-hostd holds");
    drop(held);

    let list = list_with(&mcp, None, false, 25_000, 0).await.unwrap();
    eprintln!("{}", serde_json::to_string_pretty(&list).unwrap());
    let lab = list.servers.iter().find(|s| s.name == "lab").unwrap();
    assert_eq!(lab.status, McpStatus::Connected, "{:?}", lab.error);
    assert!(lab.tools.iter().any(|t| t.name == "echo"));
    let t = test(&mcp, McpTestParams { cwd: None, name: "lab".into(), scope: None, server: None }).await.unwrap();
    assert_eq!(t.status, McpStatus::Connected);
    eprintln!("test: {} tools in {} ms", t.tools.len(), t.ms);
    let res = search(&mcp, McpSearchParams { query: "github".into(), limit: Some(3) }).await;
    eprintln!("search: {:?}", res.as_ref().map(|r| r.entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>()));
}

#[test]
fn windows_verbatim_prefixes_are_stripped() {
    assert_eq!(strip_verbatim(r"\\?\C:\proj").as_deref(), Some(r"C:\proj"));
    assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\proj").as_deref(), Some(r"\\srv\share\proj"));
    assert_eq!(strip_verbatim(r"\\?\Volume{1234}\x"), None, "not a drive path: kept");
    assert_eq!(strip_verbatim("/home/me/proj"), None);
}

/// A user server hidden by a project one is checked again once the project one goes.
#[tokio::test]
async fn a_server_no_longer_hidden_is_not_left_skipped() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    let proj = std::fs::canonicalize(td.path()).unwrap().join("repo");
    std::fs::create_dir_all(&proj).unwrap();
    save_files(&mcp, &save_params(McpScope::User, None, "db", None, stdio("u", &[], &[]))).await.unwrap();
    save_files(&mcp, &save_params(McpScope::Project, Some(&proj), "db", None, stdio("p", &[], &[]))).await.unwrap();
    let files = native_files(&mcp, Some(&proj));
    let lists = UserLists::of(&files, &mcp.user_file());
    let hidden = natives(&files, &lists).into_iter().find(|n| n.origin == McpOrigin::User).unwrap();
    remove_files(&mcp, &McpServerRef { cwd: Some(proj.display().to_string()), name: "db".into(), scope: Some(McpScope::Project) }).await.unwrap();
    let files = native_files(&mcp, Some(&proj));
    let lists = UserLists::of(&files, &mcp.user_file());
    let shown = natives(&files, &lists).into_iter().find(|n| n.origin == McpOrigin::User).unwrap();
    assert!(hidden.shadowed && !shown.shadowed);
    assert_ne!(hidden.fp, shown.fp, "its earlier (hidden) result no longer applies");
    assert!(checks().get(&proj).is_some_and(|s| s.dirty.contains("db")), "the removed name is checked again");
}

/// Other tools' servers are on or off as the user-level lists say now, in every folder's list.
#[tokio::test]
async fn imported_switches_show_in_every_list() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    let key = mcp.cwd_for(None).unwrap();
    let linear = Probed {
        name: "linear".into(), provider: "claude".into(), provider_name: Some("Claude Code".into()), path: Some("/h/.claude.json".into()),
        enabled: true, entry_enabled: true, shadowed: false, signed_in: false, config: Some(json!({ "type": "http", "url": "https://mcp.linear.app/mcp" })),
        status: "connected".into(), error: None, auth_type: None, note: None, tools: vec![McpTool { name: "t".into(), description: None }], server_info: None, at: 1,
    };
    {
        let mut map = checks();
        let slot = map.entry(key.clone()).or_default();
        slot.servers = vec![linear];
        slot.finished_at = Some(now_ms());
    }
    // Switched off from some project's list: this one shows it off at once.
    set_enabled_files(&mcp, &McpEnableParams { cwd: None, name: "linear".into(), scope: None, enabled: false }).await.unwrap();
    let files = native_files(&mcp, None);
    let lists = UserLists::of(&files, &mcp.user_file());
    let off = build_list(&mcp, None, &files, &[], &lists, &key, 0);
    assert_eq!((off.servers[0].enabled, off.servers[0].status), (false, McpStatus::Disabled));
    // Back on: the result taken while it was on still applies.
    set_enabled_files(&mcp, &McpEnableParams { cwd: None, name: "linear".into(), scope: None, enabled: true }).await.unwrap();
    checks().get_mut(&key).unwrap().dirty.clear();
    let files = native_files(&mcp, None);
    let lists = UserLists::of(&files, &mcp.user_file());
    let on = build_list(&mcp, None, &files, &[], &lists, &key, 0);
    assert_eq!((on.servers[0].enabled, on.servers[0].status, on.servers[0].tools.len()), (true, McpStatus::Connected, 1));
}

#[tokio::test]
async fn sign_in_targets_the_rows_own_file_and_not_mcp_json_siblings() {
    let td = tempfile::tempdir().unwrap();
    let mcp = mcp_at(td.path(), None);
    let proj = std::fs::canonicalize(td.path()).unwrap().join("repo");
    std::fs::create_dir_all(&proj).unwrap();
    save_files(&mcp, &save_params(McpScope::User, None, "docs", None, http("https://u.dev/mcp"))).await.unwrap();
    save_files(&mcp, &save_params(McpScope::Project, Some(&proj), "docs", None, http("https://p.dev/mcp"))).await.unwrap();
    // The hidden user server: omp looks it up from the neutral folder, where no project file is.
    let (t, s) = auth_target(&mcp, Some(proj.clone()), "docs", Some(McpScope::User)).await.unwrap();
    assert_eq!((s, t.path.clone(), t.cwd.clone(), t.project.clone()), (McpScope::User, mcp.user_file(), mcp.neutral.clone(), None));
    let (t, _) = auth_target(&mcp, Some(proj.clone()), "docs", Some(McpScope::Project)).await.unwrap();
    assert_eq!((t.cwd.clone(), t.project.clone()), (proj.clone(), Some(proj.clone())));
    // A `.mcp.json` sibling: omp's sign-in never reads it.
    std::fs::write(mcp.agent_dir.join(".mcp.json"), r#"{"mcpServers":{"side":{"type":"http","url":"https://s.dev/mcp"}}}"#).unwrap();
    let err = auth_target(&mcp, None, "side", None).await.err().unwrap();
    assert_eq!(err.code, "invalid_params");
    assert!(err.message.contains("mcp.json files only"), "{}", err.message);
}

/// `test` of a row without a draft sends that row's own definition, not the one hiding it.
#[cfg(unix)]
#[tokio::test]
async fn testing_a_hidden_row_tests_its_own_definition() {
    let td = tempfile::tempdir().unwrap();
    let (omp, log) = fake_omp(td.path(), r#"{"t":"result","status":"connected","tools":[],"ms":5}"#);
    let mcp = mcp_at(td.path(), Some(omp));
    let proj = std::fs::canonicalize(td.path()).unwrap().join("repo");
    std::fs::create_dir_all(&proj).unwrap();
    save_files(&mcp, &save_params(McpScope::User, None, "db", None, stdio("user-db", &[], &[]))).await.unwrap();
    save_files(&mcp, &save_params(McpScope::Project, Some(&proj), "db", None, stdio("project-db", &[], &[]))).await.unwrap();
    let r = test(&mcp, McpTestParams { cwd: Some(proj.display().to_string()), name: "db".into(), scope: Some(McpScope::User), server: None }).await.unwrap();
    assert_eq!(r.status, McpStatus::Connected);
    let req = requests(&log).pop().unwrap();
    assert_eq!(req["config"]["command"], "user-db");
    assert!(req["deadlineAt"].as_i64().is_some());
}
