//! Literal, case-folded text matching shared by `session.find` (transcript rows) and `search.*`
//! (session files). The app matches loaded rows with the same rules
//! (`src/features/session/find/match.ts`), so the counts agree.
//!
//! **Folding.** Case-insensitive matching compares each character's simple lowercase: one
//! character for one character (a character whose lowercase is longer, `İ`, stays as it is), so
//! a match in the folded text is a match at the same character positions of the original.
//! **Counting** is non-overlapping, left to right (`aaaa` holds `aa` twice).

use std::borrow::Cow;

use memchr::memmem::Finder;

/// One character's simple lowercase (itself when the full lowercase is longer).
pub fn fold_char(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let mut l = c.to_lowercase();
    match (l.next(), l.next()) {
        (Some(a), None) => a,
        _ => c,
    }
}

/// `s` with every character folded ([`fold_char`]); borrowed when nothing changes.
pub fn fold(s: &str) -> Cow<'_, str> {
    if !s.bytes().any(|b| b.is_ascii_uppercase() || b >= 0x80) {
        return Cow::Borrowed(s);
    }
    Cow::Owned(s.chars().map(fold_char).collect())
}

/// A query ready to match: literal text, folded unless case-sensitive.
pub struct Needle {
    /// The query, folded unless case-sensitive.
    text: String,
    case_sensitive: bool,
    finder: Finder<'static>,
}

impl std::fmt::Debug for Needle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Needle").field("text", &self.text).field("case_sensitive", &self.case_sensitive).finish()
    }
}

impl Needle {
    /// `None` for a query without anything but whitespace (nothing to look for).
    pub fn new(query: &str, case_sensitive: bool) -> Option<Needle> {
        if query.trim().is_empty() {
            return None;
        }
        let text = if case_sensitive { query.to_owned() } else { fold(query).into_owned() };
        let finder = Finder::new(text.as_bytes()).into_owned();
        Some(Needle { text, case_sensitive, finder })
    }

    /// The query as matched (folded unless case-sensitive).
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }

    /// Occurrences in `hay`, non-overlapping, at most `cap`.
    pub fn count_capped(&self, hay: &str, cap: usize) -> usize {
        if hay.len() < self.text.len() || cap == 0 {
            return 0;
        }
        let folded;
        let hay = if self.case_sensitive {
            hay
        } else {
            folded = fold(hay);
            &folded
        };
        self.finder.find_iter(hay.as_bytes()).take(cap).count()
    }

    /// Occurrences in `hay`, non-overlapping.
    pub fn count(&self, hay: &str) -> usize {
        self.count_capped(hay, usize::MAX)
    }

    /// Byte range of the first occurrence in `hay` (as written).
    pub fn find(&self, hay: &str) -> Option<(usize, usize)> {
        if self.case_sensitive {
            let at = self.finder.find(hay.as_bytes())?;
            return Some((at, at + self.text.len()));
        }
        // Folded characters may differ in UTF-8 length: map the match back character by character.
        let mut folded = String::with_capacity(hay.len());
        let mut starts: Vec<(usize, usize)> = Vec::with_capacity(hay.len());
        for (i, c) in hay.char_indices() {
            starts.push((folded.len(), i));
            folded.push(fold_char(c));
        }
        let at = self.finder.find(folded.as_bytes())?;
        let end = at + self.text.len();
        let orig = |f: usize| match starts.binary_search_by_key(&f, |s| s.0) {
            Ok(k) => starts[k].1,
            Err(k) => starts.get(k).map_or(hay.len(), |s| s.1),
        };
        Some((orig(at), orig(end)))
    }

    /// Whether the raw bytes of a JSON line can contain the query as text: a cheap filter before
    /// a line is parsed. Sound for text JSON encodes the way omp does (`JSON.stringify`: only `"`,
    /// `\` and control characters are escaped).
    pub fn prefilter(&self) -> Prefilter {
        let mut escaped = String::with_capacity(self.text.len() + 8);
        for c in self.text.chars() {
            match c {
                '"' => escaped.push_str("\\\""),
                '\\' => escaped.push_str("\\\\"),
                c => escaped.push(c),
            }
        }
        let ascii_ci = !self.case_sensitive && escaped.is_ascii();
        let unicode_ci = !self.case_sensitive && !ascii_ci;
        Prefilter { finder: Finder::new(escaped.as_bytes()).into_owned(), ascii_ci, unicode_ci, scratch: Vec::new() }
    }
}

