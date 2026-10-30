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
        /// Text bytes to return (default 1 MiB, 4 MiB at most).
        pub max_bytes: Option<u64>,
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
        /// The file as UTF-8 text (absent for binary files).
        pub text: Option<String>,
        /// `text` ends before the end of the file (`maxBytes`).
        pub truncated: bool,
        /// Not text: a known binary type, NUL bytes or invalid UTF-8 in its first 8 KiB.
        pub binary: bool,
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
