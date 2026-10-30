//! Sign-ins as `omp auth export` carries them (omp `commands/auth.ts`): listed by identity only,
//! selected for sealing on the source, checked again on the target before `omp auth import -`.
//!
//! The export holds live tokens and keys. It stays in wiped buffers: the identity list is read
//! with a typed parser that skips every other field without copying it, and a selection's parsed
//! values are wiped once serialized.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tf_proto::{ApiError, SyncSignIn, SyncSignInKind};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::{Zeroize, Zeroizing};

/// `omp auth export` / `import` (omp start, SQLite).
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
struct Doc {
    version: Option<u64>,
    #[serde(default)]
    credentials: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    provider: String,
    credential: Ident,
}

/// The identity fields of a credential (every other field, the secrets, is skipped unread).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Ident {
    #[serde(rename = "type", default)]
    kind: String,
    email: Option<String>,
    account_id: Option<String>,
    project_id: Option<String>,
    org_id: Option<String>,
    org_name: Option<String>,
    enterprise_url: Option<String>,
}

impl Ident {
    fn of_value(v: &Value) -> Ident {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Ident {
            kind: s("type").unwrap_or_default(),
            email: s("email"),
            account_id: s("accountId"),
            project_id: s("projectId"),
            org_id: s("orgId"),
            org_name: s("orgName"),
            enterprise_url: s("enterpriseUrl"),
        }
    }

    fn kind(&self) -> Option<SyncSignInKind> {
        match self.kind.as_str() {
            "oauth" => Some(SyncSignInKind::Oauth),
            "api_key" => Some(SyncSignInKind::ApiKey),
            _ => None,
        }
    }

    /// Stable across hosts for one account: the provider and a hash of who it is.
    fn id(&self, provider: &str) -> String {
        let who = match self.kind() {
            Some(SyncSignInKind::ApiKey) => "apiKey".to_string(),
            _ => {
                let f = |v: &Option<String>| v.as_deref().map(str::trim).unwrap_or_default().to_string();
                format!("{}\n{}\n{}\n{}\n{}\n{}", self.kind, f(&self.email).to_lowercase(), f(&self.account_id), f(&self.project_id), f(&self.org_id), f(&self.enterprise_url))
            }
        };
        let digest = Sha256::digest(who.as_bytes());
        format!("{provider}|{}", digest[..6].iter().map(|b| format!("{b:02x}")).collect::<String>())
    }
}

