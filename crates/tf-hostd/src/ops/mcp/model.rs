//! One server entry of omp's `mcp.json` ⇄ the app's [`McpServerDraft`].
//!
//! An edit starts from the stored entry and changes only the fields the draft owns, so keys
//! TeleFlock doesn't know (`requestIdFormat`, `instructions`, a future omp field) keep their value
//! and position, and the `auth` block omp's sign-in writes stays.

use tf_proto::{ApiError, McpOAuthSettings, McpServerDraft, McpTransport};

use super::json::{Obj, J};
use super::secrets;

/// Entry keys the draft edits (plus `enabled`, switched separately, and `auth`, owned by sign-in).
const OWNED: &[&str] = &["type", "command", "args", "env", "cwd", "url", "headers", "timeout", "oauth", "enabled", "auth"];
const STDIO_ONLY: &[&str] = &["command", "args", "env", "cwd", "envPolicy", "envLiteralKeys"];
const HTTP_ONLY: &[&str] = &["url", "headers", "headerPolicy"];
const OAUTH_KEYS: &[&str] = &["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"];

/// omp's `validateServerName` (`mcp/config-writer.ts`).
pub fn validate_name(name: &str) -> Result<(), ApiError> {
    let bad = |m: &str| Err(ApiError::new("invalid_params", format!("name: {m}")));
    if name.is_empty() {
        return bad("enter a name");
    }
    if name.chars().count() > 100 {
        return bad("at most 100 characters");
    }
    let word_ok = |w: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'));
    if !name.split(' ').all(word_ok) {
        return bad("letters, digits, `-`, `_`, `.`, `:` and single spaces only");
    }
    Ok(())
}

/// omp's transport inference: `type`, else `command` → stdio, `url` → http.
pub fn transport_of(entry: &Obj) -> McpTransport {
    match entry.str("type") {
        Some("http") => McpTransport::Http,
        Some("sse") => McpTransport::Sse,
        Some("stdio") => McpTransport::Stdio,
        _ if entry.str("command").is_some_and(|c| !c.is_empty()) => McpTransport::Stdio,
        _ if entry.str("url").is_some() => McpTransport::Http,
        _ => McpTransport::Stdio,
    }
}

fn strings(v: Option<&J>) -> Vec<String> {
    v.and_then(J::as_arr).map(|a| a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| super::json::compact(x))).collect()).unwrap_or_default()
}

fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The stored entry as the app shows it (secrets masked) + names of the fields it doesn't edit.
pub fn to_draft(entry: &Obj) -> (McpServerDraft, Vec<String>) {
    let transport = transport_of(entry);
    let oauth = entry.obj("oauth").map(|o| McpOAuthSettings {
        client_id: non_empty(o.str("clientId")),
        client_secret: o.str("clientSecret").filter(|s| !s.is_empty()).map(|s| if secrets::is_secret("clientSecret", s) { secrets::MASK.to_string() } else { s.to_string() }),
        scope: non_empty(o.str("scope")),
        callback_port: o.get("callbackPort").and_then(J::as_u64).and_then(|p| u16::try_from(p).ok()),
        redirect_uri: non_empty(o.str("redirectUri")),
    });
    let draft = McpServerDraft {
        transport,
        command: entry.str("command").map(str::to_string),
        args: secrets::mask_args(&strings(entry.get("args"))),
        cwd: non_empty(entry.str("cwd")),
        env: entry.obj("env").map(secrets::mask_kv).unwrap_or_default(),
        url: entry.str("url").map(secrets::mask_url),
        headers: entry.obj("headers").map(secrets::mask_kv).unwrap_or_default(),
        timeout_ms: entry.get("timeout").and_then(J::as_u64),
        oauth: oauth.filter(|o| *o != McpOAuthSettings { client_id: None, client_secret: None, scope: None, callback_port: None, redirect_uri: None }),
    };
    let extra = entry.keys().filter(|k| !OWNED.contains(k)).map(str::to_string).collect();
    (draft, extra)
}