/// Raw-line filter of [`Needle::prefilter`].
pub struct Prefilter {
    finder: Finder<'static>,
    /// Compare ASCII letters without case (the escaped query is ASCII).
    ascii_ci: bool,
    /// Fold the whole line first (a query with non-ASCII characters, case-insensitive).
    unicode_ci: bool,
    scratch: Vec<u8>,
}

impl Prefilter {
    pub fn may_match(&mut self, line: &[u8]) -> bool {
        if self.ascii_ci {
            self.scratch.clear();
            self.scratch.extend(line.iter().map(u8::to_ascii_lowercase));
            return self.finder.find(&self.scratch).is_some();
        }
        if self.unicode_ci {
            let text = String::from_utf8_lossy(line);
            return self.finder.find(fold(&text).as_bytes()).is_some();
        }
        self.finder.find(line).is_some()
    }
}

/// Text without terminal escapes, as the app shows tool output (`lib/ansi.ts` `stripAnsi`):
/// carriage-return overwrites resolved line by line, CSI / OSC / two-byte escapes and control
/// characters other than tab and newline dropped.
pub fn strip_ansi(s: &str) -> Cow<'_, str> {
    if !s.bytes().any(|b| (b < 0x20 && b != b'\n' && b != b'\t') || b == 0x7f) {
        return Cow::Borrowed(s);
    }
    let resolved = resolve_carriage_returns(s);
    let mut out = String::with_capacity(resolved.len());
    let mut chars = resolved.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            skip_escape(&mut chars);
            continue;
        }
        if (c < ' ' && c != '\n' && c != '\t') || c == '\x7f' {
            continue;
        }
        out.push(c);
    }
    Cow::Owned(out)
}

/// Skips the rest of an escape sequence after its ESC (the app's `ESC_RE`).
fn skip_escape(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    match chars.peek().copied() {
        Some('[') => {
            chars.next();
            while let Some(&c) = chars.peek() {
                if c.is_ascii_digit() || c == ';' || c == '?' || c == ':' {
                    chars.next();
                    continue;
                }
                if c.is_ascii_alphabetic() || c == '@' || c == '`' {
                    chars.next();
                }
                break;
            }
        }
        Some(']') => {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '\x07' {
                    break;
                }
                if c == '\x1b' {
                    if chars.peek() == Some(&'\\') {
                        chars.next();
                    }
                    break;
                }
            }
        }
        Some('(' | ')') => {
            chars.next();
            chars.next();
        }
        Some('=' | '>' | '7' | '8' | 'D' | 'E' | 'H' | 'M' | 'N' | 'O' | 'c') => {
            chars.next();
        }
        _ => {}
    }
}

/// Within each line, later carriage-return writes overwrite earlier ones from column 0.
fn resolve_carriage_returns(s: &str) -> Cow<'_, str> {
    if !s.contains('\r') {
        return Cow::Borrowed(s);
    }
    let s = s.replace("\r\n", "\n");
    let lines: Vec<String> = s
        .split('\n')
        .map(|line| {
            if !line.contains('\r') {
                return line.to_owned();
            }
            let mut out: Vec<char> = Vec::new();
            for part in line.split('\r') {
                let visible = visible_len(part);
                let mut next: Vec<char> = part.chars().collect();
                next.extend(out.iter().skip(visible));
                out = next;
            }
            out.into_iter().collect()
        })
        .collect();
    Cow::Owned(lines.join("\n"))
}

/// Characters of `s` without CSI sequences.
fn visible_len(s: &str) -> usize {
    let mut n = 0;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(c) = chars.next() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        n += 1;
    }
    n
}

/// Context characters kept before / after a match in a snippet.
pub const SNIPPET_BEFORE: usize = 56;
pub const SNIPPET_AFTER: usize = 96;

/// The first match of `needle` in `text` with up to [`SNIPPET_BEFORE`] / [`SNIPPET_AFTER`]
/// characters around it: `(before, hit, after)`, whitespace runs collapsed, cut ends marked `…`
/// (at a word boundary when one is near).
pub fn snippet(text: &str, needle: &Needle) -> Option<(String, String, String)> {
    let (s, e) = needle.find(text)?;
    let before = tail_chars(&text[..s], SNIPPET_BEFORE);
    let after = head_chars(&text[e..], SNIPPET_AFTER);
    Some((before, collapse(&text[s..e]), after))
}