fn non_empty(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// An MCP server's OAuth sign-in (`mcp_oauth:profile:<profile>:<url>`, `mcp_oauth:<url>`, older
/// `mcp_oauth_<random>`): the server URL its id names.
fn mcp_url(provider: &str) -> Option<Option<String>> {
    if let Some(rest) = provider.strip_prefix("mcp_oauth:profile:") {
        return Some(rest.split_once(':').map(|(_, url)| url.to_string()).filter(|u| u.contains("://")));
    }
    if let Some(rest) = provider.strip_prefix("mcp_oauth:") {
        return Some(Some(rest.to_string()).filter(|u| u.contains("://")));
    }
    provider.starts_with("mcp_oauth_").then_some(None)
}

/// Ids with `#2`, `#3`… for repeats within one export (two credentials of one identity).
struct Ids(HashMap<String, u32>);

impl Ids {
    fn next(&mut self, id: String) -> String {
        let n = self.0.entry(id.clone()).or_insert(0);
        *n += 1;
        if *n == 1 { id } else { format!("{id}#{n}") }
    }
}

fn bad_export(e: impl std::fmt::Display) -> ApiError {
    ApiError::new("omp_error", format!("omp auth export: unexpected output ({e})"))
}

/// The sign-ins of an `omp auth export` document, by identity. Credential types omp can't import
/// are left out.
pub(crate) fn list(export: &[u8]) -> Result<Vec<SyncSignIn>, ApiError> {
    let doc: Doc = serde_json::from_slice(export).map_err(bad_export)?;
    if doc.version != Some(1) {
        return Err(ApiError::new("unsupported", format!("omp's credential export has version {:?}; this TeleFlock reads version 1", doc.version)).with_hint("Update TeleFlock."));
    }
    let mut ids = Ids(HashMap::new());
    Ok(doc
        .credentials
        .into_iter()
        .filter_map(|e| {
            let kind = e.credential.kind()?;
            let id = ids.next(e.credential.id(&e.provider));
            let c = &e.credential;
            Some(SyncSignIn {
                id,
                kind,
                account: non_empty(&c.email).or_else(|| non_empty(&c.account_id)).or_else(|| non_empty(&c.project_id)),
                org: non_empty(&c.org_name).or_else(|| non_empty(&c.org_id)),
                mcp_url: mcp_url(&e.provider).flatten(),
                provider: e.provider,
            })
        })
        .collect())
}

/// Wipes every string of a parsed export (the tokens it held).
pub(crate) fn wipe(v: &mut Value) {
    match v {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => o.values_mut().for_each(wipe),
        _ => {}
    }
}

/// The credentials of `export` whose ids are in `wanted`, as an `omp auth export` document, and
/// the ids found. The parsed copy is wiped.
pub(crate) fn select(export: &[u8], wanted: &HashSet<String>) -> Result<(Zeroizing<Vec<u8>>, Vec<String>), ApiError> {
    let mut doc: Value = serde_json::from_slice(export).map_err(bad_export)?;
    let mut picked = Vec::new();
    let mut found = Vec::new();
    let mut ids = Ids(HashMap::new());
    if let Some(entries) = doc.get_mut("credentials").and_then(Value::as_array_mut) {
        for entry in entries.iter_mut() {
            let provider = entry.get("provider").and_then(Value::as_str).unwrap_or_default().to_string();
            let ident = entry.get("credential").map(Ident::of_value).unwrap_or_default();
            if ident.kind().is_none() {
                continue;
            }
            let id = ids.next(ident.id(&provider));
            if wanted.contains(&id) {
                picked.push(entry.take());
                found.push(id);
            }
        }
    }
    let mut out = json!({ "version": 1, "credentials": picked });
    let bytes = Zeroizing::new(serde_json::to_vec(&out).map_err(bad_export)?);
    wipe(&mut out);
    wipe(&mut doc);
    Ok((bytes, found))
}

/// Runs omp where secrets pass: no shell, `input` on stdin (then closed), stdout kept in a buffer
/// that is wiped when dropped. Answers (success, stdout, stderr).
pub(crate) async fn run_omp(bin: &Path, args: &[&str], env: &[(&str, &str)], input: Option<&[u8]>, timeout: Duration) -> Result<(bool, Zeroizing<Vec<u8>>, String), ApiError> {
    let what = format!("omp {}", args.iter().take(2).copied().collect::<Vec<_>>().join(" "));
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(crate::ops::fs::home_dir())
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never flash a console window from the background daemon.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| ApiError::new("omp_error", format!("{what}: {e}")))?;
    let (stdin, mut stdout, mut stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let work = async {
        let write = async {
            if let (Some(mut pipe), Some(bytes)) = (stdin, input) {
                let _ = pipe.write_all(bytes).await;
                let _ = pipe.shutdown().await;
            }
        };
        let read_out = async {
            let mut buf = Zeroizing::new(Vec::with_capacity(64 * 1024));
            if let Some(out) = stdout.as_mut() {
                let _ = out.read_to_end(&mut buf).await;
            }
            buf
        };
        let read_err = async {
            let mut buf = Vec::new();
            if let Some(err) = stderr.as_mut() {
                let _ = err.read_to_end(&mut buf).await;
            }
            String::from_utf8_lossy(&buf).into_owned()
        };
        let ((), out, err) = tokio::join!(write, read_out, read_err);
        let status = child.wait().await;
        (status, out, err)
    };
    match tokio::time::timeout(timeout, work).await {
        Ok((Ok(status), out, err)) => Ok((status.success(), out, crate::ops::tools::strip_ansi(&err))),
        Ok((Err(e), _, _)) => Err(ApiError::new("omp_error", format!("{what}: {e}"))),
        Err(_) => Err(ApiError::new("timeout", format!("{what} timed out after {}s", timeout.as_secs()))),
    }
}

/// omp's message: its first `error:` line (else first line), without the prefix.
pub(crate) fn omp_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let line = lines.iter().find(|l| l.to_ascii_lowercase().starts_with("error")).or(lines.first()).copied().unwrap_or("omp failed");
    let line = line.strip_prefix("error:").or_else(|| line.strip_prefix("Error:")).unwrap_or(line);
    line.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const EXPORT: &str = r#"{
  "version": 1,
  "credentials": [
    { "provider": "anthropic", "credential": { "type": "oauth", "access": "sk-ant-oat-ACCESSSECRET", "refresh": "sk-ant-ort-REFRESHSECRET", "expires": 1900000000000, "email": "Work@Example.com", "accountId": "acc-1", "orgName": "Acme" } },
    { "provider": "openai", "credential": { "type": "api_key", "key": "sk-proj-KEYSECRET" } },
    { "provider": "mcp_oauth:profile:default:https://mcp.example.com/mcp", "credential": { "type": "oauth", "access": "MCPACCESS", "refresh": "MCPREFRESH", "expires": 1 } },
    { "provider": "weird", "credential": { "type": "cookie", "value": "COOKIESECRET" } },
    { "provider": "openai", "credential": { "type": "api_key", "key": "sk-proj-SECONDKEY" } }
  ]
}"#;

    #[test]
    fn lists_identities_without_secrets() {
        let list = list(EXPORT.as_bytes()).unwrap();
        let wire = serde_json::to_string(&list).unwrap();
        assert!(!wire.contains("SECRET") && !wire.contains("MCPACCESS") && !wire.contains("SECONDKEY"), "{wire}");
        assert_eq!(list.len(), 4, "the unknown credential type is left out");
        assert_eq!(list[0].account.as_deref(), Some("Work@Example.com"));
        assert_eq!(list[0].org.as_deref(), Some("Acme"));
        assert_eq!(list[1].kind, SyncSignInKind::ApiKey);
        assert_eq!(list[2].mcp_url.as_deref(), Some("https://mcp.example.com/mcp"));
        assert_eq!(list[3].id, format!("{}#2", list[1].id), "a second key of a provider");
        // The same account has the same id on another host, whatever its tokens.
        let other = r#"{"version":1,"credentials":[{"provider":"anthropic","credential":{"type":"oauth","access":"x","refresh":"y","expires":2,"email":"work@example.com","accountId":"acc-1","orgName":"Acme"}}]}"#;
        assert_eq!(super::list(other.as_bytes()).unwrap()[0].id, list[0].id);
        assert!(list[0].id.starts_with("anthropic|") && list[0].id.len() == "anthropic|".len() + 12);
        assert_eq!(super::list(br#"{"version":2,"credentials":[]}"#).unwrap_err().code, "unsupported");
        assert_eq!(mcp_url("mcp_oauth_17000_abc"), Some(None));
        assert_eq!(mcp_url("mcp_oauth:https://x.dev/mcp"), Some(Some("https://x.dev/mcp".into())));
        assert_eq!(mcp_url("anthropic"), None);
    }

    #[test]
    fn selects_only_the_chosen() {
        let ids = list(EXPORT.as_bytes()).unwrap();
        let wanted: HashSet<String> = [ids[0].id.clone(), ids[3].id.clone(), "nobody|000000000000".into()].into();
        let (doc, found) = select(EXPORT.as_bytes(), &wanted).unwrap();
        assert_eq!(found, vec![ids[0].id.clone(), ids[3].id.clone()]);
        let text = String::from_utf8(doc.to_vec()).unwrap();
        assert!(text.contains("REFRESHSECRET") && text.contains("SECONDKEY"), "{text}");
        assert!(!text.contains("KEYSECRET\"") && !text.contains("MCPACCESS") && !text.contains("COOKIE"), "{text}");
        // What it selected is an export again: listing it gives the same ids.
        let again: Vec<String> = list(&doc).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(again.len(), 2);
        assert_eq!(again[0], ids[0].id);
    }

    #[test]
    fn wipe_clears_every_string() {
        let mut v: Value = serde_json::from_str(EXPORT).unwrap();
        wipe(&mut v);
        assert!(!v.to_string().contains("SECRET"));
    }

    #[test]
    fn omp_error_lines() {
        assert_eq!(
            omp_error("error: omp uses the auth broker at https://b.example; credentials live there, not in this machine's agent.db.\nRun this on the broker host…\n"),
            "omp uses the auth broker at https://b.example; credentials live there, not in this machine's agent.db."
        );
        assert_eq!(omp_error("warning: x\n"), "warning: x");
        assert_eq!(omp_error(""), "omp failed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_omp_passes_stdin_and_keeps_argv_clean() {
        let td = tempfile::tempdir().unwrap();
        let bin = td.path().join("omp");
        crate::test_exe::write_exe(&bin, format!("#!/bin/sh\necho \"$@\" > {d}/argv\ncat > {d}/stdin\necho 'Imported 1 credential(s) for openai.' >&2\n", d = td.path().display()));
        let (ok, out, err) = run_omp(&bin, &["auth", "import", "-"], &[("NO_COLOR", "1")], Some(b"{\"key\":\"sk-SECRET\"}"), Duration::from_secs(10)).await.unwrap();
        assert!(ok && out.is_empty());
        assert_eq!(err.trim(), "Imported 1 credential(s) for openai.");
        assert_eq!(std::fs::read_to_string(td.path().join("argv")).unwrap().trim(), "auth import -");
        assert_eq!(std::fs::read_to_string(td.path().join("stdin")).unwrap(), "{\"key\":\"sk-SECRET\"}");
        crate::test_exe::write_exe(&bin, "#!/bin/sh\nsleep 5\n");
        assert_eq!(run_omp(&bin, &["auth", "export"], &[], None, Duration::from_millis(300)).await.unwrap_err().code, "timeout");
    }
}
