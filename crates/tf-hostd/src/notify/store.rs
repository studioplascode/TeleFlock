//! `<home>/notify.json`: the routing policy and the push channels with their secrets (0600,
//! atomic writes). Secrets never leave this file: [`StoredChannel::view`] lists which ones are
//! stored, and the saves merge write-only values (absent keeps, empty deletes).

use std::path::{Path, PathBuf};

use tf_proto::{ApiError, EscalateTo, NotifyKind, NotifyPolicy, PushChannel, PushChannelSave, PushKind, PushResult, PushWhen};
use tracing::warn;

/// Channels per host.
pub const MAX_CHANNELS: usize = 10;
/// Longest secret or URL accepted.
const MAX_SECRET: usize = 512;

pub fn default_policy() -> NotifyPolicy {
    NotifyPolicy { route: true, escalate_after_s: 300, escalate_to: EscalateTo::Phones }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChannel {
    pub id: String,
    pub kind: PushKind,
    pub name: String,
    pub enabled: bool,
    pub when: PushWhen,
    pub kinds: Vec<NotifyKind>,
    #[serde(default)]
    pub private: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<PushResult>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyFile {
    #[serde(default = "default_policy")]
    pub policy: NotifyPolicy,
    #[serde(default)]
    pub channels: Vec<StoredChannel>,
}

impl Default for NotifyFile {
    fn default() -> Self {
        NotifyFile { policy: default_policy(), channels: Vec::new() }
    }
}

pub fn path(home: &Path) -> PathBuf {
    home.join("notify.json")
}

/// Loads the file; a missing one is the defaults, an unreadable one too (logged, contents never).
pub fn load(path: &Path) -> NotifyFile {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            // Never `{e}`: serde quotes the offending value, which may be a secret.
            warn!("{}: unreadable ({:?} error at line {}); using the defaults until the next change", path.display(), e.classify(), e.line());
            NotifyFile::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => NotifyFile::default(),
        Err(e) => {
            warn!("{}: {e}; using the defaults", path.display());
            NotifyFile::default()
        }
    }
}

pub fn save(path: &Path, file: &NotifyFile) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| ApiError::new("internal", format!("encode notify.json: {e}")))?;
    crate::paths::write_atomic(path, &bytes).map_err(|e| ApiError::new("io_error", format!("write {}: {e}", path.display())))
}

pub fn validate_policy(p: &NotifyPolicy) -> Result<(), ApiError> {
    if p.escalate_after_s > 0 && !(5..=24 * 3600).contains(&p.escalate_after_s) {
        return Err(invalid("escalateAfterS: 0 (never), or 5 s to 24 h"));
    }
    Ok(())
}

fn invalid(msg: impl Into<String>) -> ApiError {
    ApiError::new("invalid_params", msg)
}

/// Merges a write-only secret: absent keeps, empty deletes, anything else replaces.
fn merge(stored: Option<String>, sent: Option<String>) -> Option<String> {
    match sent {
        None => stored,
        Some(v) if v.trim().is_empty() => None,
        Some(v) => Some(v.trim().to_string()),
    }
}

/// Applies a `notify.saveChannel` to the stored channels; returns the saved channel's id.
pub fn save_channel(channels: &mut Vec<StoredChannel>, s: PushChannelSave, new_id: impl FnOnce() -> String) -> Result<String, ApiError> {
    let existing = s.id.as_deref().map(|id| channels.iter().position(|c| c.id == id).ok_or_else(|| ApiError::new("not_found", format!("no push channel `{id}`"))));
    let prev = match existing {
        Some(Ok(i)) => Some(channels[i].clone()),
        Some(Err(e)) => return Err(e),
        None if channels.len() >= MAX_CHANNELS => return Err(invalid(format!("at most {MAX_CHANNELS} push channels per host"))),
        None => None,
    };
    // Secrets of another kind never carry over.
    let keep = prev.as_ref().filter(|p| p.kind == s.kind);
    let mut kinds: Vec<NotifyKind> = Vec::new();
    for k in s.kinds {
        if !kinds.contains(&k) {
            kinds.push(k);
        }
    }
    if kinds.is_empty() {
        return Err(invalid("kinds: choose at least one kind of notification"));
    }
    let name: String = s.name.trim().chars().take(60).collect();
    let ch = StoredChannel {
        id: prev.as_ref().map(|p| p.id.clone()).unwrap_or_else(new_id),
        kind: s.kind,
        name: if name.is_empty() { default_name(s.kind).to_string() } else { name },
        enabled: s.enabled,
        when: s.when,
        kinds,
        private: s.private,
        url: merge(keep.and_then(|p| p.url.clone()), s.url),
        token: merge(keep.and_then(|p| p.token.clone()), s.token),
        user: merge(keep.and_then(|p| p.user.clone()), s.user),
        secret: merge(keep.and_then(|p| p.secret.clone()), s.secret),
        last: keep.and_then(|p| p.last.clone()),
    };
    validate_channel(&ch)?;
    let id = ch.id.clone();
    match channels.iter_mut().find(|c| c.id == id) {
        Some(slot) => *slot = ch,
        None => channels.push(ch),
    }
    Ok(id)
}

