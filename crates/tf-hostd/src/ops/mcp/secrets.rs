//! Credential-like values of MCP server definitions never leave the host: answers carry
//! [`MASK`] instead, and a draft that sends the mask back keeps the stored value.
//!
//! Masked: `env` and `headers` values whose name says credential (`…TOKEN`, `API_KEY`,
//! `Authorization`, `Cookie`, …) or whose value is a URL with a password; URL query values with
//! such names and URL passwords; the value of `--token=…` / `--api-key …` style arguments and
//! credential keys inside a JSON object argument (Smithery's `--config {…}`); the OAuth client
//! secret. Not masked: empty values, plain `${VAR}` references (the secret lives in the
//! environment, not here) and `!command` values (omp runs the command to get it).

use tf_proto::{ApiError, McpKeyValue};

use super::json::{self, Obj, J};

pub const MASK: &str = tf_proto::SECRET_MASK;

/// Words of a name (split on punctuation and camelCase), lowercase.
fn words(name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && prev_lower && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        cur.push(c.to_ascii_lowercase());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// A name that says its value is a credential.
pub fn secret_name(name: &str) -> bool {
    const WORDS: &[&str] = &[
        "token", "tokens", "secret", "secrets", "password", "passwd", "pass", "pwd", "passphrase", "key", "apikey", "auth", "authorization",
        "cookie", "session", "credential", "credentials", "private", "bearer", "jwt", "pat",
    ];
    words(name).iter().any(|w| WORDS.contains(&w.as_str()))
}

/// `${VAR}` (optionally after `Bearer `/`Token `/`Basic `) or `!command`: no secret in the value itself.
fn is_reference(value: &str) -> bool {
    let v = value.trim();
    if v.starts_with('!') {
        return true;
    }
    let v = ["Bearer ", "Token ", "Basic "].iter().find_map(|p| v.strip_prefix(p)).unwrap_or(v);
    let Some(inner) = v.strip_prefix("${").and_then(|r| r.strip_suffix('}')) else { return false };
    let mut chars = inner.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `scheme://user:password@…` anywhere in the value.
fn has_url_password(value: &str) -> bool {
    value.split("://").skip(1).any(|rest| {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        authority.rsplit_once('@').is_some_and(|(userinfo, _)| userinfo.split_once(':').is_some_and(|(_, p)| !p.is_empty()))
    })
}

/// Whether a value stored under `name` is masked in answers.
pub fn is_secret(name: &str, value: &str) -> bool {
    !value.is_empty() && value != MASK && !is_reference(value) && (secret_name(name) || has_url_password(value))
}

fn mask_value(name: &str, value: &str) -> (String, bool) {
    if is_secret(name, value) { (MASK.to_string(), true) } else { (value.to_string(), secret_name(name)) }
}

/// `env` / `headers` object → key/value list, secrets masked.
pub fn mask_kv(map: &Obj) -> Vec<McpKeyValue> {
    map.0
        .iter()
        .map(|(k, v)| {
            let raw = match v {
                J::Str(s) => s.clone(),
                other => json::compact(other),
            };
            let (value, secret) = mask_value(k, &raw);
            McpKeyValue { key: k.clone(), value, secret }
        })
        .collect()
}

/// A draft's key/value list → the object to store. A [`MASK`] value keeps the stored value of
/// that key. `headers` keys are case-insensitive (one per name).
pub fn unmask_kv(draft: &[McpKeyValue], stored: Option<&Obj>, what: &str, case_insensitive: bool) -> Result<Obj, ApiError> {
    let mut out = Obj::default();
    for kv in draft {
        let key = kv.key.trim();
        if key.is_empty() {
            if kv.value.is_empty() {
                continue; // an empty row
            }
            return Err(ApiError::new("invalid_params", format!("{what}: a value has no name")));
        }
        if key.chars().any(char::is_whitespace) && what == "headers" {
            return Err(ApiError::new("invalid_params", format!("headers: `{key}` is not a valid header name")));
        }
        if out.keys().any(|k| if case_insensitive { k.eq_ignore_ascii_case(key) } else { k == key }) {
            return Err(ApiError::new("invalid_params", format!("{what}: `{key}` is set twice")));
        }
        let value = if kv.value == MASK {
            match stored.and_then(|s| s.0.iter().find(|(k, _)| k == key)).map(|(_, v)| v) {
                Some(J::Str(s)) => s.clone(),
                Some(other) => json::compact(other),
                None => {
                    return Err(ApiError::new("invalid_params", format!("{what}: enter the value of `{key}` again")).with_hint("Its saved value is hidden and belongs to another name."));
                }
            }
        } else {
            if what == "headers" && kv.value.contains(['\r', '\n']) {
                return Err(ApiError::new("invalid_params", format!("headers: `{key}` has a line break in its value")));
            }
            kv.value.clone()
        };
        out.0.push((key.to_string(), J::Str(value)));
    }
    Ok(out)
}

/// Splits `scheme://[user[:pass]@]host…?query#frag` into (before query, query, fragment-with-#).
fn split_query(url: &str) -> (&str, Option<&str>, &str) {
    let (main, frag) = match url.find('#') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    };
    match main.split_once('?') {
        Some((base, q)) => (base, Some(q), frag),
        None => (main, None, frag),
    }
}

/// Percent-decoding for comparisons (`%E2%80%A2` is a bullet the browser may have encoded).
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_mask(raw: &str) -> bool {
    raw == MASK || pct_decode(raw) == MASK
}

/// The `user:password@` part of the authority (`None` without a password).
fn url_password(base: &str) -> Option<(usize, usize)> {
    let start = base.find("://")? + 3;
    let auth_end = base[start..].find('/').map(|i| start + i).unwrap_or(base.len());
    let at = base[start..auth_end].rfind('@')? + start;
    let colon = base[start..at].find(':')? + start;
    (colon + 1 < at).then_some((colon + 1, at))
}

/// URL with secret query values and the URL password masked.
pub fn mask_url(url: &str) -> String {
    let (base, query, frag) = split_query(url);
    let mut out = match url_password(base) {
        Some((s, e)) if !is_reference(&base[s..e]) => format!("{}{MASK}{}", &base[..s], &base[e..]),
        _ => base.to_string(),
    };
    if let Some(q) = query {
        out.push('?');
        let parts: Vec<String> = q
            .split('&')
            .map(|p| match p.split_once('=') {
                Some((k, v)) if is_secret(&pct_decode(k), &pct_decode(v)) => format!("{k}={MASK}"),
                _ => p.to_string(),
            })
            .collect();
        out.push_str(&parts.join("&"));
    }
    out.push_str(frag);
    out
}

/// A draft URL → the URL to store: masked query values and a masked password take the stored ones.
pub fn unmask_url(draft: &str, stored: Option<&str>) -> Result<String, ApiError> {
    if !draft.contains(MASK) && !draft.contains("%E2%80%A2") && !draft.contains("%e2%80%a2") {
        return Ok(draft.to_string());
    }
    let missing = || ApiError::new("invalid_params", "url: enter the hidden part of the address again").with_hint("Its saved value doesn't match this address.");
    let stored = stored.ok_or_else(missing)?;
    let (s_base, s_query, _) = split_query(stored);
    let (base, query, frag) = split_query(draft);
    let mut out = match url_password(base) {
        Some((s, e)) if is_mask(&base[s..e]) => {
            let (ss, se) = url_password(s_base).ok_or_else(missing)?;
            format!("{}{}{}", &base[..s], &s_base[ss..se], &base[e..])
        }
        _ => base.to_string(),
    };
    if let Some(q) = query {
        out.push('?');
        let stored_pairs: Vec<(&str, &str)> = s_query.unwrap_or_default().split('&').filter_map(|p| p.split_once('=')).collect();
        let mut parts = Vec::new();
        for p in q.split('&') {
            match p.split_once('=') {
                Some((k, v)) if is_mask(v) => {
                    let (_, sv) = stored_pairs.iter().find(|(sk, _)| *sk == k || pct_decode(sk) == pct_decode(k)).ok_or_else(missing)?;
                    parts.push(format!("{k}={sv}"));
                }
                _ => parts.push(p.to_string()),
            }
        }
        out.push_str(&parts.join("&"));
    }
    out.push_str(frag);
    if out.contains(MASK) {
        return Err(missing());
    }
    Ok(out)
}

/// `--name` / `-name` of a flag argument.
fn flag_name(arg: &str) -> Option<&str> {
    let a = arg.strip_prefix("--").or_else(|| arg.strip_prefix('-'))?;
    (!a.is_empty() && !a.starts_with('-')).then_some(a)
}

/// Masks string values under secret keys at any depth. Returns whether anything was masked.
fn mask_json(v: &mut J) -> bool {
    match v {
        J::Obj(o) => {
            let mut any = false;
            for (k, val) in o.0.iter_mut() {
                if let J::Str(s) = val
                    && is_secret(k, s)
                {
                    *s = MASK.to_string();
                    any = true;
                } else {
                    any |= mask_json(val);
                }
            }
            any
        }
        J::Arr(a) => a.iter_mut().fold(false, |any, x| mask_json(x) | any),
        _ => false,
    }
}

/// Fills [`MASK`] strings of `draft` from the same key path in `stored`. `false` when one has no counterpart.
fn unmask_json(draft: &mut J, stored: Option<&J>) -> bool {
    match draft {
        J::Str(s) if s == MASK => match stored {
            Some(J::Str(v)) => {
                *s = v.clone();
                true
            }
            _ => false,
        },
        J::Obj(o) => o.0.iter_mut().all(|(k, v)| unmask_json(v, stored.and_then(J::as_obj).and_then(|so| so.get(k)))),
        J::Arr(a) => a.iter_mut().enumerate().all(|(i, v)| unmask_json(v, stored.and_then(J::as_arr).and_then(|sa| sa.get(i)))),
        _ => true,
    }
}

fn json_object_arg(arg: &str) -> Option<J> {
    arg.trim_start().starts_with('{').then(|| json::parse(arg).ok()).flatten().filter(|j| matches!(j, J::Obj(_)))
}

/// Arguments with secret flag values and secret JSON keys masked.
pub fn mask_args(args: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut mask_next = false;
    for a in args {
        if std::mem::take(&mut mask_next) && !a.starts_with('-') && is_secret("token", a) {
            out.push(MASK.to_string());
            continue;
        }
        if let Some(name) = flag_name(a) {
            if let Some((n, v)) = name.split_once('=') {
                if is_secret(n, v) {
                    out.push(format!("{}={MASK}", &a[..a.len() - v.len() - 1]));
                    continue;
                }
            } else if secret_name(name) {
                mask_next = true;
            }
        } else if let Some(mut j) = json_object_arg(a)
            && mask_json(&mut j)
        {
            out.push(json::compact(&j));
            continue;
        }
        out.push(a.clone());
    }
    out
}

/// A draft's arguments → the ones to store: arguments still holding [`MASK`] take their stored value.
pub fn unmask_args(draft: &[String], stored: &[String]) -> Result<Vec<String>, ApiError> {
    let masked = mask_args(stored);
    let mut used = vec![false; stored.len()];
    let mut out = Vec::with_capacity(draft.len());
    for (i, a) in draft.iter().enumerate() {
        if !a.contains(MASK) {
            out.push(a.clone());
            continue;
        }
        let err = || {
            ApiError::new("invalid_params", format!("arguments: enter the hidden value of argument {} again", i + 1))
                .with_hint("TeleFlock can't match it to a saved value.")
        };
        // Unchanged argument (same place, else the first unused one that looks the same).
        let same = (i < masked.len() && !used[i] && masked[i] == *a).then_some(i).or_else(|| (0..masked.len()).find(|&j| !used[j] && masked[j] == *a));
        if let Some(j) = same {
            used[j] = true;
            out.push(stored[j].clone());
            continue;
        }
        // `--name=MASK` → the stored `--name=<value>`.
        if let Some(prefix) = a.strip_suffix(MASK).filter(|p| p.ends_with('=')) {
            let v = stored.iter().find(|s| s.starts_with(prefix)).ok_or_else(err)?;
            out.push(v.clone());
            continue;
        }
        // `--name MASK` → the value after the stored `--name`.
        if a == MASK
            && let Some(flag) = i.checked_sub(1).map(|p| &draft[p])
            && let Some(k) = stored.iter().position(|s| s == flag)
            && let Some(v) = stored.get(k + 1)
        {
            out.push(v.clone());
            continue;
        }
        // An edited JSON argument: fill its masked keys from a stored JSON argument.
        if let Some(mut j) = json_object_arg(a) {
            let candidates = (i..stored.len()).chain(0..i.min(stored.len()));
            let mut done = false;
            for k in candidates {
                if let Some(sj) = json_object_arg(&stored[k]) {
                    let mut trial = j.clone();
                    if unmask_json(&mut trial, Some(&sj)) {
                        j = trial;
                        done = true;
                        break;
                    }
                }
            }
            if done {
                out.push(json::compact(&j));
                continue;
            }
        }
        return Err(err());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(k: &str, v: &str) -> McpKeyValue {
        McpKeyValue { key: k.into(), value: v.into(), secret: false }
    }

    #[test]
    fn names_that_mean_credentials() {
        for n in ["GITHUB_PERSONAL_ACCESS_TOKEN", "OPENAI_API_KEY", "Authorization", "x-api-key", "exaApiKey", "clientSecret", "DB_PASSWORD", "Cookie", "SLACK_BOT_TOKEN"] {
            assert!(secret_name(n), "{n}");
        }
        for n in ["PATH", "NODE_ENV", "Accept", "keyboardLayout", "DEBUG", "monkeyPatch", "PORT", "Content-Type"] {
            assert!(!secret_name(n), "{n}");
        }
    }

    #[test]
    fn env_round_trip_keeps_hidden_values_and_never_shows_them() {
        let stored = Obj(vec![
            ("API_KEY".into(), J::str("sk-live-123")),
            ("REGION".into(), J::str("eu")),
            ("GH_TOKEN".into(), J::str("${GITHUB_TOKEN}")),
            ("DATABASE_URL".into(), J::str("postgres://app:hunter2@db/app")),
        ]);
        let listed = mask_kv(&stored);
        let shown: Vec<_> = listed.iter().map(|k| (k.key.as_str(), k.value.as_str(), k.secret)).collect();
        assert_eq!(
            shown,
            [("API_KEY", MASK, true), ("REGION", "eu", false), ("GH_TOKEN", "${GITHUB_TOKEN}", true), ("DATABASE_URL", MASK, true)],
            "references stay visible (but typed as secret); passwords in URLs are hidden"
        );
        assert!(!format!("{listed:?}").contains("sk-live") && !format!("{listed:?}").contains("hunter2"));
        // Saving the list back unchanged stores the original values.
        let back = unmask_kv(&listed, Some(&stored), "env", false).unwrap();
        assert_eq!(back, stored);
        // A new value replaces; a renamed key with a hidden value can't be resolved.
        let mut edited = listed.clone();
        edited[0].value = "sk-new".into();
        assert_eq!(unmask_kv(&edited, Some(&stored), "env", false).unwrap().str("API_KEY"), Some("sk-new"));
        let renamed = vec![kv("OTHER_KEY", MASK)];
        assert_eq!(unmask_kv(&renamed, Some(&stored), "env", false).unwrap_err().code, "invalid_params");
    }

    #[test]
    fn headers_are_unique_case_insensitively_and_single_line() {
        let dup = vec![kv("Authorization", "a"), kv("authorization", "b")];
        assert!(unmask_kv(&dup, None, "headers", true).unwrap_err().message.contains("twice"));
        assert!(unmask_kv(&[kv("X-A", "a\r\nX-Evil: 1")], None, "headers", true).is_err());
        assert!(unmask_kv(&[kv("", "")], None, "headers", true).unwrap().is_empty(), "empty rows are dropped");
    }

    #[test]
    fn url_secrets_are_masked_and_restored() {
        let stored = "https://user:pw@mcp.exa.ai/mcp?exaApiKey=abc123&tools=web_search#x";
        let shown = mask_url(stored);
        assert_eq!(shown, format!("https://user:{MASK}@mcp.exa.ai/mcp?exaApiKey={MASK}&tools=web_search#x"));
        assert_eq!(unmask_url(&shown, Some(stored)).unwrap(), stored);
        // Edited elsewhere, hidden values kept.
        let edited = shown.replace("tools=web_search", "tools=crawl");
        assert_eq!(unmask_url(&edited, Some(stored)).unwrap(), stored.replace("web_search", "crawl"));
        // A browser-encoded mask works too; a mask with nothing behind it does not.
        let encoded = shown.replace(MASK, "%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2");
        assert_eq!(unmask_url(&encoded, Some(stored)).unwrap(), stored);
        assert!(unmask_url(&format!("https://x.dev/mcp?token={MASK}"), Some("https://x.dev/mcp")).is_err());
        assert_eq!(mask_url("https://x.dev/mcp?token=${T}"), "https://x.dev/mcp?token=${T}", "references are not secrets");
    }

    #[test]
    fn argument_secrets_are_masked_and_restored() {
        let stored: Vec<String> = ["-y", "@smithery/cli", "run", "@x/y", "--key", "sk-1", "--api-token=tok-2", "--config", r#"{"apiKey":"k-3","region":"eu"}"#]
            .map(String::from)
            .to_vec();
        let shown = mask_args(&stored);
        assert_eq!(shown[5], MASK);
        assert_eq!(shown[6], format!("--api-token={MASK}"));
        assert_eq!(shown[8], format!(r#"{{"apiKey":"{MASK}","region":"eu"}}"#));
        assert!(!shown.join(" ").contains("sk-1") && !shown.join(" ").contains("tok-2") && !shown.join(" ").contains("k-3"));
        assert_eq!(unmask_args(&shown, &stored).unwrap(), stored, "unchanged args restore verbatim");
        // Inserted argument shifts indices; edited JSON keeps the hidden key.
        let mut edited = shown.clone();
        edited.insert(0, "--verbose".into());
        let last = edited.len() - 1;
        edited[last] = format!(r#"{{"apiKey":"{MASK}","region":"us"}}"#);
        let back = unmask_args(&edited, &stored).unwrap();
        assert_eq!(back[6], "sk-1");
        assert_eq!(back[7], "--api-token=tok-2");
        assert_eq!(back[last], r#"{"apiKey":"k-3","region":"us"}"#);
        assert!(unmask_args(&[MASK.to_string()], &[]).is_err());
    }

    #[test]
    fn plain_arguments_are_untouched() {
        let args: Vec<String> = ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/My Docs", "--port", "8080"].map(String::from).to_vec();
        assert_eq!(mask_args(&args), args);
    }
}