/// Writes `draft` into `entry` (the stored entry, or empty for a new server). `stored` is the
/// entry before the edit (masked values are taken from it).
pub fn apply_draft(entry: &mut Obj, draft: &McpServerDraft, stored: Option<&Obj>) -> Result<(), ApiError> {
    let invalid = |m: String| ApiError::new("invalid_params", m);
    let had_type = entry.contains("type");
    let inferred = (!entry.is_empty()).then(|| transport_of(entry));
    let type_name = match draft.transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    };
    // A stored entry that leaves `type` out (stdio implied) stays that way while it stays stdio.
    if had_type || inferred != Some(draft.transport) || draft.transport != McpTransport::Stdio {
        entry.set("type", J::str(type_name));
    }
    match draft.transport {
        McpTransport::Stdio => {
            let command = non_empty(draft.command.as_deref()).ok_or_else(|| invalid("command: enter the program to start".into()))?;
            if command.contains(['\n', '\r']) {
                return Err(invalid("command: one line only".into()));
            }
            for k in HTTP_ONLY {
                entry.remove(k);
            }
            entry.set("command", J::str(command));
            let stored_args = stored.map(|s| strings(s.get("args"))).unwrap_or_default();
            let args = secrets::unmask_args(&draft.args, &stored_args)?;
            set_or_remove(entry, "args", (!args.is_empty()).then(|| J::strings(&args)));
            set_or_remove(entry, "cwd", non_empty(draft.cwd.as_deref()).map(J::str));
            let env = secrets::unmask_kv(&draft.env, stored.and_then(|s| s.obj("env")), "env", false)?;
            set_or_remove(entry, "env", (!env.is_empty()).then_some(J::Obj(env)));
        }
        McpTransport::Http | McpTransport::Sse => {
            let raw = non_empty(draft.url.as_deref()).ok_or_else(|| invalid("url: enter the server's address".into()))?;
            let url = secrets::unmask_url(&raw, stored.and_then(|s| s.str("url")))?;
            let lower = url.to_ascii_lowercase();
            let host = lower.split_once("://").map(|(_, r)| r.split(['/', '?', '#']).next().unwrap_or_default()).unwrap_or_default();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) || host.is_empty() || url.contains(char::is_whitespace) {
                return Err(invalid("url: an http:// or https:// address".into()));
            }
            for k in STDIO_ONLY {
                entry.remove(k);
            }
            entry.set("url", J::str(url));
            let headers = secrets::unmask_kv(&draft.headers, stored.and_then(|s| s.obj("headers")), "headers", true)?;
            set_or_remove(entry, "headers", (!headers.is_empty()).then_some(J::Obj(headers)));
        }
    }
    set_or_remove(entry, "timeout", draft.timeout_ms.map(J::num));
    apply_oauth(entry, draft.oauth.as_ref(), stored.and_then(|s| s.obj("oauth")))?;
    Ok(())
}

fn set_or_remove(entry: &mut Obj, key: &str, value: Option<J>) {
    match value {
        Some(v) => entry.set(key, v),
        None => {
            entry.remove(key);
        }
    }
}

/// The draft's OAuth client settings into the `oauth` block; its other keys (`prompt`,
/// `callbackPath`) stay. An emptied block is removed.
fn apply_oauth(entry: &mut Obj, draft: Option<&McpOAuthSettings>, stored: Option<&Obj>) -> Result<(), ApiError> {
    let mut o = entry.obj("oauth").cloned().unwrap_or_default();
    let d = draft.cloned().unwrap_or(McpOAuthSettings { client_id: None, client_secret: None, scope: None, callback_port: None, redirect_uri: None });
    let secret = match d.client_secret.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s == secrets::MASK => Some(
            stored
                .and_then(|o| o.str("clientSecret"))
                .map(str::to_string)
                .ok_or_else(|| ApiError::new("invalid_params", "oauth.clientSecret: enter the client secret again"))?,
        ),
        other => other.map(str::to_string),
    };
    if let Some(uri) = d.redirect_uri.as_deref().map(str::trim).filter(|s| !s.is_empty())
        && !(uri.starts_with("http://") || uri.starts_with("https://"))
    {
        return Err(ApiError::new("invalid_params", "oauth.redirectUri: an http:// or https:// address"));
    }
    if d.callback_port == Some(0) {
        return Err(ApiError::new("invalid_params", "oauth.callbackPort: 1–65535"));
    }
    let values = [
        non_empty(d.client_id.as_deref()).map(J::str),
        secret.map(J::str),
        non_empty(d.scope.as_deref()).map(J::str),
        d.callback_port.map(|p| J::num(u64::from(p))),
        non_empty(d.redirect_uri.as_deref()).map(J::str),
    ];
    for (k, v) in OAUTH_KEYS.iter().zip(values) {
        set_or_remove(&mut o, k, v);
    }
    set_or_remove(entry, "oauth", (!o.is_empty()).then_some(J::Obj(o)));
    Ok(())
}

/// The `enabled` flag of an entry (`"false"` strings count, like omp's coercion).
pub fn entry_enabled(entry: &Obj) -> bool {
    match entry.get("enabled") {
        Some(J::Bool(b)) => *b,
        Some(J::Str(s)) => !s.eq_ignore_ascii_case("false"),
        _ => true,
    }
}

/// An OAuth sign-in recorded in the entry (`auth: {type: "oauth", credentialId}`).
pub fn has_oauth_block(entry: &Obj) -> bool {
    entry.obj("auth").is_some_and(|a| a.str("type") == Some("oauth"))
}

#[cfg(test)]
mod tests {
    use super::super::json::{compact, parse};
    use super::*;
    use tf_proto::McpKeyValue;

    fn obj(s: &str) -> Obj {
        match parse(s).unwrap() {
            J::Obj(o) => o,
            _ => panic!(),
        }
    }

