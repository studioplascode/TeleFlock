//! Access control for the devserver (security review finding #1): `/ws` drives every host, so it
//! must not be reachable by other web origins (CSWSH), via DNS rebinding, or by other machines.
//!
//! * Every request must carry an allow-listed `Host` (defeats DNS rebinding).
//! * `/ws` needs the per-launch token, as `?token=<t>` or the subprotocol `teleflock.<t>`.
//! * `/ws` rejects any `Origin` other than the served origin (or an explicit `--allow-origin`).
//! * Binding a non-loopback address requires `--allow-remote`.

use std::net::{IpAddr, SocketAddr};

use axum::http::{HeaderMap, StatusCode, Uri, header};

/// Query parameter carrying the token (page URL and `/ws`).
pub const TOKEN_QUERY: &str = "token";
/// Subprotocol prefix carrying the token: `Sec-WebSocket-Protocol: teleflock.<t>`.
pub const TOKEN_SUBPROTOCOL_PREFIX: &str = "teleflock.";
/// `<meta name>` injected into the served `index.html`.
pub const TOKEN_META: &str = "tf-token";
/// Shortest accepted `--token` (22 base64url chars = 132 bits).
pub const MIN_TOKEN_LEN: usize = 22;

/// A fresh 256-bit token from the OS RNG, hex encoded (URL-, header- and HTML-attribute safe).
pub fn generate_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Validates a user-supplied `--token`: long enough, and only `[A-Za-z0-9_-]` so it is safe in a
/// URL query, a subprotocol name and an HTML attribute without escaping.
pub fn validate_token(token: &str) -> Result<(), String> {
    if token.len() < MIN_TOKEN_LEN {
        return Err(format!("--token must be at least {MIN_TOKEN_LEN} characters"));
    }
    if !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("--token may only contain A-Z, a-z, 0-9, `-` and `_`".into());
    }
    Ok(())
}

