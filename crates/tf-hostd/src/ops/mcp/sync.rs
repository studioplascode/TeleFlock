//! omp's user-level MCP config for `hostSync` (`ops/hostsync`, architecture §3.24): the servers as
//! another host may copy them (secrets masked), one server's stored entry for the source to seal,
//! and the target's writes, through the same code as `mcp.save` / `mcp.remove` / `mcp.setEnabled`
//! (omp's file format and lock, [`model::apply_draft`]'s checks and mask restoring).

use std::path::Path;

use tf_proto::{ApiError, McpEnableParams, McpReload, McpScope, McpServerDraft, McpServerRef, SyncMcpServer};
use zeroize::Zeroizing;

use super::json::{self, Obj, J};
use super::secrets::{self, MASK};
use super::files::Loaded;
use super::{blocking, file_defining, files, mark_dirty, model, native_files, natives, remove_files, servers_mut, set_enabled_files, Mcp, UserLists};
use crate::ops::Ctx;

/// Entry keys a draft defines (not `enabled`, switched separately, nor `auth`, the host's own
/// sign-in reference), in omp's usual order.
const DRAFT_KEYS: [&str; 9] = ["type", "command", "args", "env", "cwd", "url", "headers", "timeout", "oauth"];

/// The host's user-level MCP config.
pub(crate) struct UserMcp(Mcp);

/// What [`UserMcp::put`] did besides writing the definition.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Put {
    /// Masked values this host had no value for, left empty (`env API_KEY`, `URL`, …).
    pub emptied: Vec<String>,
}

impl UserMcp {
    pub(crate) fn from_ctx(ctx: &Ctx) -> UserMcp {
        UserMcp(Mcp::from_ctx(ctx))
    }

    /// Over `<dir>/agent` (tests).
    #[cfg(test)]
    pub(crate) fn at(dir: &Path) -> UserMcp {
        use super::helper::{HelperEnv, Slots, MCP};
        UserMcp(Mcp {
            agent_dir: dir.join("agent"),
            helper: HelperEnv { spec: &MCP, omp: None, ext_dir: dir.join("ext"), run_dir: dir.join("run"), agent_dir: None, slots: Slots::new(1, 1) },
            neutral: dir.join("neutral"),
        })
    }

    /// The servers of `<agent dir>/mcp.json` (then `.mcp.json`), secrets masked; a definition the
    /// other file hides is left out. The note names a file omp can't read.
    pub(crate) async fn servers(&self) -> Result<(Vec<SyncMcpServer>, Option<String>), ApiError> {
        let mcp = self.0.clone();
        blocking(move || {
            let files = native_files(&mcp, None);
            let lists = UserLists::of(&files, &mcp.user_file());
            let note = files.iter().find_map(|f| match &f.loaded {
                Loaded::Bad(m) => Some(format!("omp can't read {}: {m}", f.path.display())),
                _ => None,
            });
            let servers = natives(&files, &lists)
                .into_iter()
                .filter(|n| !n.shadowed)
                .map(|n| {
                    let (server, extra) = model::to_draft(&n.entry);
                    SyncMcpServer { secrets: has_masks(&server), signed_in: model::has_oauth_block(&n.entry), name: n.name, server, enabled: n.enabled, extra }
                })
                .collect();
            Ok((servers, note))
        })
        .await
    }

    /// `name`'s stored entry with its secrets, in file order, as compact JSON: what the source seals
    /// for `mcpSecrets:<name>`. Its `auth` block (this host's sign-in reference) is left out.
    pub(crate) async fn stored_entry(&self, name: &str) -> Result<Option<Zeroizing<String>>, ApiError> {
        let (mcp, name) = (self.0.clone(), name.to_string());
        blocking(move || {
            let files = native_files(&mcp, None);
            let lists = UserLists::of(&files, &mcp.user_file());
            Ok(natives(&files, &lists).into_iter().find(|n| n.name == name && !n.shadowed).map(|n| {
                let mut entry = n.entry;
                entry.remove("auth");
                Zeroizing::new(json::compact(&J::Obj(entry)))
            }))
        })
        .await
    }

    /// Masked values of `draft` this host can't fill from its own definition of `name` (empty: it
    /// can fill them all, or there are none).
    pub(crate) async fn unfillable(&self, name: &str, draft: &McpServerDraft) -> Result<Vec<String>, ApiError> {
        let (mcp, name, draft) = (self.0.clone(), name.to_string(), draft.clone());
        blocking(move || {
            let (file, found) = file_defining(&mcp.agent_dir, &name);
            let stored = found.then(|| own_entry(&file, &name)).flatten();
            Ok(strip_unfillable(&draft, stored.as_ref()).1)
        })
        .await
    }