    fn draft(transport: McpTransport) -> McpServerDraft {
        McpServerDraft { transport, command: None, args: vec![], cwd: None, env: vec![], url: None, headers: vec![], timeout_ms: None, oauth: None }
    }

    #[test]
    fn names_follow_omps_rules() {
        for ok in ["docs", "my-server_2", "cloudflare:api", "MaaS Slack", "a.b"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "two  spaces", " lead", "trail ", "a/b", "émoji", &"x".repeat(101)] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn editing_keeps_unknown_fields_auth_and_positions() {
        let stored = obj(
            r#"{"command":"npx","args":["-y","pkg"],"requestIdFormat":"string","env":{"API_KEY":"sk-1","MODE":"a"},"auth":{"type":"oauth","credentialId":"c1"},"instructions":false}"#,
        );
        let (mut d, extra) = to_draft(&stored);
        assert_eq!(extra, ["requestIdFormat", "instructions"]);
        assert_eq!(d.env[0].value, secrets::MASK);
        d.env[1].value = "b".into();
        d.args.push("--verbose".into());
        let mut entry = stored.clone();
        apply_draft(&mut entry, &d, Some(&stored)).unwrap();
        assert_eq!(
            compact(&J::Obj(entry)),
            r#"{"command":"npx","args":["-y","pkg","--verbose"],"requestIdFormat":"string","env":{"API_KEY":"sk-1","MODE":"b"},"auth":{"type":"oauth","credentialId":"c1"},"instructions":false}"#,
            "no `type` added to an implied-stdio entry; secret kept; unknown fields and auth untouched"
        );
    }

    #[test]
    fn switching_transport_drops_the_other_kinds_fields() {
        let stored = obj(r#"{"type":"stdio","command":"x","args":["a"],"env":{"A":"1"},"cwd":"/w","timeout":5000}"#);
        let mut d = draft(McpTransport::Http);
        d.url = Some("https://mcp.example.com/mcp".into());
        d.headers = vec![McpKeyValue { key: "Authorization".into(), value: "Bearer t".into(), secret: true }];
        d.timeout_ms = Some(5000);
        let mut entry = stored.clone();
        apply_draft(&mut entry, &d, Some(&stored)).unwrap();
        assert_eq!(compact(&J::Obj(entry)), r#"{"type":"http","timeout":5000,"url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer t"}}"#);
    }

    #[test]
    fn new_entries_are_written_in_a_readable_order() {
        let mut d = draft(McpTransport::Stdio);
        d.command = Some(" npx ".into());
        d.args = vec!["-y".into(), "@modelcontextprotocol/server-memory".into()];
        let mut entry = Obj::default();
        apply_draft(&mut entry, &d, None).unwrap();
        assert_eq!(compact(&J::Obj(entry)), r#"{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-memory"]}"#);
    }

    #[test]
    fn invalid_drafts_name_the_field() {
        let mut e = Obj::default();
        assert!(apply_draft(&mut e, &draft(McpTransport::Stdio), None).unwrap_err().message.starts_with("command:"));
        let mut d = draft(McpTransport::Sse);
        d.url = Some("ftp://x".into());
        assert!(apply_draft(&mut e, &d, None).unwrap_err().message.starts_with("url:"));
        d.url = Some("https://x.dev/sse".into());
        d.oauth = Some(McpOAuthSettings { client_id: None, client_secret: None, scope: None, callback_port: Some(0), redirect_uri: None });
        assert!(apply_draft(&mut e, &d, None).unwrap_err().message.starts_with("oauth.callbackPort"));
    }

    #[test]
    fn oauth_block_keeps_unknown_keys_and_hidden_secret() {
        let stored = obj(r#"{"type":"http","url":"https://x.dev/mcp","oauth":{"clientId":"id1","clientSecret":"cs","prompt":"none"}}"#);
        let (d, _) = to_draft(&stored);
        let o = d.oauth.clone().unwrap();
        assert_eq!((o.client_id.as_deref(), o.client_secret.as_deref()), (Some("id1"), Some(secrets::MASK)));
        let mut entry = stored.clone();
        apply_draft(&mut entry, &d, Some(&stored)).unwrap();
        assert_eq!(entry, stored, "an untouched edit is a no-op");
        let mut cleared = d.clone();
        cleared.oauth = None;
        apply_draft(&mut entry, &cleared, Some(&stored)).unwrap();
        assert_eq!(compact(entry.get("oauth").unwrap()), r#"{"prompt":"none"}"#, "omp's other oauth keys stay");
    }

    #[test]
    fn transport_inference_matches_omp() {
        assert_eq!(transport_of(&obj(r#"{"command":"x"}"#)), McpTransport::Stdio);
        assert_eq!(transport_of(&obj(r#"{"url":"https://x"}"#)), McpTransport::Http);
        assert_eq!(transport_of(&obj(r#"{"type":"sse","url":"https://x"}"#)), McpTransport::Sse);
        assert!(!entry_enabled(&obj(r#"{"enabled":"false"}"#)) && entry_enabled(&obj("{}")));
    }
}
