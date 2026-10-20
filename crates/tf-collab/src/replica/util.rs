//! Small tolerant JSON accessors and time helpers for the replica.

use serde_json::Value;
use tf_proto::Millis;

pub(crate) fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

pub(crate) fn non_empty<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    s(v, key).filter(|x| !x.trim().is_empty())
}

pub(crate) fn u(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| x.as_u64().or_else(|| x.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)))
}

pub(crate) fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

pub(crate) fn b(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub(crate) fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Message / entry timestamp: epoch ms number or RFC 3339 string.
pub(crate) fn ts(v: &Value) -> Option<Millis> {
    match v.get("timestamp")? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(t) => parse_rfc3339(t),
        _ => None,
    }
}

/// Minimal RFC 3339 → epoch ms (`2026-10-20T21:52:42.390Z`, offsets supported).
pub(crate) fn parse_rfc3339(t: &str) -> Option<Millis> {
    let b = t.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| t.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &t[start..i];
        let padded: String = frac.chars().chain(std::iter::repeat('0')).take(3).collect();
        ms = padded.parse().ok()?;
    }
    let offset_min = match b.get(i) {
        Some(b'Z') | Some(b'z') | None => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh: i64 = t.get(i + 1..i + 3)?.parse().ok()?;
            let om: i64 = t.get(i + 4..i + 6)?.parse().ok()?;
            let m = oh * 60 + om;
            if *sign == b'+' { m } else { -m }
        }
        _ => return None,
    };
    // days_from_civil (Howard Hinnant)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + sec) - offset_min * 60) * 1000 + ms)
}

/// Text of a `string | (TextContent|ImageContent)[]` content field.
pub(crate) fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            let mut out = String::new();
            for blk in blocks {
                if s(blk, "type") == Some("text") {
                    if let Some(t) = s(blk, "text") {
                        if !out.is_empty() && !out.ends_with('\n') {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Image blocks of a content field.
pub(crate) fn content_images(content: Option<&Value>) -> Vec<tf_proto::ImageRef> {
    let Some(Value::Array(blocks)) = content else { return Vec::new() };
    blocks
        .iter()
        .filter(|blk| s(blk, "type") == Some("image"))
        .map(|blk| tf_proto::ImageRef {
            mime: s(blk, "mimeType").unwrap_or("image/png").to_owned(),
            data: s(blk, "data").map(str::to_owned),
            url: None,
            width: None,
            height: None,
        })
        .collect()
}

/// Truncate to at most `max` chars (by char), appending `…`.
pub(crate) fn clip(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        return t.to_owned();
    }
    let mut out: String = t.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// First non-empty line.
pub(crate) fn first_line(text: &str) -> &str {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

/// Largest index `<= i` on a char boundary.
pub(crate) fn floor_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Language hint from a file extension.
pub(crate) fn lang_of(path: &str) -> Option<String> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    let lang = match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "py" => "python",
        "go" => "go",
        "rb" => "ruby",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "sh" | "bash" | "zsh" => "bash",
        "json" | "jsonl" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" | "markdown" => "markdown",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "sql" => "sql",
        "xml" => "xml",
        "lua" => "lua",
        "php" => "php",
        "zig" => "zig",
        "txt" => "text",
        _ => return None,
    };
    Some(lang.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339() {
        // 2026-10-20T21:54:06.786Z == 1792533246786 (matches the collab-prompt message timestamp in sample 01).
        assert_eq!(parse_rfc3339("2026-10-20T21:54:06.786Z"), Some(1792533246786));
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_rfc3339("2000-02-29T00:00:00.5Z"), Some(951782400500));
        assert_eq!(parse_rfc3339("nope"), None);
    }

    #[test]
    fn clip_and_lines() {
        assert_eq!(clip("  hello world ", 5), "hell…");
        assert_eq!(first_line("\n\n  a\nb"), "a");
        assert_eq!(floor_boundary("aé", 2), 1);
    }
}
