//! JSON from JavaScript with lone UTF-16 surrogates in it.
//!
//! A JS string can hold a lone surrogate (half of a pair): omp cuts text by UTF-16 index in
//! places (its subagent completion probe's 80-character `stage`, `truncate()` for job widget
//! labels, the 8 KiB `recentOutput` tail of a subagent's progress), so an emoji at the cut leaves
//! half of it behind. `JSON.stringify` writes such a string as valid JSON text with a `\udXXX`
//! escape, which serde_json refuses to decode into a Rust string. tf-hostd then dropped every
//! bridge frame that carried one, and every resync too while the value stayed in flight (a
//! running `wait` repeats its jobs' stages every 500 ms; the bridge replays each subagent's last
//! progress in every resync): the session stopped updating for good while it still looked live.
//! These decoders repair each lone surrogate escape to U+FFFD (what `String.toWellFormed` does in
//! JS) when, and only when, the strict decode failed.

use std::sync::atomic::{AtomicU32, Ordering};

use serde::de::DeserializeOwned;

/// Repairs logged at info level (the rest at debug): a running `wait` can repeat one every 500 ms.
const LOGGED: u32 = 20;

/// [`serde_json::from_str`], and once more with lone surrogate escapes repaired when it failed
/// and the line has some.
pub fn from_str<T: DeserializeOwned>(line: &str) -> serde_json::Result<T> {
    match serde_json::from_str(line) {
        Ok(v) => Ok(v),
        Err(e) => match well_formed(line) {
            Some((fixed, n)) => {
                let v = serde_json::from_str(&fixed)?;
                note(n);
                Ok(v)
            }
            None => Err(e),
        },
    }
}

/// [`from_str`] for bytes (a session file line).
pub fn from_slice<T: DeserializeOwned>(bytes: &[u8]) -> serde_json::Result<T> {
    match serde_json::from_slice(bytes) {
        Ok(v) => Ok(v),
        Err(e) => match std::str::from_utf8(bytes).ok().and_then(well_formed) {
            Some((fixed, n)) => {
                let v = serde_json::from_str(&fixed)?;
                note(n);
                Ok(v)
            }
            None => Err(e),
        },
    }
}

fn note(n: usize) {
    static REPAIRS: AtomicU32 = AtomicU32::new(0);
    if REPAIRS.fetch_add(1, Ordering::Relaxed) < LOGGED {
        tracing::info!("repaired {n} lone UTF-16 surrogate(s) in JSON from omp (now U+FFFD)");
    } else {
        tracing::debug!("repaired {n} lone UTF-16 surrogate(s) in JSON from omp (now U+FFFD)");
    }
}

/// `json` with every `\u` escape of a lone surrogate (a high one not followed by a low one, a low
/// one not preceded by a high one) replaced by `\ufffd`, and how many; `None` when it has none.
/// Escapes are only read inside strings, so an escaped backslash before `u` stays text.
pub fn well_formed(json: &str) -> Option<(String, usize)> {
    let b = json.as_bytes();
    let unit = |i: usize| -> Option<u16> {
        let hex = b.get(i..i + 6)?;
        if hex[0] != b'\\' || hex[1] != b'u' {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(&hex[2..]).ok()?, 16).ok()
    };
    let (mut out, mut copied, mut fixed) = (String::new(), 0, 0);
    let (mut i, mut in_string) = (0, false);
    while i < b.len() {
        match b[i] {
            b'"' => {
                in_string = !in_string;
                i += 1;
            }
            b'\\' if in_string => match unit(i) {
                Some(0xD800..=0xDBFF) if unit(i + 6).is_some_and(|lo| (0xDC00..=0xDFFF).contains(&lo)) => i += 12,
                Some(0xD800..=0xDFFF) => {
                    out.push_str(&json[copied..i]);
                    out.push_str("\\ufffd");
                    i += 6;
                    copied = i;
                    fixed += 1;
                }
                Some(_) => i += 6,
                // `\"`, `\\` and the other one-character escapes.
                None => i += 2,
            },
            _ => i += 1,
        }
    }
    if fixed == 0 {
        return None;
    }
    out.push_str(&json[copied..]);
    Some((out, fixed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn lone_surrogates_become_replacement_characters() {
        // What Bun's JSON.stringify writes for "stage: Querverweise prüfen 🔍…" cut inside the emoji
        // (a high surrogate left alone before the ellipsis), and for a tail that starts with the
        // low half.
        let high = r#"{"stage":"Querverweise prüfen \ud83d…","n":1}"#;
        let low = r#"{"recentOutput":["\ude80 weiter"]}"#;
        assert!(serde_json::from_str::<Value>(high).is_err(), "serde_json refuses it");
        assert!(serde_json::from_str::<Value>(low).is_err(), "serde_json refuses it");
        assert_eq!(from_str::<Value>(high).unwrap(), json!({ "stage": "Querverweise prüfen \u{fffd}…", "n": 1 }));
        assert_eq!(from_str::<Value>(low).unwrap(), json!({ "recentOutput": ["\u{fffd} weiter"] }));
        assert_eq!(from_slice::<Value>(high.as_bytes()).unwrap()["stage"], "Querverweise prüfen \u{fffd}…");
    }

    #[test]
    fn pairs_text_and_other_escapes_stay() {
        // A pair written as escapes, an escaped backslash before `u` (text, not an escape), quotes.
        let line = r#"{"a":"\ud83d\ude80 ok","b":"C:\\udir \"x\" \\\ud83d","c":"\u00fc"}"#;
        let (fixed, n) = well_formed(line).unwrap();
        assert_eq!(n, 1, "only the lone high surrogate after `\\\\`");
        let v: Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(v, json!({ "a": "🚀 ok", "b": "C:\\udir \"x\" \\\u{fffd}", "c": "ü" }));
        assert_eq!(well_formed(r#"{"a":"\ud83d\ude80","b":"\\ud800"}"#), None, "nothing to repair");
        // Lines that fail for other reasons keep failing.
        assert!(from_str::<Value>(r#"{"a":"\ud83d"#).is_err());
        assert!(from_str::<Value>("{not json}").is_err());
    }

    #[test]
    fn two_lone_halves_in_a_row() {
        // A low half then a high half: neither forms a pair in that order.
        let line = r#"["\ude80\ud83d","\ud83d\ud83d\ude80"]"#;
        assert_eq!(from_str::<Value>(line).unwrap(), json!(["\u{fffd}\u{fffd}", "\u{fffd}🚀"]));
    }
}
