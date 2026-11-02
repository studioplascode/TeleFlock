//! A session's artifacts (`session.artifacts`, `session.artifact`; architecture §3.20): the files an
//! omp session and its subagents wrote into the session's artifacts dir (`<session>.jsonl` →
//! `<session>/`): `local://` files (plans, reports, notes and handoffs between agents), subagent
//! outputs (`agent://<id>`) and the handoff documents omp saved.

use crate::Millis;

wire_enum! {
    /// * `local`: a `local://` file (omp's session-scoped scratch space, `<artifacts>/local/…` at any
    ///   depth): plans (`<slug>-plan.md`), reports, handoffs between agents.
    /// * `agent`: a subagent's published output (`agent://<id>`: `<id>.md` next to its transcript).
    /// * `handoff`: a handoff document omp saved (`handoff-<time>.md`, automatic handoffs).
    pub enum ArtifactKind { Local, Agent, Handoff }
}

wire_struct! {
    pub struct ArtifactFile {
        pub kind: ArtifactKind,
        /// Root-relative and `/`-separated: the `local://` name (`plans/auth-plan.md`), or the path
        /// in the artifacts dir of an output (`Brainstorm/Brainstorm.Scout.md`) or a handoff.
        pub name: String,
        /// `local://<name>` or `agent://<id>`; absent for handoffs.
        pub url: Option<String>,
        pub size: u64,
        /// Last modified.
        pub mtime: Millis,
        /// The first Markdown heading in the first 4 KiB of a `.md` file.
        pub title: Option<String>,
    }
}

wire_struct! {
    /// `session.artifacts`.
    pub struct SessionArtifacts {
        /// The session's artifacts dir on the host (absent while omp names no session file).
        pub dir: Option<String>,
        /// Its `local://` root.
        pub local_root: Option<String>,
        /// Newest first.
        pub files: Vec<ArtifactFile>,
        /// More files exist than are listed (500 at most).
        pub truncated: bool,
    }
}

wire_struct! {
    /// `session.artifact`: one file `session.artifacts` lists. `name` is resolved inside its kind's
    /// root only (`local`: the `local://` root; else the artifacts dir): absolute paths, `..`,
    /// symlinks that leave the root and other kinds' files are refused.
    pub struct ArtifactParams {
        pub agent_id: String,
        pub kind: ArtifactKind,
        pub name: String,
        /// Bytes to return (default 1 MiB; text 4 MiB at most, `base64` 8 MiB).
        pub max_bytes: Option<u64>,
        /// Answer the file's bytes as base64 `data` instead of `text`, binary files included
        /// (images and the files a presented page references). Hosts before 0.9.0 ignore it.
        pub base64: Option<bool>,
    }
}

wire_struct! {
    /// `session.artifact`.
    pub struct ArtifactContent {
        pub kind: ArtifactKind,
        pub name: String,
        pub url: Option<String>,
        /// Absolute path on the host.
        pub path: String,
        pub size: u64,
        pub mtime: Millis,
        /// The file as UTF-8 text (absent for binary files and for `base64` reads).
        pub text: Option<String>,
        /// `base64` reads: the bytes read, base64-encoded (all of them unless `truncated`).
        pub data: Option<String>,
        /// `text` / `data` end before the end of the file (`maxBytes`).
        pub truncated: bool,
        /// Not text: a known binary type, NUL bytes or invalid UTF-8 in its first 8 KiB.
        pub binary: bool,
    }
}

wire_enum! {
    /// How the app shows a presented artifact (the `kind` the agent passed to `present`, or the one
    /// the bridge inferred from the file's extension).
    pub enum PresentKind { Html, Markdown, Svg, Image, Code, Csv, Json, Text }
}

wire_struct! {
    /// A document the agent showed the user with the bridge's `present` tool (bridge ≥ 2.3.0,
    /// architecture §3.32): an immutable snapshot in the session's `local://` root,
    /// `presented/<slug>-v<version>.<ext>`, with the files a page or Markdown document references
    /// relative to itself copied into `presented/<slug>-v<version>.files/`. Presenting the same title
    /// again adds the next version.
    pub struct PresentedArtifact {
        pub title: String,
        pub kind: PresentKind,
        /// `presented/q3-report-v2.html`: the `session.artifact` name (kind `local`).
        pub name: String,
        /// `local://presented/q3-report-v2.html`
        pub url: String,
        /// Shared by every version of one artifact (its title in lowercase ASCII with dashes).
        pub slug: String,
        /// 1, 2, …
        pub version: u32,
        /// Bytes of the snapshot.
        pub size: u64,
        /// `code`: the language (`rust`, `python`, …).
        pub language: Option<String>,
        /// The file the agent presented, as it named it (absent for inline content).
        pub source: Option<String>,
        /// Files copied into `presented/<slug>-v<version>.files/`.
        pub assets: u32,
    }
}

wire_struct! {
    /// `session.writeLocal`: saves a pasted text into the session's `local://` root as
    /// `paste-<n>.md` (omp's own "attach as file" choice for a large paste): `n` is one past the
    /// highest `paste-<n>.md` already there. The client never names the file.
    pub struct LocalWriteParams {
        pub agent_id: String,
        /// UTF-8 text, 1 B to 4 MiB.
        pub text: String,
    }
}

wire_struct! {
    /// `session.writeLocal`.
    pub struct LocalWritten {
        /// `paste-3.md` (root-relative, as `session.artifacts` names it).
        pub name: String,
        /// `local://paste-3.md`
        pub url: String,
        /// Absolute path on the host.
        pub path: String,
        /// Bytes written.
        pub size: u64,
    }
}