fn default_name(kind: PushKind) -> &'static str {
    match kind {
        PushKind::Ntfy => "ntfy",
        PushKind::Pushover => "Pushover",
        PushKind::Webhook => "Webhook",
    }
}

fn check_secret(field: &str, v: &Option<String>) -> Result<(), ApiError> {
    if let Some(v) = v
        && (v.len() > MAX_SECRET || v.chars().any(|c| c.is_control() || c.is_whitespace()))
    {
        return Err(invalid(format!("{field}: up to {MAX_SECRET} characters, no spaces")));
    }
    Ok(())
}

pub fn validate_channel(c: &StoredChannel) -> Result<(), ApiError> {
    for (field, v) in [("url", &c.url), ("token", &c.token), ("user", &c.user), ("secret", &c.secret)] {
        check_secret(field, v)?;
    }
    match c.kind {
        PushKind::Ntfy => {
            let url = c.url.as_deref().ok_or_else(|| invalid("url: the ntfy topic URL, like https://ntfy.sh/your-topic"))?;
            NtfyTopic::parse(url)?;
            if c.user.is_some() || c.secret.is_some() {
                return Err(invalid("ntfy takes a topic URL and an optional access token"));
            }
        }
        PushKind::Pushover => {
            let key = |field: &str, v: &Option<String>, what: &str| match v.as_deref() {
                Some(k) if k.len() >= 20 && k.len() <= 40 && k.chars().all(|ch| ch.is_ascii_alphanumeric()) => Ok(()),
                Some(_) => Err(invalid(format!("{field}: the {what} is 30 letters and digits"))),
                None => Err(invalid(format!("{field}: the {what} is required"))),
            };
            key("user", &c.user, "Pushover user key")?;
            key("token", &c.token, "application API token")?;
            if c.url.is_some() || c.secret.is_some() {
                return Err(invalid("Pushover takes a user key and an application token"));
            }
        }
        PushKind::Webhook => {
            let url = c.url.as_deref().ok_or_else(|| invalid("url: the address to POST to"))?;
            Endpoint::parse(url, "url")?;
            if c.token.is_some() || c.user.is_some() {
                return Err(invalid("a webhook takes a URL and an optional signing secret"));
            }
        }
    }
    Ok(())
}

/// A checked http(s) URL. Plain http only to hosts on this machine or a private network: a
/// token or topic sent over the internet in clear text is as good as published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint<'a> {
    pub https: bool,
    /// `host[:port]`.
    pub authority: &'a str,
    /// Everything after the authority (starts with `/` when present).
    pub rest: &'a str,
}

impl<'a> Endpoint<'a> {
    pub fn parse(url: &'a str, field: &str) -> Result<Endpoint<'a>, ApiError> {
        let (https, after) = if let Some(r) = url.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            (false, r)
        } else {
            return Err(invalid(format!("{field}: an https:// address")));
        };
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        let (authority, rest) = after.split_at(end);
        if authority.is_empty() || authority.contains('@') {
            return Err(invalid(format!("{field}: an https:// address with a host name (no user:password@)")));
        }
        let ep = Endpoint { https, authority, rest };
        if !https && !ep.private_host() {
            return Err(invalid(format!("{field}: use https:// (plain http only to this machine or a private network)")));
        }
        Ok(ep)
    }

    pub fn host(&self) -> &'a str {
        let a = self.authority;
        if let Some(v6) = a.strip_prefix('[') {
            return v6.split(']').next().unwrap_or_default();
        }
        a.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(a, |(h, _)| h)
    }

    /// Loopback, RFC 1918, link-local, CGNAT / tailnet (100.64/10), IPv6 ULA, `.local`,
    /// `localhost` and single-label names.
    fn private_host(&self) -> bool {
        let host = self.host().to_ascii_lowercase();
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            return match ip {
                std::net::IpAddr::V4(v4) => {
                    let o = v4.octets();
                    v4.is_loopback() || v4.is_private() || v4.is_link_local() || (o[0] == 100 && (64..128).contains(&o[1]))
                }
                std::net::IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
            };
        }
        host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") || host.ends_with(".lan") || !host.contains('.')
    }
}

