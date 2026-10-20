//! Collab link grammar (`omp-collab.md` §2, `protocol.ts` `parseCollabLink`/`formatCollabLink`).

use std::fmt;
use std::str::FromStr;

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

/// Default public relay; bare `<roomId>.<secret>` links resolve against it.
pub const DEFAULT_RELAY_URL: &str = "wss://my.omp.sh";
pub const ROOM_KEY_BYTES: usize = 32;
pub const WRITE_TOKEN_BYTES: usize = 16;

/// Lenient base64url (no padding required, non-canonical trailing bits accepted), like
/// `Buffer.from(s, "base64url")` for well-formed input.
pub(crate) const B64URL: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

pub(crate) fn b64url_encode(bytes: &[u8]) -> String {
    B64URL.encode(bytes)
}

/// A parsed collab link: where to connect and how to seal.
#[derive(Clone, PartialEq, Eq)]
pub struct CollabLink {
    /// `ws://host[:port]/r/<roomId>` or `wss://…` (no `?role=`).
    pub ws_url: String,
    pub room_id: String,
    /// AES-256-GCM room key.
    pub key: [u8; ROOM_KEY_BYTES],
    /// Present on full (control) links.
    pub write_token: Option<[u8; WRITE_TOKEN_BYTES]>,
}

impl fmt::Debug for CollabLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print secrets.
        f.debug_struct("CollabLink")
            .field("ws_url", &self.ws_url)
            .field("room_id", &self.room_id)
            .field("can_write", &self.can_write())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkError(pub String);

impl fmt::Display for LinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for LinkError {}

fn err(msg: impl Into<String>) -> LinkError {
    LinkError(msg.into())
}

fn is_b64url(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) fn is_room_id(s: &str) -> bool {
    (10..=64).contains(&s.len()) && is_b64url(s)
}

