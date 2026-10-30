//! `teleflock://` URLs (desktop protocol handler, Android intent filter, notification taps).
//!
//! * `teleflock://agent/<hostId>/<agentId>`: open that agent.
//! * `teleflock://agent/<hostId>/<agentId>?n=<notificationId>`: a notification body tap; routed
//!   through `Engine::notification_action` (marks it handled and opens the agent).
//! * `teleflock://answer-next`: open the Answer-next HUD.
//! * `teleflock://capture`: open Quick capture (desktop; a desktop's own keyboard shortcut can run
//!   `teleflock teleflock://capture` where apps can't register one, e.g. Wayland).
//! * `teleflock://` / `teleflock://open`: just bring the app forward.
//!
//! Path segments are percent-encoded (agent ids contain `:`).

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use tauri::Url;

pub const SCHEME: &str = "teleflock";

/// Unreserved characters stay literal; everything else is escaped.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Agent { host_id: String, agent_id: String, notification_id: Option<String> },
    AnswerNext,
    Capture,
    Open,
}

pub fn agent_url(host_id: &str, agent_id: &str, notification_id: Option<&str>) -> String {
    let mut url = format!(
        "{SCHEME}://agent/{}/{}",
        utf8_percent_encode(host_id, SEGMENT),
        utf8_percent_encode(agent_id, SEGMENT)
    );
    if let Some(n) = notification_id {
        url.push_str("?n=");
        url.extend(utf8_percent_encode(n, SEGMENT));
    }
    url
}

pub fn parse(url: &Url) -> Option<Link> {
    if !url.scheme().eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    let decode = |s: &str| percent_decode_str(s).decode_utf8().ok().map(|c| c.into_owned());
    match url.host_str().unwrap_or("") {
        "agent" => {
            let mut segs = url.path_segments()?.filter(|s| !s.is_empty());
            let host_id = decode(segs.next()?)?;
            let agent_id = decode(segs.next()?)?;
            let notification_id = url
                .query_pairs()
                .find(|(k, _)| k == "n")
                .map(|(_, v)| v.into_owned())
                .filter(|v| !v.is_empty());
            Some(Link::Agent { host_id, agent_id, notification_id })
        }
        "answer-next" => Some(Link::AnswerNext),
        "capture" => Some(Link::Capture),
        _ => Some(Link::Open),
    }
}

/// A command-line argument that is the Quick capture link (a second instance's argv).
#[cfg_attr(mobile, allow(dead_code))]
pub fn is_capture(arg: &str) -> bool {
    Url::parse(arg).ok().and_then(|u| parse(&u)) == Some(Link::Capture)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_roundtrip() {
        let u = agent_url("aron-dev", "w1:p2", Some("n/42 x"));
        assert_eq!(u, "teleflock://agent/aron-dev/w1%3Ap2?n=n%2F42%20x");
        let link = parse(&Url::parse(&u).unwrap()).unwrap();
        assert_eq!(
            link,
            Link::Agent {
                host_id: "aron-dev".into(),
                agent_id: "w1:p2".into(),
                notification_id: Some("n/42 x".into())
            }
        );
    }

    #[test]
    fn other_links() {
        assert_eq!(parse(&Url::parse("teleflock://answer-next").unwrap()), Some(Link::AnswerNext));
        assert_eq!(parse(&Url::parse("teleflock://open").unwrap()), Some(Link::Open));
        assert_eq!(parse(&Url::parse("teleflock://capture").unwrap()), Some(Link::Capture));
        assert!(is_capture("teleflock://capture"));
        assert!(!is_capture("teleflock://open"));
        assert!(!is_capture("/usr/bin/teleflock"));
        assert_eq!(parse(&Url::parse("https://x.dev/").unwrap()), None);
        assert_eq!(parse(&Url::parse("teleflock://agent/h").unwrap()), None);
    }
}