/// Refuses a non-loopback listen address unless remote access was explicitly requested.
pub fn check_bind(addr: SocketAddr, allow_remote: bool) -> Result<(), String> {
    if addr.ip().to_canonical().is_loopback() || allow_remote {
        return Ok(());
    }
    Err(format!(
        "refusing to listen on {addr}: it is not a loopback address, and anyone who can reach /ws \
         with the token controls every host. Pass --allow-remote to do it anyway (add \
         --allow-host <name> for each name clients use to reach it)."
    ))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AllowedHost {
    host: String,
    port: Option<u16>,
}

/// Request policy shared by every route.
#[derive(Clone, Debug)]
pub struct Access {
    token: String,
    addr: SocketAddr,
    allow_hosts: Vec<AllowedHost>,
    allow_origins: Vec<String>,
}

impl Access {
    /// `addr` is the bound address (its port is the one Host headers must carry).
    /// `allow_hosts`: extra Host names (`name` matches any port, `name:port` only that port).
    /// `allow_origins`: extra exact origins (`scheme://host[:port]`) allowed on `/ws`.
    pub fn new(token: String, addr: SocketAddr, allow_hosts: &[String], allow_origins: &[String]) -> Result<Self, String> {
        validate_token(&token)?;
        let allow_hosts = allow_hosts
            .iter()
            .map(|h| {
                split_authority(&h.to_ascii_lowercase())
                    .map(|(host, port)| AllowedHost { host: host.to_string(), port })
                    .ok_or_else(|| format!("bad --allow-host `{h}` (expected name or name:port)"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let allow_origins = allow_origins
            .iter()
            .map(|o| {
                let o = normalize_origin(o);
                match o.split_once("://") {
                    Some(("http" | "https", authority)) if split_authority(authority).is_some() => Ok(o),
                    _ => Err(format!("bad --allow-origin `{o}` (expected http[s]://host[:port])")),
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { token, addr, allow_hosts, allow_origins })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Constant-time token comparison.
    pub fn token_matches(&self, candidate: &str) -> bool {
        let (a, b) = (self.token.as_bytes(), candidate.as_bytes());
        a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }

    /// Whether the query string carries the right `token=`.
    pub fn query_token_ok(&self, query: Option<&str>) -> bool {
        query_param(query, TOKEN_QUERY).is_some_and(|t| self.token_matches(t))
    }

    /// Host allow-list: the bound IP, `localhost`, and loopback IP literals on the bound port (any
    /// IP literal when bound to the unspecified address), plus `--allow-host` entries. Names other
    /// than these are rejected, which defeats DNS rebinding.
    pub fn host_allowed(&self, authority: &str) -> bool {
        let lower = authority.to_ascii_lowercase();
        let Some((host, port)) = split_authority(&lower) else { return false };
        // Browsers omit the default port from Host.
        let port_ok = port.unwrap_or(80) == self.addr.port();
        if let Some(ip) = parse_ip_host(host) {
            let bind = self.addr.ip();
            if port_ok && (ip.to_canonical().is_loopback() || ip == bind || bind.is_unspecified()) {
                return true;
            }
        } else if host == "localhost" && port_ok {
            return true;
        }
        self.allow_hosts.iter().any(|a| {
            a.host == host
                && match (a.port, port) {
                    (None, _) => true,
                    (Some(p), Some(q)) => p == q,
                    (Some(p), None) => p == 80 || p == 443,
                }
        })
    }

    /// Whether `authority` names this machine's loopback (as opposed to an `--allow-host` name that
    /// may be a reverse proxy in front of the devserver).
    pub fn is_loopback_host(authority: &str) -> bool {
        let lower = authority.to_ascii_lowercase();
        match split_authority(&lower) {
            Some((host, _)) => host == "localhost" || parse_ip_host(host).is_some_and(|ip| ip.to_canonical().is_loopback()),
            None => false,
        }
    }

    /// `Origin` must be the origin the request was addressed to (`http[s]://<Host>`) or an explicit
    /// `--allow-origin`. `Host` is checked separately against the allow-list.
    pub fn origin_allowed(&self, origin: &str, host: &str) -> bool {
        let origin = normalize_origin(origin);
        if self.allow_origins.iter().any(|o| *o == origin) {
            return true;
        }
        match origin.split_once("://") {
            Some(("http" | "https", authority)) => authority == host.to_ascii_lowercase(),
            _ => false,
        }
    }

    /// Authorizes a `/ws` upgrade request. On success returns the subprotocol to echo (when the
    /// token came as `teleflock.<t>`); on failure the status and reason to reply with.
    pub fn authorize_ws(&self, headers: &HeaderMap, uri: &Uri) -> Result<Option<String>, (StatusCode, &'static str)> {
        let Some(host) = request_authority(headers, uri) else {
            return Err((StatusCode::MISDIRECTED_REQUEST, "missing Host header"));
        };
        if !self.host_allowed(host) {
            return Err((StatusCode::MISDIRECTED_REQUEST, "unexpected Host header"));
        }
        let mut origins = headers.get_all(header::ORIGIN).iter();
        let origin = origins.next();
        if origins.next().is_some() {
            return Err((StatusCode::FORBIDDEN, "multiple Origin headers"));
        }
        if let Some(origin) = origin {
            let ok = origin.to_str().is_ok_and(|o| self.origin_allowed(o, host));
            if !ok {
                return Err((StatusCode::FORBIDDEN, "cross-origin WebSocket requests are not allowed"));
            }
        }
        // Missing Origin means a non-browser client (browsers always send it); the token gates it.
        let protocol = headers
            .get_all(header::SEC_WEBSOCKET_PROTOCOL)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .map(str::trim)
            .find(|p| p.strip_prefix(TOKEN_SUBPROTOCOL_PREFIX).is_some_and(|t| self.token_matches(t)));
        if let Some(p) = protocol {
            return Ok(Some(p.to_string()));
        }
        if self.query_token_ok(uri.query()) {
            return Ok(None);
        }
        Err((StatusCode::UNAUTHORIZED, "missing or wrong token"))
    }
}

/// The request's authority: `Host` (HTTP/1.1), else the URI authority (HTTP/2 `:authority`).
pub fn request_authority<'a>(headers: &'a HeaderMap, uri: &'a Uri) -> Option<&'a str> {
    match headers.get(header::HOST) {
        Some(h) => h.to_str().ok(),
        None => uri.authority().map(|a| a.as_str()),
    }
}

/// First value of `name` in a raw query string (tokens are URL-safe, so no percent-decoding).
fn query_param<'a>(query: Option<&'a str>, name: &str) -> Option<&'a str> {
    query?.split('&').find_map(|kv| match kv.split_once('=') {
        Some((k, v)) if k == name => Some(v),
        _ => None,
    })
}

fn normalize_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// Splits `host[:port]` / `[v6][:port]`. Rejects empty hosts, bad ports and stray characters.
fn split_authority(authority: &str) -> Option<(&str, Option<u16>)> {
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let (host, rest) = authority.split_at(end + 1);
        match rest {
            "" => (host, None),
            _ => (host, Some(rest.strip_prefix(':')?)),
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    let valid = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '[' | ']' | ':');
    if host.is_empty() || !host.chars().all(valid) || (!host.starts_with('[') && host.contains(':')) {
        return None;
    }
    let port = match port {
        Some(p) => Some(p.parse::<u16>().ok()?),
        None => None,
    };
    Some((host, port))
}

/// An IP literal host (`127.0.0.1`, `[::1]`).
fn parse_ip_host(host: &str) -> Option<IpAddr> {
    match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(v6) => v6.parse::<std::net::Ipv6Addr>().ok().map(IpAddr::V6),
        None => host.parse::<std::net::Ipv4Addr>().ok().map(IpAddr::V4),
    }
}

/// Inserts `<meta name="tf-token" content="…">` right after `<head …>` (else after `<html …>`,
/// else at the start). `token` must be HTML-attribute safe (see [`validate_token`]).
pub fn inject_token_meta(html: &str, token: &str) -> String {
    let meta = format!(r#"<meta name="{TOKEN_META}" content="{token}">"#);
    let lower = html.to_ascii_lowercase();
    let at = tag_end(&lower, "<head").or_else(|| tag_end(&lower, "<html")).unwrap_or(0);
    let mut out = String::with_capacity(html.len() + meta.len());
    out.push_str(&html[..at]);
    out.push_str(&meta);
    out.push_str(&html[at..]);
    out
}

/// Byte offset just past the `>` of the first `tag` open tag (`<head>` but not `<header>`).
fn tag_end(lower: &str, tag: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(i) = lower[from..].find(tag) {
        let start = from + i + tag.len();
        match lower.as_bytes().get(start) {
            Some(b'>') => return Some(start + 1),
            Some(c) if c.is_ascii_whitespace() || *c == b'/' => return lower[start..].find('>').map(|j| start + j + 1),
            _ => from = start,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    const TOK: &str = "0123456789abcdef0123456789abcdef";

    fn access(bind: &str, hosts: &[&str], origins: &[&str]) -> Access {
        let hosts: Vec<String> = hosts.iter().map(|s| s.to_string()).collect();
        let origins: Vec<String> = origins.iter().map(|s| s.to_string()).collect();
        Access::new(TOK.into(), bind.parse().unwrap(), &hosts, &origins).unwrap()
    }

    #[test]
    fn bind_refuses_non_loopback_without_allow_remote() {
        for ok in ["127.0.0.1:7420", "[::1]:7420", "127.0.0.2:1", "[::ffff:127.0.0.1]:7420"] {
            assert!(check_bind(ok.parse().unwrap(), false).is_ok(), "{ok}");
        }
        for bad in ["0.0.0.0:7420", "[::]:7420", "100.64.1.2:7420", "192.168.1.5:80"] {
            let err = check_bind(bad.parse().unwrap(), false).unwrap_err();
            assert!(err.contains("--allow-remote"), "{err}");
            assert!(check_bind(bad.parse().unwrap(), true).is_ok(), "{bad}");
        }
    }

    #[test]
    fn generated_tokens_are_strong_and_unique() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(validate_token(&a).is_ok());
    }

    #[test]
    fn user_tokens_are_validated() {
        assert!(validate_token("short").is_err());
        assert!(validate_token("aaaaaaaaaaaaaaaaaaaaaa\"><script>").is_err());
        assert!(validate_token("aaaaaaaaaaaaaaaaaaaa a").is_err());
        assert!(validate_token("AZaz09-_AZaz09-_AZaz09").is_ok());
        assert!(Access::new("short".into(), "127.0.0.1:1".parse().unwrap(), &[], &[]).is_err());
    }

    #[test]
    fn token_comparison() {
        let a = access("127.0.0.1:7420", &[], &[]);
        assert!(a.token_matches(TOK));
        assert!(!a.token_matches(&TOK[..31]));
        assert!(!a.token_matches(&format!("{TOK}0")));
        assert!(!a.token_matches("0123456789abcdef0123456789abcdee"));
        assert!(a.query_token_ok(Some(&format!("x=1&token={TOK}"))));
        assert!(!a.query_token_ok(Some("token=")));
        assert!(!a.query_token_ok(None));
    }

    #[test]
    fn host_allow_list() {
        let a = access("127.0.0.1:7420", &["dev.example", "proxy.example:443"], &[]);
        for ok in [
            "127.0.0.1:7420",
            "localhost:7420",
            "LOCALHOST:7420",
            "[::1]:7420",
            "dev.example",
            "dev.example:9999",
            "proxy.example:443",
            "proxy.example",
        ] {
            assert!(a.host_allowed(ok), "{ok}");
        }
        for bad in [
            "",
            "localhost",
            "localhost:7421",
            "127.0.0.1:80",
            "evil.example:7420",
            "localhost.:7420",
            "localhost.evil.example:7420",
            "proxy.example:8443",
            "100.64.1.2:7420",
            "127.0.0.1:7420:1",
            "[::1]x:7420",
            "local host:7420",
        ] {
            assert!(!a.host_allowed(bad), "{bad}");
        }
        let tailnet = access("100.64.1.2:7420", &[], &[]);
        assert!(tailnet.host_allowed("100.64.1.2:7420"));
        assert!(!tailnet.host_allowed("100.64.1.3:7420"));
        let any = access("0.0.0.0:7420", &[], &[]);
        assert!(any.host_allowed("192.168.1.5:7420"));
        assert!(!any.host_allowed("192.168.1.5:7421"));
        assert!(!any.host_allowed("rebind.evil.example:7420"));
        assert!(Access::new(TOK.into(), "127.0.0.1:1".parse().unwrap(), &["a:b".into()], &[]).is_err());
    }

    #[test]
    fn origin_policy() {
        let a = access("127.0.0.1:7420", &[], &["http://localhost:5173"]);
        assert!(a.origin_allowed("http://127.0.0.1:7420", "127.0.0.1:7420"));
        assert!(a.origin_allowed("https://localhost:7420", "localhost:7420"));
        assert!(a.origin_allowed("http://localhost:5173/", "127.0.0.1:7420"));
        assert!(!a.origin_allowed("http://localhost:7420", "127.0.0.1:7420"));
        assert!(!a.origin_allowed("http://evil.example", "127.0.0.1:7420"));
        assert!(!a.origin_allowed("null", "127.0.0.1:7420"));
        assert!(!a.origin_allowed("file://", "127.0.0.1:7420"));
        assert!(!a.origin_allowed("http://127.0.0.1:7420.evil.example", "127.0.0.1:7420"));
        assert!(Access::new(TOK.into(), "127.0.0.1:1".parse().unwrap(), &[], &["evil".into()]).is_err());
    }

    fn ws_headers(host: &str, origin: Option<&str>, protocol: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(o) = origin {
            h.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
        }
        if let Some(p) = protocol {
            h.insert(header::SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_str(p).unwrap());
        }
        h
    }

    #[test]
    fn ws_authorization() {
        let a = access("127.0.0.1:7420", &[], &[]);
        let with_token: Uri = format!("/ws?token={TOK}").parse().unwrap();
        let bare: Uri = "/ws".parse().unwrap();
        let host = "127.0.0.1:7420";
        let same = Some("http://127.0.0.1:7420");
        assert_eq!(a.authorize_ws(&ws_headers(host, same, None), &with_token), Ok(None));
        assert_eq!(a.authorize_ws(&ws_headers(host, None, None), &with_token), Ok(None));
        let proto = format!("other, teleflock.{TOK}");
        assert_eq!(a.authorize_ws(&ws_headers(host, same, Some(&proto)), &bare), Ok(Some(format!("teleflock.{TOK}"))));
        let status = |r: Result<Option<String>, (StatusCode, &str)>| r.unwrap_err().0;
        assert_eq!(status(a.authorize_ws(&ws_headers(host, same, None), &bare)), StatusCode::UNAUTHORIZED);
        assert_eq!(status(a.authorize_ws(&ws_headers(host, same, Some("teleflock.nope")), &bare)), StatusCode::UNAUTHORIZED);
        assert_eq!(
            status(a.authorize_ws(&ws_headers(host, Some("http://evil.example"), None), &with_token)),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(a.authorize_ws(&ws_headers("evil.example:7420", Some("http://evil.example:7420"), None), &with_token)),
            StatusCode::MISDIRECTED_REQUEST
        );
        assert_eq!(status(a.authorize_ws(&HeaderMap::new(), &with_token)), StatusCode::MISDIRECTED_REQUEST);
    }

    #[test]
    fn meta_injection() {
        let m = format!(r#"<meta name="tf-token" content="{TOK}">"#);
        assert_eq!(
            inject_token_meta("<!doctype html><html><HEAD lang=x><title>t</title></head></html>", TOK),
            format!("<!doctype html><html><HEAD lang=x>{m}<title>t</title></head></html>")
        );
        assert_eq!(
            inject_token_meta("<html><body><header>h</header></body></html>", TOK),
            format!("<html>{m}<body><header>h</header></body></html>")
        );
        assert_eq!(inject_token_meta("plain", TOK), format!("{m}plain"));
    }

    #[test]
    fn loopback_host_names() {
        assert!(Access::is_loopback_host("localhost:7420"));
        assert!(Access::is_loopback_host("127.0.0.1:7420"));
        assert!(Access::is_loopback_host("[::1]:7420"));
        assert!(!Access::is_loopback_host("dev.example:7420"));
        assert!(!Access::is_loopback_host("100.64.1.2:7420"));
    }
}