fn is_local_hostname(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// `^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$`
fn parse_bare(text: &str) -> Option<(&str, &str)> {
    let idx = text.find(['.', '#'])?;
    let (room, rest) = (&text[..idx], &text[idx + 1..]);
    (is_room_id(room) && is_b64url(rest)).then_some((room, rest))
}

/// `^/r/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$`
fn parse_room_path(path: &str) -> Option<(&str, Option<&str>)> {
    let rest = path.strip_prefix("/r/")?;
    match rest.split_once('.') {
        Some((room, secret)) => (is_room_id(room) && is_b64url(secret)).then_some((room, Some(secret))),
        None => is_room_id(rest).then_some((rest, None)),
    }
}

/// `normalizeRelayOrigin`: ws/wss/http/https → ws/wss origin; `ws` only for loopback names.
pub fn normalize_relay_origin(relay_url: &str) -> Result<String, LinkError> {
    let url = url::Url::parse(relay_url).map_err(|_| err(format!("Invalid relay URL: {relay_url}")))?;
    origin_of(&url)
}

fn origin_of(url: &url::Url) -> Result<String, LinkError> {
    let scheme = match url.scheme() {
        "wss" | "https" => "wss",
        "ws" | "http" => "ws",
        other => return Err(err(format!("Unsupported relay URL scheme: {other}:"))),
    };
    let host = url.host_str().unwrap_or("");
    if scheme == "ws" && !is_local_hostname(host) {
        return Err(err("relay link must be wss:// (plain ws:// is only allowed for localhost)"));
    }
    Ok(match url.port() {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    })
}

fn replace_pct23(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        if tail.len() >= 3 && tail[1..3].eq_ignore_ascii_case("23") {
            out.push('#');
            rest = &tail[3..];
        } else {
            out.push('%');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

impl CollabLink {
    /// Parse every link form omp emits or accepts (§2).
    pub fn parse(link: &str) -> Result<CollabLink, LinkError> {
        let mut text = replace_pct23(link.trim());
        if let Some((room, secret)) = parse_bare(&text) {
            text = format!("{DEFAULT_RELAY_URL}/r/{room}.{secret}");
        } else if !text.contains("://") {
            text = format!("wss://{text}");
        }
        let url = url::Url::parse(&text).map_err(|_| err(format!("Invalid collab link: {link}")))?;
        let fragment = url.fragment().unwrap_or("");
        let is_http = matches!(url.scheme(), "http" | "https");
        if is_http && !fragment.is_empty() {
            if let Ok(parsed) = CollabLink::parse(fragment) {
                return Ok(parsed);
            }
        }
        let origin = origin_of(&url)?;
        let Some((room_id, inline_secret)) = parse_room_path(url.path()) else {
            if !fragment.is_empty() && !is_http {
                return CollabLink::parse(fragment);
            }
            return Err(err("Collab link must contain a /r/<roomId> path"));
        };
        let secret_text = inline_secret.unwrap_or(fragment);
        if secret_text.is_empty() {
            return Err(err("Collab link is missing the <key> part"));
        }
        let bad_key = || err("Collab link key must be 32 (view) or 48 (full) base64url bytes");
        if !is_b64url(secret_text) {
            return Err(bad_key());
        }
        let secret = B64URL.decode(secret_text).map_err(|_| bad_key())?;
        if secret.len() != ROOM_KEY_BYTES && secret.len() != ROOM_KEY_BYTES + WRITE_TOKEN_BYTES {
            return Err(bad_key());
        }
        let mut key = [0u8; ROOM_KEY_BYTES];
        key.copy_from_slice(&secret[..ROOM_KEY_BYTES]);
        let write_token = (secret.len() > ROOM_KEY_BYTES).then(|| {
            let mut t = [0u8; WRITE_TOKEN_BYTES];
            t.copy_from_slice(&secret[ROOM_KEY_BYTES..]);
            t
        });
        Ok(CollabLink { ws_url: format!("{origin}/r/{room_id}"), room_id: room_id.to_owned(), key, write_token })
    }

    /// Full (control) link: carries the write token.
    pub fn can_write(&self) -> bool {
        self.write_token.is_some()
    }

    /// base64url write token for `hello.writeToken`.
    pub fn write_token_b64(&self) -> Option<String> {
        self.write_token.map(|t| b64url_encode(&t))
    }

    /// `ws(s)://host[:port]` part of [`Self::ws_url`].
    pub fn relay_origin(&self) -> &str {
        self.ws_url.strip_suffix(&format!("/r/{}", self.room_id)).unwrap_or(&self.ws_url)
    }

    /// The same room through a different relay origin (e.g. `ws://127.0.0.1:47466`).
    pub fn with_relay(&self, relay_url: &str) -> Result<CollabLink, LinkError> {
        let origin = normalize_relay_origin(relay_url)?;
        Ok(CollabLink { ws_url: format!("{origin}/r/{}", self.room_id), ..self.clone() })
    }

    /// Same room, view-only (drops the write token).
    pub fn view_only(&self) -> CollabLink {
        CollabLink { write_token: None, ..self.clone() }
    }

    /// Canonical `formatCollabLink` rendering.
    pub fn format(&self) -> String {
        let mut secret = self.key.to_vec();
        if let Some(t) = &self.write_token {
            secret.extend_from_slice(t);
        }
        let key_text = b64url_encode(&secret);
        let origin = self.relay_origin();
        if origin == DEFAULT_RELAY_URL {
            return format!("{}.{key_text}", self.room_id);
        }
        let compact = origin.strip_prefix("wss://").unwrap_or(origin);
        format!("{compact}/r/{}.{key_text}", self.room_id)
    }

    /// WebSocket URL for joining as a guest.
    pub fn guest_url(&self) -> String {
        format!("{}?role=guest", self.ws_url)
    }
}

impl FromStr for CollabLink {
    type Err = LinkError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        CollabLink::parse(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "r8VGC82KpJmTV1tMNhK7NQ";

    fn secret(full: bool) -> (String, [u8; 32], [u8; 16]) {
        let key: [u8; 32] = std::array::from_fn(|i| i as u8 + 1);
        let tok: [u8; 16] = std::array::from_fn(|i| 200 - i as u8);
        let mut v = key.to_vec();
        if full {
            v.extend_from_slice(&tok);
        }
        (b64url_encode(&v), key, tok)
    }

    #[test]
    fn secret_lengths() {
        assert_eq!(secret(true).0.len(), 64);
        assert_eq!(secret(false).0.len(), 43);
    }

    #[test]
    fn registry_deep_link() {
        let (s, key, tok) = secret(true);
        let l = CollabLink::parse(&format!("http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/{ROOM}.{s}")).unwrap();
        assert_eq!(l.ws_url, format!("ws://127.0.0.1:7466/r/{ROOM}"));
        assert_eq!(l.room_id, ROOM);
        assert_eq!(l.key, key);
        assert_eq!(l.write_token, Some(tok));
        assert!(l.can_write());
        assert_eq!(l.guest_url(), format!("ws://127.0.0.1:7466/r/{ROOM}?role=guest"));
        assert_eq!(l.format(), format!("ws://127.0.0.1:7466/r/{ROOM}.{s}"));
    }

    #[test]
    fn observed_registry_link_sample() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/research/omp-collab-samples/registry-link-control.json"
        ))
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let l = CollabLink::parse(v["url"].as_str().unwrap()).unwrap();
        assert!(l.can_write());
        assert!(l.ws_url.starts_with("ws://127.0.0.1:7466/r/"));
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/research/omp-collab-samples/registry-link-view.json"
        ))
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let l = CollabLink::parse(v["url"].as_str().unwrap()).unwrap();
        assert!(!l.can_write());
    }

    #[test]
    fn bare_forms_default_relay() {
        let (s, ..) = secret(false);
        for text in [format!("{ROOM}.{s}"), format!("{ROOM}#{s}"), format!("  {ROOM}%23{s}\n")] {
            let l = CollabLink::parse(&text).unwrap();
            assert_eq!(l.ws_url, format!("wss://my.omp.sh/r/{ROOM}"));
            assert!(!l.can_write());
            assert_eq!(l.format(), format!("{ROOM}.{s}"));
        }
    }

    #[test]
    fn schemeless_and_wss() {
        let (s, ..) = secret(true);
        let l = CollabLink::parse(&format!("relay.example.com:8443/r/{ROOM}.{s}")).unwrap();
        assert_eq!(l.ws_url, format!("wss://relay.example.com:8443/r/{ROOM}"));
        assert_eq!(l.format(), format!("relay.example.com:8443/r/{ROOM}.{s}"));
        let l = CollabLink::parse(&format!("https://relay.example.com/r/{ROOM}.{s}")).unwrap();
        assert_eq!(l.ws_url, format!("wss://relay.example.com/r/{ROOM}"));
        // default port is dropped like WHATWG URL
        let l = CollabLink::parse(&format!("wss://my.omp.sh:443/r/{ROOM}.{s}")).unwrap();
        assert_eq!(l.format(), format!("{ROOM}.{s}"));
    }

    #[test]
    fn legacy_fragment_secret_and_web_links() {
        let (s, ..) = secret(false);
        let l = CollabLink::parse(&format!("wss://relay.example.com/r/{ROOM}#{s}")).unwrap();
        assert_eq!(l.room_id, ROOM);
        let l = CollabLink::parse(&format!("https://my.omp.sh/#{ROOM}.{s}")).unwrap();
        assert_eq!(l.ws_url, format!("wss://my.omp.sh/r/{ROOM}"));
        // mangled %23 legacy second '#'
        let l = CollabLink::parse(&format!("https://my.omp.sh/#relay.example.com/r/{ROOM}%23{s}")).unwrap();
        assert_eq!(l.ws_url, format!("wss://relay.example.com/r/{ROOM}"));
        // http link whose fragment is not a link falls back to the direct form
        let l = CollabLink::parse(&format!("http://localhost:9/r/{ROOM}.{s}#junk")).unwrap();
        assert_eq!(l.ws_url, format!("ws://localhost:9/r/{ROOM}"));
        let l = CollabLink::parse(&format!("ws://[::1]:7466/r/{ROOM}.{s}")).unwrap();
        assert_eq!(l.ws_url, format!("ws://[::1]:7466/r/{ROOM}"));
    }

    #[test]
    fn rejections() {
        let (s, ..) = secret(true);
        let e = CollabLink::parse(&format!("ws://10.0.0.5:7466/r/{ROOM}.{s}")).unwrap_err();
        assert!(e.0.contains("must be wss://"), "{e}");
        assert!(CollabLink::parse(&format!("wss://x.example/q/{ROOM}.{s}")).unwrap_err().0.contains("/r/<roomId>"));
        assert!(CollabLink::parse(&format!("wss://x.example/r/{ROOM}")).unwrap_err().0.contains("missing"));
        assert!(CollabLink::parse(&format!("wss://x.example/r/{ROOM}.AAAA")).unwrap_err().0.contains("32 (view)"));
        assert!(CollabLink::parse(&format!("wss://x.example/r/short.{s}")).is_err());
        assert!(CollabLink::parse(&format!("ftp://x.example/r/{ROOM}.{s}")).is_err());
    }

    #[test]
    fn with_relay_and_view() {
        let (s, ..) = secret(true);
        let l = CollabLink::parse(&format!("{ROOM}.{s}")).unwrap();
        let local = l.with_relay("ws://127.0.0.1:47466").unwrap();
        assert_eq!(local.ws_url, format!("ws://127.0.0.1:47466/r/{ROOM}"));
        assert_eq!(local.relay_origin(), "ws://127.0.0.1:47466");
        assert!(!local.view_only().can_write());
        assert!(l.with_relay("ws://example.com").is_err());
        assert!(!format!("{l:?}").contains(&s));
    }
}