fn tail_chars(s: &str, max: usize) -> String {
    let collapsed = collapse(s).trim_start().to_owned();
    let n = collapsed.chars().count();
    if n <= max {
        return collapsed;
    }
    let mut cut: String = collapsed.chars().skip(n - max).collect();
    // Start at a word when one begins within the first few characters.
    if let Some(sp) = cut.char_indices().take(16).find(|(_, c)| *c == ' ').map(|(i, _)| i) {
        cut = cut[sp + 1..].to_owned();
    }
    format!("…{cut}")
}

fn head_chars(s: &str, max: usize) -> String {
    let collapsed = collapse(s).trim_end().to_owned();
    let n = collapsed.chars().count();
    if n <= max {
        return collapsed;
    }
    let mut cut: String = collapsed.chars().take(max).collect();
    if let Some(sp) = cut.char_indices().rev().take(16).find(|(_, c)| *c == ' ').map(|(i, _)| i) {
        cut.truncate(sp);
    }
    format!("{cut}…")
}

/// Whitespace runs (newlines included) as one space.
pub fn collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
            continue;
        }
        space = false;
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_keeps_positions_and_counts_without_overlap() {
        let n = Needle::new("Straße", false).unwrap();
        assert_eq!(n.text(), "straße");
        assert_eq!(n.count("STRASSE straße STRAßE"), 2, "simple lowercase: ẞ/ß fold, SS does not");
        assert_eq!(Needle::new("aa", false).unwrap().count("aaaa aAa"), 3);
        assert_eq!(Needle::new("aa", true).unwrap().count("aaaa aAa"), 2);
        // İ lowercases to two characters: it stays, so nothing shifts.
        assert_eq!(fold("İx"), "İx");
        let n = Needle::new("x", false).unwrap();
        assert_eq!(n.find("İX"), Some((2, 3)));
        // Kelvin sign folds to an ASCII k (3 bytes → 1): the range maps back to the original bytes.
        let n = Needle::new("k1", false).unwrap();
        let hay = "a \u{212A}1 b";
        assert_eq!(n.find(hay).map(|(s, e)| &hay[s..e]), Some("\u{212A}1"));
        assert!(Needle::new("  \t", false).is_none());
        assert_eq!(Needle::new("x", false).unwrap().count_capped("xxxxxx", 4), 4);
    }

    #[test]
    fn prefilter_sees_escaped_and_folded_text() {
        let n = Needle::new("say \"Hi\"\\", false).unwrap();
        let mut pf = n.prefilter();
        assert!(pf.may_match(br#"{"text":"we SAY \"hi\"\\ twice"}"#));
        assert!(!pf.may_match(br#"{"text":"we say hi"}"#));
        let n = Needle::new("Über", false).unwrap();
        let mut pf = n.prefilter();
        assert!(pf.may_match("{\"text\":\"ÜBERALL\"}".as_bytes()));
        let n = Needle::new("Foo", true).unwrap();
        let mut pf = n.prefilter();
        assert!(pf.may_match(b"{\"text\":\"Foo\"}") && !pf.may_match(b"{\"text\":\"foo\"}"));
    }

    #[test]
    fn ansi_is_stripped_like_the_app() {
        assert_eq!(strip_ansi("\x1b[31merror\x1b[0m: \x1b]0;title\x07done"), "error: done");
        assert_eq!(strip_ansi("10%\r55%\r100%\nok"), "100%\nok");
        assert_eq!(strip_ansi("abcdef\rXY"), "XYcdef");
        assert_eq!(strip_ansi("a\x08b\x1b(Bc"), "abc");
        assert!(matches!(strip_ansi("plain\ttext\n"), Cow::Borrowed(_)));
    }

    #[test]
    fn snippets_cut_at_words_and_collapse_whitespace() {
        let n = Needle::new("needle", false).unwrap();
        let (b, h, a) = snippet("A short line with a Needle\n\n  in it", &n).unwrap();
        assert_eq!((b.as_str(), h.as_str(), a.as_str()), ("A short line with a ", "Needle", " in it"));
        let long = format!("{} the needle {}", "word ".repeat(40), "tail ".repeat(60));
        let (b, h, a) = snippet(&long, &n).unwrap();
        assert!(b.starts_with('…') && b.ends_with("the ") && b.chars().count() <= SNIPPET_BEFORE + 1, "{b:?}");
        assert_eq!(h, "needle");
        assert!(a.ends_with('…') && a.starts_with(" tail") && a.chars().count() <= SNIPPET_AFTER + 1, "{a:?}");
        assert!(!b.contains("  ") && !a.contains("  "));
    }
}