/// An ntfy topic URL split into the server's base (JSON publishing posts there) and the topic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NtfyTopic {
    /// `https://ntfy.sh/` or `https://example.com/ntfy/` (always ends with `/`).
    pub base: String,
    pub topic: String,
}

impl NtfyTopic {
    pub fn parse(url: &str) -> Result<NtfyTopic, ApiError> {
        let ep = Endpoint::parse(url, "url")?;
        let path = ep.rest.split(['?', '#']).next().unwrap_or_default().trim_end_matches('/');
        let (prefix, topic) = path.rsplit_once('/').unwrap_or(("", ""));
        if !valid_ntfy_id(topic) {
            return Err(invalid("url: the ntfy topic URL ends with the topic (letters, digits, - and _, up to 64), like https://ntfy.sh/your-topic"));
        }
        let scheme = if ep.https { "https" } else { "http" };
        Ok(NtfyTopic { base: format!("{scheme}://{}{prefix}/", ep.authority), topic: topic.to_string() })
    }
}

/// ntfy topics and sequence ids: `[-_A-Za-z0-9]{1,64}`.
pub fn valid_ntfy_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `tf-a…9z`: enough to recognise, too little to use.
fn mask(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 6 {
        return "…".into();
    }
    let head: String = chars[..3].iter().collect();
    let tail: String = chars[chars.len() - 2..].iter().collect();
    format!("{head}…{tail}")
}

impl StoredChannel {
    /// What the app sees: no secret values.
    pub fn view(&self) -> PushChannel {
        let mut saved = Vec::new();
        for (field, v) in [("url", &self.url), ("token", &self.token), ("user", &self.user), ("secret", &self.secret)] {
            if v.is_some() {
                saved.push(field.to_string());
            }
        }
        PushChannel {
            id: self.id.clone(),
            kind: self.kind,
            name: self.name.clone(),
            enabled: self.enabled,
            when: self.when,
            kinds: self.kinds.clone(),
            private: self.private,
            target: self.target(),
            saved,
            last: self.last.clone(),
        }
    }

    fn target(&self) -> String {
        let url = self.url.as_deref().unwrap_or_default();
        match self.kind {
            PushKind::Ntfy => match (Endpoint::parse(url, "url"), NtfyTopic::parse(url)) {
                (Ok(ep), Ok(t)) => format!("{} · topic {}", ep.host(), mask(&t.topic)),
                _ => "ntfy".into(),
            },
            PushKind::Pushover => "Pushover".into(),
            PushKind::Webhook => Endpoint::parse(url, "url").map(|ep| ep.host().to_string()).unwrap_or_else(|_| "webhook".into()),
        }
    }

    /// Every secret value of this channel (scrubbed from server answers before they are shown).
    pub fn secrets(&self) -> Vec<String> {
        let mut out: Vec<String> = [&self.token, &self.user, &self.secret, &self.url].into_iter().flatten().cloned().collect();
        if let Some(t) = self.url.as_deref().and_then(|u| NtfyTopic::parse(u).ok()) {
            out.push(t.topic);
        }
        out.retain(|s| s.len() >= 4);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save_params(id: Option<&str>, kind: PushKind) -> PushChannelSave {
        PushChannelSave {
            id: id.map(str::to_string),
            kind,
            name: " ".into(),
            enabled: true,
            when: PushWhen::Offline,
            kinds: vec![NotifyKind::Needs, NotifyKind::Needs, NotifyKind::Error],
            private: false,
            url: None,
            token: None,
            user: None,
            secret: None,
        }
    }

    #[test]
    fn secrets_are_write_only_and_merge() {
        let mut chans = Vec::new();
        let mut s = save_params(None, PushKind::Ntfy);
        s.url = Some("https://ntfy.sh/tf-secret-topic-9z".into());
        s.token = Some("tk_abcdef".into());
        let id = save_channel(&mut chans, s, || "c1".into()).unwrap();
        assert_eq!(id, "c1");
        let v = chans[0].view();
        assert_eq!((v.name.as_str(), v.target.as_str()), ("ntfy", "ntfy.sh · topic tf-…9z"));
        assert_eq!(v.saved, ["url", "token"]);
        assert_eq!(v.kinds, [NotifyKind::Needs, NotifyKind::Error], "deduplicated");
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("secret-topic") && !json.contains("tk_abcdef"), "{json}");

        // Absent keeps, empty deletes.
        let mut s = save_params(Some("c1"), PushKind::Ntfy);
        s.name = "Phone".into();
        save_channel(&mut chans, s, || unreachable!()).unwrap();
        assert_eq!(chans[0].token.as_deref(), Some("tk_abcdef"));
        let mut s = save_params(Some("c1"), PushKind::Ntfy);
        s.token = Some(String::new());
        save_channel(&mut chans, s, || unreachable!()).unwrap();
        assert_eq!((chans[0].token.as_deref(), chans[0].url.is_some()), (None, true));

        // Another kind starts without the old secrets.
        let mut s = save_params(Some("c1"), PushKind::Webhook);
        assert_eq!(save_channel(&mut chans, s.clone(), || unreachable!()).unwrap_err().message, "url: the address to POST to");
        s.url = Some("https://hooks.example.com/t/abc".into());
        s.secret = Some("shh".into());
        save_channel(&mut chans, s, || unreachable!()).unwrap();
        assert_eq!(chans[0].view().target, "hooks.example.com");
        assert_eq!(chans[0].view().saved, ["url", "secret"]);
        assert_eq!(save_channel(&mut chans, save_params(Some("nope"), PushKind::Ntfy), || unreachable!()).unwrap_err().code, "not_found");
    }

