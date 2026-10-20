//! Terminal streams (herdr `terminal session control|observe` bridged by tf-hostd).

/// Output of an open terminal (`term.open`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "k", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum TermEvent {
    /// Re-rendered viewport update from herdr: base64 ANSI bytes.
    /// `full: true` frames clear and repaint the whole viewport. Feed `data` to xterm.js
    /// (scrollback 0; scroll through `term.scroll`).
    Frame { seq: u64, full: bool, cols: u16, rows: u16, data: String },
    Title { title: String },
    /// The stream ended (`detached`, `terminal attach taken over`, pane closed, …).
    Closed { reason: String },
    Error { message: String },
}

wire_enum! {
    /// `control` resizes the real pane and holds the single input lease;
    /// `observe` is read-only and crops instead of resizing.
    pub enum TermMode { Control, Observe }
}

wire_enum! {
    pub enum ScrollDirection { Up, Down }
}

wire_enum! {
    pub enum Split { Right, Down, Tab }
}
