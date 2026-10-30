//! Find in a session and search every session (architecture §3.27).
//!
//! * [`text`]: literal, case-folded matching, ANSI stripping and snippets (shared).
//! * [`rows`]: what `session.find` searches in a transcript row.
//! * [`scan`]: one session file searched line by line (`search.*`).
//! * [`search`]: background searches, their caps, long polls and cancellation.
//! * [`files`]: rows of a session file read from disk (preview, parked agents).
//!
//! The method handlers are `ops/search.rs`.

pub mod files;
pub mod rows;
pub mod scan;
pub mod search;
pub mod text;
