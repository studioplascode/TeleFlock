//! Release order of tf-hostd builds, from their `tf-hostd --version` line
//! (`tf-hostd <semver> proto <n>`).
//!
//! Several devices share one daemon per host. Apps of different versions must agree on which
//! tf-hostd wins, or each one would redeploy its own build and restart the daemon under the
//! other (both drop every few seconds). The rule: a host only moves forward. An app never
//! replaces a newer tf-hostd, and the daemon refuses a `stop` from an older build while clients
//! are attached.

use std::cmp::Ordering;

/// Orders two version lines by semver precedence, then protocol. `None` when either is not a
/// well-formed `tf-hostd <semver> proto <n>` line (missing or broken binary).
pub fn cmp_lines(a: &str, b: &str) -> Option<Ordering> {
    let (va, pa) = parse_line(a)?;
    let (vb, pb) = parse_line(b)?;
    Some(cmp_semver(va, vb)?.then(pa.cmp(&pb)))
}

/// `tf-hostd 0.2.0 proto 1` → (`0.2.0`, 1).
fn parse_line(line: &str) -> Option<(&str, u32)> {
    let mut words = line.split_whitespace();
    let (Some("tf-hostd"), Some(version), Some("proto"), Some(proto), None) =
        (words.next(), words.next(), words.next(), words.next(), words.next())
    else {
        return None;
    };
    Some((version, proto.parse().ok()?))
}

/// Semver precedence of `MAJOR.MINOR.PATCH[-PRE][+BUILD]` strings (build metadata ignored).
pub fn cmp_semver(a: &str, b: &str) -> Option<Ordering> {
    let (ca, pa) = parse_semver(a)?;
    let (cb, pb) = parse_semver(b)?;
    Some(ca.cmp(&cb).then_with(|| match (pa, pb) {
        (None, None) => Ordering::Equal,
        // A pre-release precedes its release.
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => cmp_pre(x, y),
    }))
}

fn parse_semver(s: &str) -> Option<([u64; 3], Option<&str>)> {
    let s = s.split_once('+').map_or(s, |(v, _)| v);
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let mut parts = core.split('.');
    let mut out = [0u64; 3];
    for slot in &mut out {
        *slot = numeric(parts.next()?)?;
    }
    if parts.next().is_some() || pre.is_some_and(|p| p.split('.').any(str::is_empty)) {
        return None;
    }
    Some((out, pre))
}

fn numeric(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Dot-separated identifiers: numeric ones compare numerically and sort before alphanumeric
/// ones; a longer list wins when every shared identifier is equal.
fn cmp_pre(a: &str, b: &str) -> Ordering {
    let (mut ia, mut ib) = (a.split('.'), b.split('.'));
    loop {
        let (x, y) = match (ia.next(), ib.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => (x, y),
        };
        let o = match (numeric(x), numeric(y)) {
            (Some(n), Some(m)) => n.cmp(&m),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => x.cmp(y),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Ordering::*;

    #[test]
    fn semver_precedence() {
        let ordered = [
            "0.1.0",
            "0.2.0-alpha",
            "0.2.0-alpha.1",
            "0.2.0-alpha.beta",
            "0.2.0-beta",
            "0.2.0-beta.2",
            "0.2.0-beta.11",
            "0.2.0-rc.1",
            "0.2.0",
            "0.2.1",
            "0.10.0",
            "1.0.0",
        ];
        for w in ordered.windows(2) {
            assert_eq!(cmp_semver(w[0], w[1]), Some(Less), "{} < {}", w[0], w[1]);
            assert_eq!(cmp_semver(w[1], w[0]), Some(Greater), "{} > {}", w[1], w[0]);
        }
        assert_eq!(cmp_semver("0.2.0+abc", "0.2.0+def"), Some(Equal), "build metadata is ignored");
        for bad in ["", "0.2", "0.2.0.1", "v0.2.0", "0.2.x", "0.2.0-", "0.2.0-a..b", "+1.2.3"] {
            assert_eq!(cmp_semver(bad, "0.2.0"), None, "{bad:?}");
        }
    }

    #[test]
    fn version_lines() {
        assert_eq!(cmp_lines("tf-hostd 0.1.0 proto 1", "tf-hostd 0.2.0 proto 1"), Some(Less));
        assert_eq!(cmp_lines("tf-hostd 0.3.0 proto 1", "tf-hostd 0.2.0 proto 1"), Some(Greater));
        assert_eq!(cmp_lines("tf-hostd 0.2.0 proto 2", "tf-hostd 0.2.0 proto 1"), Some(Greater));
        assert_eq!(cmp_lines("tf-hostd 0.2.0 proto 1", "tf-hostd 0.2.0 proto 1"), Some(Equal));
        for bad in ["", "tf-hostd", "tf-hostd 0.2.0", "tf-hostd 0.2.0 proto", "tf-hostd 0.2.0 proto x", "tf-hostd 0.2.0 proto 1 extra", "omp 0.2.0 proto 1"] {
            assert_eq!(cmp_lines(bad, "tf-hostd 0.2.0 proto 1"), None, "{bad:?}");
        }
    }
}
