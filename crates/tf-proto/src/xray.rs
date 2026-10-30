//! What fills an omp session's context window (`session.context`, architecture §3.20): the data
//! of omp's own `/context` viewer, from the TeleFlock bridge (≥ 2.1.0, `caps.context`).

use crate::Millis;

wire_enum! {
    /// * `omp`: omp's own breakdown, the data its `/context` viewer shows (omp ≥ 18.13.2).
    /// * `estimate`: an omp without that viewer: the bridge estimated each part itself and split
    ///   omp's reported usage by those estimates (no auto-compaction buffer).
    /// * `usage`: totals only (omp's reported usage; no categories).
    pub enum XraySource { Omp, Estimate, Usage }
}

wire_struct! {
    /// One block of the context: a system prompt block, a tool definition, a message part.
    pub struct XrayEntry {
        /// omp's entry id (unique in one breakdown).
        pub id: String,
        pub label: String,
        /// omp's note on its origin (a message's role conversion, a tool's source), when any.
        pub info: Option<String>,
        /// omp's estimate for this entry (not scaled to the session's usage).
        pub tokens: u64,
        /// The start of its text, whitespace collapsed (240 characters at most).
        pub preview: String,
        /// Characters in its full text.
        pub chars: u64,
        pub at: Option<Millis>,
        /// The tool call of a tool call or tool output entry.
        pub call_id: Option<String>,
    }
}

wire_struct! {
    /// Tool output of one tool.
    pub struct XrayGroup {
        pub label: String,
        /// Its share of the category's `tokens` (as omp's overview lists it).
        pub tokens: Option<u64>,
        /// omp's estimate (the attribution weight).
        pub weight: u64,
        pub entries: u32,
    }
}

wire_struct! {
    pub struct XrayCategory {
        /// omp's category id: `system-prompt`, `skills`, `built-in-tools`, `custom-tools`,
        /// `user-messages`, `assistant-messages`, `assistant-thinking`, `tool-calls`, `tool-output`.
        pub id: String,
        /// omp's overview label.
        pub label: String,
        /// The share of `used` omp attributes to the category: what its `/context` overview lists
        /// (absent when omp cannot attribute usage: it shows "—").
        pub tokens: Option<u64>,
        /// omp's own estimate for the category (the attribution weight).
        pub weight: u64,
        pub entries: u32,
        /// `tool-output`: per tool, biggest first.
        #[serde(default)]
        pub children: Vec<XrayGroup>,
        /// Its biggest entries, biggest first (5; tool output 10).
        #[serde(default)]
        pub top: Vec<XrayEntry>,
    }
}

wire_struct! {
    /// `session.context`.
    pub struct ContextXray {
        pub source: XraySource,
        /// The model omp computed it for (its name, else its id).
        pub model: Option<String>,
        /// Context window, tokens.
        pub window: u64,
        pub used: u64,
        /// omp's auto-compaction buffer.
        pub buffer: u64,
        pub free: u64,
        /// Where auto-compaction fires (absent: compaction off, or unknown).
        pub threshold: Option<u64>,
        /// In omp's order.
        pub categories: Vec<XrayCategory>,
        /// Image blocks in the context.
        pub images: u32,
        /// omp can drop them from the session (`/shake images`).
        pub drop_images: bool,
        /// snapcompact's estimated savings on the wire for the next request.
        pub snapcompact_saved: Option<u64>,
        /// When the bridge computed it (host time).
        pub at: Millis,
    }
}