    /// Writes the source's `draft` as server `name`: a new entry, or over this host's definition,
    /// whose other fields and sign-in stay. Masked values come from `sealed` (the source's stored
    /// entry, [`Self::stored_entry`]), else from this host's own definition; values neither has are
    /// left empty and named in [`Put::emptied`]. Then the server is switched on or off as `enabled`.
    pub(crate) async fn put(&self, name: &str, draft: &McpServerDraft, enabled: bool, sealed: Option<Zeroizing<String>>) -> Result<Put, ApiError> {
        model::validate_name(name)?;
        let mcp = self.0.clone();
        let (file, _) = file_defining(&mcp.agent_dir, name);
        let (n, d) = (name.to_string(), draft.clone());
        let put = blocking(move || {
            files::modify(&file, |root| {
                let servers = servers_mut(root)?;
                let existing = servers.get(&n).and_then(J::as_obj).cloned();
                let (from, draft, emptied) = match sealed.as_deref() {
                    Some(text) => match json::parse(text) {
                        Ok(J::Obj(o)) => (Some(o), d, Vec::new()),
                        _ => return Err(ApiError::new("invalid_params", format!("{n}: the sealed definition is not a server entry"))),
                    },
                    None => {
                        let (stripped, emptied) = strip_unfillable(&d, existing.as_ref());
                        (existing, stripped, emptied)
                    }
                };
                let resolved = resolve(&draft, from.as_ref())?;
                match servers.get_mut(&n) {
                    Some(J::Obj(entry)) => {
                        for key in DRAFT_KEYS {
                            match resolved.get(key) {
                                Some(v) => entry.set(key, v.clone()),
                                None => {
                                    entry.remove(key);
                                }
                            }
                        }
                    }
                    _ => servers.set(&n, J::Obj(resolved)),
                }
                Ok(Put { emptied })
            })
        })
        .await?;
        let (m2, n2) = (mcp.clone(), name.to_string());
        let now_enabled = blocking(move || {
            let files = native_files(&m2, None);
            let lists = UserLists::of(&files, &m2.user_file());
            Ok(natives(&files, &lists).into_iter().find(|x| x.name == n2 && !x.shadowed).map(|x| x.enabled))
        })
        .await?;
        if now_enabled != Some(enabled) {
            set_enabled_files(&mcp, &McpEnableParams { cwd: None, name: name.to_string(), scope: Some(McpScope::User), enabled }).await?;
        }
        tracing::info!(name, emptied = put.emptied.len(), "mcp server copied from another host");
        mark_dirty(&mcp.cwd_for(None)?, name);
        Ok(put)
    }

    pub(crate) async fn delete(&self, name: &str) -> Result<(), ApiError> {
        remove_files(&self.0, &McpServerRef { cwd: None, name: name.to_string(), scope: Some(McpScope::User) }).await.map(drop)
    }
}

/// `/mcp reload` in every running session (a user-level change concerns them all).
pub(crate) async fn reload_sessions(ctx: &Ctx) -> McpReload {
    super::reload::reload(ctx, None).await
}

/// This host's entry `name` of `file` (secrets in the clear; stays in the daemon).
fn own_entry(file: &Path, name: &str) -> Option<Obj> {
    match files::read(file) {
        Loaded::Ok(root) => root.obj("mcpServers").and_then(|s| s.obj(name)).cloned(),
        _ => None,
    }
}

/// The entry `draft` describes, masked values filled from `from`: `apply_draft` over a copy of
/// `from` (so values listed as stored keep their stored form), keeping the draft's keys only.
fn resolve(draft: &McpServerDraft, from: Option<&Obj>) -> Result<Obj, ApiError> {
    let mut entry = from.cloned().unwrap_or_default();
    model::apply_draft(&mut entry, draft, from)?;
    let mut out = Obj::default();
    for key in DRAFT_KEYS {
        if let Some(v) = entry.get(key) {
            out.set(key, v.clone());
        }
    }
    Ok(out)
}

/// [`MASK`] percent-encoded, as a browser may have sent it back in a URL.
fn pct_masks() -> [String; 2] {
    [MASK.bytes().map(|b| format!("%{b:02X}")).collect(), MASK.bytes().map(|b| format!("%{b:02x}")).collect()]
}

fn has_mask(s: &str) -> bool {
    s.contains(MASK) || pct_masks().iter().any(|m| s.contains(m.as_str()))
}