    #[test]
    fn urls_and_keys_are_checked() {
        let ok = |u: &str| NtfyTopic::parse(u).map(|t| (t.base, t.topic));
        assert_eq!(ok("https://ntfy.sh/tf_lab-1").unwrap(), ("https://ntfy.sh/".to_string(), "tf_lab-1".to_string()));
        assert_eq!(ok("https://example.com/ntfy/alerts/").unwrap(), ("https://example.com/ntfy/".to_string(), "alerts".to_string()));
        assert_eq!(ok("http://127.0.0.1:18737/lab").unwrap(), ("http://127.0.0.1:18737/".to_string(), "lab".to_string()));
        assert!(ok("http://ntfy.sh/tf").is_err(), "clear text over the internet");
        assert!(ok("https://ntfy.sh/").is_err() && ok("https://ntfy.sh/a b").is_err() && ok("ftp://x/y").is_err());
        assert!(ok("https://user:pw@ntfy.sh/t").is_err());
        for host in ["http://192.168.1.4/x", "http://100.101.1.2:8080/x", "http://nas/x", "http://box.local/x", "http://[::1]:9/x", "http://[fd00::1]/x"] {
            assert!(Endpoint::parse(host, "url").is_ok(), "{host}");
        }
        for host in ["http://8.8.8.8/x", "http://example.com/x", "http://[2001:db8::1]/x"] {
            assert!(Endpoint::parse(host, "url").is_err(), "{host}");
        }
        let mut c = StoredChannel {
            id: "p".into(),
            kind: PushKind::Pushover,
            name: "p".into(),
            enabled: true,
            when: PushWhen::Unseen,
            kinds: vec![NotifyKind::Needs],
            private: true,
            url: None,
            token: Some("azGDORePK8gMaC0QOYAMyEEuzJnyUi".into()),
            user: Some("uQiRzpo4DXghDmr9QzzfQu27cmVRsG".into()),
            secret: None,
            last: None,
        };
        validate_channel(&c).unwrap();
        c.user = Some("short".into());
        assert!(validate_channel(&c).unwrap_err().message.starts_with("user:"));
        c.user = Some("uQiRzpo4DXghDmr9QzzfQu27cmVRsG".into());
        c.token = Some("azGDORePK8gMaC0QOYAMyEE uzJnyUi".into());
        assert!(validate_channel(&c).unwrap_err().message.starts_with("token:"));
        assert!(validate_policy(&NotifyPolicy { route: true, escalate_after_s: 3, escalate_to: EscalateTo::All }).is_err());
        assert!(validate_policy(&NotifyPolicy { route: true, escalate_after_s: 0, escalate_to: EscalateTo::All }).is_ok());
    }

    #[test]
    fn the_file_is_owner_only_and_survives_a_round_trip() {
        let td = tempfile::tempdir().unwrap();
        let p = path(td.path());
        assert_eq!(load(&p), NotifyFile::default());
        let mut f = NotifyFile::default();
        let mut s = save_params(None, PushKind::Webhook);
        s.url = Some("https://hooks.example.com/x".into());
        save_channel(&mut f.channels, s, || "w".into()).unwrap();
        save(&p, &f).unwrap();
        assert_eq!(load(&p), f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&p, b"{not json").unwrap();
        assert_eq!(load(&p), NotifyFile::default());
    }
}