fn strip_masks(s: &str) -> String {
    let [upper, lower] = pct_masks();
    s.replace(MASK, "").replace(&upper, "").replace(&lower, "")
}

/// Whether a listed definition hides secrets ([`MASK`] anywhere `to_draft` puts one).
pub(crate) fn has_masks(d: &McpServerDraft) -> bool {
    d.env.iter().chain(&d.headers).any(|kv| kv.value == MASK)
        || d.args.iter().any(|a| has_mask(a))
        || d.url.as_deref().is_some_and(has_mask)
        || d.oauth.as_ref().is_some_and(|o| o.client_secret.as_deref() == Some(MASK))
}

/// `draft` with each masked value that `stored` (this host's definition) can't fill emptied, and
/// what was emptied.
fn strip_unfillable(draft: &McpServerDraft, stored: Option<&Obj>) -> (McpServerDraft, Vec<String>) {
    let mut d = draft.clone();
    let mut emptied = Vec::new();
    for (list, what, field) in [(&mut d.env, "env", "env"), (&mut d.headers, "header", "headers")] {
        let have = stored.and_then(|s| s.obj(field));
        for kv in list.iter_mut().filter(|kv| kv.value == MASK) {
            if !have.is_some_and(|h| h.contains(kv.key.trim())) {
                kv.value.clear();
                emptied.push(format!("{what} {}", kv.key.trim()));
            }
        }
    }
    if d.args.iter().any(|a| has_mask(a)) {
        let stored_args: Vec<String> = stored.and_then(|s| s.get("args")).and_then(J::as_arr).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if secrets::unmask_args(&d.args, &stored_args).is_err() {
            d.args = d.args.iter().map(|a| strip_masks(a)).collect();
            emptied.push("arguments".into());
        }
    }
    if let Some(url) = d.url.clone().filter(|u| has_mask(u))
        && secrets::unmask_url(&url, stored.and_then(|s| s.str("url"))).is_err()
    {
        d.url = Some(strip_masks(&url));
        emptied.push("URL".into());
    }
    if let Some(o) = d.oauth.as_mut()
        && o.client_secret.as_deref() == Some(MASK)
        && !stored.and_then(|s| s.obj("oauth")).is_some_and(|o| o.str("clientSecret").is_some())
    {
        o.client_secret = None;
        emptied.push("OAuth client secret".into());
    }
    (d, emptied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{McpKeyValue, McpTransport};

    fn write(dir: &Path, text: &str) {
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(dir.join("agent/mcp.json"), text).unwrap();
    }

    fn file(dir: &Path) -> String {
        std::fs::read_to_string(dir.join("agent/mcp.json")).unwrap()
    }

    const SOURCE: &str = r#"{
  "mcpServers": {
    "gh": { "type": "stdio", "command": "npx", "args": ["-y", "gh-mcp", "--token=ghp_SOURCESECRET"], "env": { "GITHUB_TOKEN": "ghp_ENVSECRET", "LOG": "info" }, "timeout": "30000", "envPolicy": "inherit", "auth": { "type": "oauth", "credentialId": "mcp_oauth:x" } },
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp?key=QUERYSECRET", "enabled": false }
  },
  "disabledServers": ["docs"]
}"#;

    #[tokio::test]
    async fn lists_masked_and_seals_the_stored_entry() {
        let td = tempfile::tempdir().unwrap();
        write(td.path(), SOURCE);
        let src = UserMcp::at(td.path());
        let (servers, note) = src.servers().await.unwrap();
        assert_eq!(note, None);
        let wire = serde_json::to_string(&servers).unwrap();
        assert!(!wire.contains("SECRET"), "secrets masked: {wire}");
        let gh = servers.iter().find(|s| s.name == "gh").unwrap();
        assert!(gh.secrets && gh.signed_in && gh.enabled);
        assert_eq!(gh.extra, vec!["envPolicy".to_string()]);
        let docs = servers.iter().find(|s| s.name == "docs").unwrap();
        assert!(docs.secrets && !docs.enabled);
        let sealed = src.stored_entry("gh").await.unwrap().unwrap();
        assert!(sealed.contains("ghp_ENVSECRET") && !sealed.contains("credentialId"), "{}", sealed.as_str());
        assert!(src.stored_entry("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn put_with_sealed_secrets_new_server() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        write(a.path(), SOURCE);
        let (src, dst) = (UserMcp::at(a.path()), UserMcp::at(b.path()));
        let (servers, _) = src.servers().await.unwrap();
        for s in &servers {
            let sealed = src.stored_entry(&s.name).await.unwrap();
            assert_eq!(dst.put(&s.name, &s.server, s.enabled, sealed).await.unwrap(), Put::default());
        }
        let text = file(b.path());
        assert!(text.contains("ghp_ENVSECRET") && text.contains("--token=ghp_SOURCESECRET") && text.contains("key=QUERYSECRET"), "{text}");
        assert!(!text.contains("credentialId") && !text.contains("envPolicy"), "no sign-in reference, no unedited field: {text}");
        assert!(text.contains(r#""timeout": "30000""#), "stored form kept: {text}");
        // The copy lists like the original (definitions and switches).
        let (copied, _) = dst.servers().await.unwrap();
        for s in &servers {
            let c = copied.iter().find(|c| c.name == s.name).unwrap();
            assert_eq!((&c.server, c.enabled), (&s.server, s.enabled), "{}", s.name);
        }
    }

    #[tokio::test]
    async fn put_without_secrets_keeps_or_empties() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        write(a.path(), SOURCE);
        // The target has `gh` with its own token and sign-in, and nothing else.
        write(
            b.path(),
            r#"{
  "mcpServers": {
    "gh": { "command": "npx", "args": ["-y", "gh-mcp", "--token=ghp_TARGETOWN"], "env": { "GITHUB_TOKEN": "ghp_TARGETENV" }, "auth": { "type": "oauth", "credentialId": "mine" }, "note": "kept" }
  }
}"#,
        );
        let (src, dst) = (UserMcp::at(a.path()), UserMcp::at(b.path()));
        let (servers, _) = src.servers().await.unwrap();
        let gh = servers.iter().find(|s| s.name == "gh").unwrap();
        assert!(dst.unfillable("gh", &gh.server).await.unwrap().is_empty(), "the target fills every mask of gh");
        let docs = servers.iter().find(|s| s.name == "docs").unwrap();
        assert_eq!(dst.unfillable("docs", &docs.server).await.unwrap(), vec!["URL".to_string()]);

        assert_eq!(dst.put("gh", &gh.server, true, None).await.unwrap(), Put::default());
        let put = dst.put("docs", &docs.server, false, None).await.unwrap();
        assert_eq!(put.emptied, vec!["URL".to_string()]);
        let text = file(b.path());
        assert!(text.contains("ghp_TARGETENV") && text.contains("--token=ghp_TARGETOWN") && text.contains(r#""LOG": "info""#), "{text}");
        assert!(text.contains(r#""credentialId": "mine""#) && text.contains(r#""note": "kept""#), "the target's own fields stay: {text}");
        assert!(text.contains("https://mcp.example.com/mcp?key=") && !text.contains("QUERYSECRET") && !text.contains(MASK), "{text}");
        // Switched off like on the source (through omp's lists or the entry's flag).
        let (now, _) = dst.servers().await.unwrap();
        assert!(!now.iter().find(|s| s.name == "docs").unwrap().enabled);

        dst.delete("docs").await.unwrap();
        assert!(!file(b.path()).contains("\"docs\""));
        assert_eq!(dst.delete("docs").await.unwrap_err().code, "not_found");
    }

    #[test]
    fn strips_only_what_the_target_lacks() {
        let kv = |k: &str, v: &str| McpKeyValue { key: k.into(), value: v.into(), secret: true };
        let draft = McpServerDraft {
            transport: McpTransport::Http,
            command: None,
            args: vec![],
            cwd: None,
            env: vec![],
            url: Some(format!("https://x.dev/mcp?token={}", pct_masks()[0])),
            headers: vec![kv("Authorization", MASK), kv("X-Team", "core")],
            timeout_ms: None,
            oauth: Some(tf_proto::McpOAuthSettings { client_id: Some("app".into()), client_secret: Some(MASK.into()), scope: None, callback_port: None, redirect_uri: None }),
        };
        assert!(has_masks(&draft));
        let (d, emptied) = strip_unfillable(&draft, None);
        assert_eq!(emptied, vec!["header Authorization", "URL", "OAuth client secret"]);
        assert!(!has_masks(&d));
        let J::Obj(stored) = json::parse(r#"{"url":"https://x.dev/mcp?token=abc","headers":{"Authorization":"Bearer t"},"oauth":{"clientSecret":"s"}}"#).unwrap() else { panic!() };
        let (same, none) = strip_unfillable(&draft, Some(&stored));
        assert!(none.is_empty());
        assert_eq!(same, draft);
    }
}
