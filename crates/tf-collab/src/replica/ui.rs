//! Collab `ui-request`s → tf-proto [`UiRequest`] / [`NeedsYou`], and tf-proto [`Answer`]s →
//! exact `ui-response` values (`omp-collab.md` §7).
//!
//! * ask selects: sentinels `Other (type your own)` → `allowOther`, `Chat about this` →
//!   `allowChat`, `Next →` (checkbox submit) hidden; `selectionMarker: checkbox` → multi-select.
//! * approvals: titles starting `Allow tool:` → approval options (`Approve…` primary, `Deny` danger).
//! * editors → `editor`.
//!
//! Multi-step answers are driven here: "Other" answers send the sentinel and then the text to the
//! follow-up `Custom answer:` editor; multi-select answers toggle one label per round (each round is
//! a new reqId) and finish with `Next →`. Intermediate rounds stay hidden from clients.

use std::collections::BTreeMap;

use tf_proto::{Answer, ApiError, Millis, NeedsKind, NeedsOption, NeedsYou, OptionTone, UiKind, UiRequest};

use crate::frame::{SelectItem, UiRequestFrame};

pub const OTHER_LABEL: &str = "Other (type your own)";
pub const CHAT_LABEL: &str = "Chat about this";
pub const NEXT_LABEL: &str = "Next →";
pub const CUSTOM_ANSWER_PREFIX: &str = "Custom answer: ";
pub const APPROVAL_PREFIX: &str = "Allow tool: ";

/// A `ui-response` to send through [`crate::Guest::ui_response`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiReply {
    pub req_id: u64,
    /// Exact option label or editor text; `None` cancels.
    pub value: Option<String>,
}

#[derive(Debug, Clone)]
struct Pending {
    frame: UiRequestFrame,
    req: UiRequest,
    needs: NeedsYou,
    hidden: bool,
}

#[derive(Debug, Clone)]
enum Driver {
    /// Sent "Other"; answer the next `Custom answer:` editor with `text`.
    Other { text: String },
    /// Checkbox loop for `title` toward the `want` set.
    Multi { title: String, want: Vec<String> },
}

#[derive(Debug, Default)]
pub(crate) struct UiState {
    pending: BTreeMap<u64, Pending>,
    driver: Option<Driver>,
    replies: Vec<UiReply>,
}

fn invalid(msg: impl Into<String>) -> ApiError {
    ApiError::new("invalid_params", msg)
}

fn labels(frame: &UiRequestFrame) -> Vec<&str> {
    match frame {
        UiRequestFrame::Select { options, .. } => options.iter().map(SelectItem::label).collect(),
        UiRequestFrame::Editor { .. } => Vec::new(),
    }
}

fn is_checkbox(frame: &UiRequestFrame) -> bool {
    matches!(frame, UiRequestFrame::Select { selection_marker: Some(m), .. } if m == "checkbox")
}

fn checked(frame: &UiRequestFrame) -> Vec<&str> {
    match frame {
        UiRequestFrame::Select { options, checked_indices: Some(ix), .. } => {
            ix.iter().filter_map(|i| options.get(*i as usize)).map(SelectItem::label).collect()
        }
        _ => Vec::new(),
    }
}

/// Next toggle (or submit) for a checkbox round.
fn multi_step(frame: &UiRequestFrame, want: &[String]) -> Result<String, ApiError> {
    let opts = labels(frame);
    let on = checked(frame);
    if let Some(w) = want.iter().find(|w| !on.contains(&w.as_str())) {
        return Ok(w.clone());
    }
    if let Some(extra) = on.iter().find(|c| !want.iter().any(|w| w == *c)) {
        return Ok((*extra).to_owned());
    }
    if opts.contains(&NEXT_LABEL) {
        return Ok(NEXT_LABEL.to_owned());
    }
    Err(invalid("select at least one option"))
}

fn map(frame: &UiRequestFrame, call_id: Option<String>, now: Millis) -> (UiRequest, NeedsYou) {
    let id = frame.req_id().to_string();
    match frame {
        UiRequestFrame::Editor { title, prefill, .. } => {
            let req = UiRequest {
                id: id.clone(),
                kind: UiKind::Editor,
                title: title.clone(),
                message: None,
                options: Vec::new(),
                allow_other: false,
                allow_chat: false,
                initial: prefill.clone(),
                plan: None,
                call_id,
            };
            let question = title.strip_prefix(CUSTOM_ANSWER_PREFIX).unwrap_or(title).to_owned();
            let needs = NeedsYou {
                kind: NeedsKind::Input,
                request_id: Some(id),
                since: now,
                title: if title.starts_with(CUSTOM_ANSWER_PREFIX) { "Your answer".into() } else { "Input".into() },
                question,
                detail: None,
                options: Vec::new(),
                multi: false,
                allow_other: true,
                allow_chat: false,
                command: None,
                answerable: true,
            };
            (req, needs)
        }
        UiRequestFrame::Select { title, options, help_text, .. } => {
            if let Some(rest) = title.strip_prefix(APPROVAL_PREFIX) {
                let mut lines = rest.lines();
                let tool = lines.next().unwrap_or("").trim().to_owned();
                let detail_lines: Vec<&str> = lines.collect();
                let detail = detail_lines.join("\n").trim().to_owned();
                let command = detail_lines.iter().find_map(|l| l.trim().strip_prefix("Command: ")).map(str::to_owned);
                let primary = options.iter().position(|o| o.label() == "Approve" || o.label() == "Approve Once").unwrap_or(0);
                let opts: Vec<NeedsOption> = options
                    .iter()
                    .enumerate()
                    .map(|(i, o)| NeedsOption {
                        id: o.label().to_owned(),
                        label: o.label().to_owned(),
                        description: o.description().map(str::to_owned),
                        recommended: i == primary,
                        tone: if o.label().starts_with("Deny") {
                            OptionTone::Danger
                        } else if i == primary {
                            OptionTone::Primary
                        } else {
                            OptionTone::Neutral
                        },
                    })
                    .collect();
                let req = UiRequest {
                    id: id.clone(),
                    kind: UiKind::Select,
                    title: format!("{APPROVAL_PREFIX}{tool}"),
                    message: (!detail.is_empty()).then(|| detail.clone()),
                    options: opts.clone(),
                    allow_other: false,
                    allow_chat: false,
                    initial: None,
                    plan: None,
                    call_id,
                };
                let needs = NeedsYou {
                    kind: NeedsKind::Approval,
                    request_id: Some(id),
                    since: now,
                    title: format!("Allow {tool}?"),
                    question: format!("{APPROVAL_PREFIX}{tool}"),
                    detail: (!detail.is_empty()).then_some(detail),
                    options: opts,
                    multi: false,
                    allow_other: false,
                    allow_chat: false,
                    command,
                    answerable: true,
                };
                return (req, needs);
            }
            let allow_other = options.iter().any(|o| o.label() == OTHER_LABEL);
            let allow_chat = options.iter().any(|o| o.label() == CHAT_LABEL);
            let multi = is_checkbox(frame);
            let opts: Vec<NeedsOption> = options
                .iter()
                .filter(|o| !matches!(o.label(), OTHER_LABEL | CHAT_LABEL | NEXT_LABEL))
                .map(|o| NeedsOption {
                    id: o.label().to_owned(),
                    label: o.label().to_owned(),
                    description: o.description().map(str::to_owned),
                    recommended: false,
                    tone: OptionTone::Neutral,
                })
                .collect();
            let ask = allow_other || allow_chat || frame_has_marker(frame);
            let req = UiRequest {
                id: id.clone(),
                kind: if multi { UiKind::MultiSelect } else { UiKind::Select },
                title: title.clone(),
                message: None,
                options: opts.clone(),
                allow_other,
                allow_chat,
                initial: None,
                plan: None,
                call_id,
            };
            let needs = NeedsYou {
                kind: NeedsKind::Ask,
                request_id: Some(id),
                since: now,
                title: if ask { "Question".into() } else { "Choose".into() },
                question: title.clone(),
                detail: help_text.as_ref().filter(|_| false).cloned(),
                options: opts,
                multi,
                allow_other,
                allow_chat,
                command: None,
                answerable: true,
            };
            (req, needs)
        }
    }
}

fn frame_has_marker(frame: &UiRequestFrame) -> bool {
    matches!(frame, UiRequestFrame::Select { selection_marker: Some(_), .. })
}

impl UiState {
    pub(crate) fn clear(&mut self) {
        self.pending.clear();
        self.driver = None;
    }

    pub(crate) fn current(&self) -> Option<&UiRequest> {
        self.pending.values().find(|p| !p.hidden).map(|p| &p.req)
    }

    pub(crate) fn needs(&self, answerable: bool) -> Option<NeedsYou> {
        self.pending.values().find(|p| !p.hidden).map(|p| NeedsYou { answerable, ..p.needs.clone() })
    }

    pub(crate) fn take_replies(&mut self) -> Vec<UiReply> {
        std::mem::take(&mut self.replies)
    }

    pub(crate) fn request(&mut self, frame: &UiRequestFrame, call_id: Option<String>, now: Millis) {
        let req_id = frame.req_id();
        if self.pending.contains_key(&req_id) {
            return;
        }
        let (req, needs) = map(frame, call_id, now);
        let mut hidden = false;
        match (&self.driver, frame) {
            (Some(Driver::Other { text }), UiRequestFrame::Editor { title, .. }) if title.starts_with(CUSTOM_ANSWER_PREFIX) => {
                self.replies.push(UiReply { req_id, value: Some(text.clone()) });
                self.driver = None;
                hidden = true;
            }
            (Some(Driver::Multi { title, want }), UiRequestFrame::Select { title: t, .. }) if t == title && is_checkbox(frame) => {
                match multi_step(frame, want) {
                    Ok(label) => {
                        if label == NEXT_LABEL {
                            self.driver = None;
                        }
                        self.replies.push(UiReply { req_id, value: Some(label) });
                        hidden = true;
                    }
                    Err(_) => self.driver = None,
                }
            }
            (Some(_), _) => self.driver = None,
            (None, _) => {}
        }
        self.pending.insert(req_id, Pending { frame: frame.clone(), req, needs, hidden });
    }

    pub(crate) fn end(&mut self, req_id: u64) {
        self.pending.remove(&req_id);
    }

    pub(crate) fn answer(&mut self, request_id: &str, answer: &Answer) -> Result<Vec<UiReply>, ApiError> {
        let req_id: u64 = request_id.parse().map_err(|_| invalid(format!("unknown request id {request_id}")))?;
        let p = self
            .pending
            .get(&req_id)
            .ok_or_else(|| ApiError::new("not_found", format!("no pending dialog {request_id}")).retryable())?;
        let frame = p.frame.clone();
        let one = |value: Option<String>| Ok(vec![UiReply { req_id, value }]);
        if answer.cancel {
            self.driver = None;
            return one(None);
        }
        let text = answer.text.as_deref().filter(|t| !t.trim().is_empty());
        match &frame {
            UiRequestFrame::Editor { .. } => {
                let value = text.map(str::to_owned).or_else(|| answer.choices.first().cloned()).unwrap_or_default();
                one(Some(value))
            }
            UiRequestFrame::Select { title, .. } => {
                let opts = labels(&frame);
                if answer.chat {
                    if !opts.contains(&CHAT_LABEL) {
                        return Err(invalid("this question does not offer \"Chat about this\""));
                    }
                    self.driver = None;
                    return one(Some(CHAT_LABEL.to_owned()));
                }
                if let (Some(text), true) = (text, answer.choices.is_empty()) {
                    if !opts.contains(&OTHER_LABEL) {
                        return Err(invalid("this question does not accept a free-text answer"));
                    }
                    self.driver = Some(Driver::Other { text: text.to_owned() });
                    return one(Some(OTHER_LABEL.to_owned()));
                }
                if answer.choices.is_empty() {
                    return Err(invalid("choose an option"));
                }
                for c in &answer.choices {
                    if !opts.contains(&c.as_str()) {
                        return Err(invalid(format!("\"{c}\" is not one of the options (labels must match exactly)")));
                    }
                }
                if is_checkbox(&frame) {
                    let want: Vec<String> = answer.choices.iter().filter(|c| c.as_str() != NEXT_LABEL).cloned().collect();
                    let label = multi_step(&frame, &want)?;
                    self.driver = (label != NEXT_LABEL).then(|| Driver::Multi { title: title.clone(), want });
                    return one(Some(label));
                }
                if answer.choices.len() > 1 {
                    return Err(invalid("this question takes a single choice"));
                }
                self.driver = None;
                one(Some(answer.choices[0].clone()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(req_id: u64, checkbox: bool, checked: Vec<u32>, next: bool) -> UiRequestFrame {
        let mut options = vec![SelectItem::Label("Red".into()), SelectItem::Label("Blue".into()), SelectItem::Label("Green".into())];
        if next {
            options.push(SelectItem::Label(NEXT_LABEL.into()));
        }
        options.push(SelectItem::Label(OTHER_LABEL.into()));
        options.push(SelectItem::Label(CHAT_LABEL.into()));
        UiRequestFrame::Select {
            req_id,
            title: "Colors?".into(),
            options,
            initial_index: Some(0),
            selection_marker: Some(if checkbox { "checkbox" } else { "radio" }.into()),
            checked_indices: Some(checked),
            markable_count: None,
            help_text: None,
        }
    }

    fn answer(choices: &[&str], text: Option<&str>) -> Answer {
        Answer { choices: choices.iter().map(|c| c.to_string()).collect(), text: text.map(str::to_owned), cancel: false, chat: false }
    }

    #[test]
    fn single_select_exact_labels() {
        let mut ui = UiState::default();
        ui.request(&ask(2, false, vec![], false), None, 0);
        let req = ui.current().unwrap();
        assert_eq!(req.kind, UiKind::Select);
        assert!(req.allow_other && req.allow_chat);
        assert_eq!(req.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Red", "Blue", "Green"]);
        assert!(ui.answer("2", &answer(&["blue"], None)).is_err());
        assert_eq!(ui.answer("2", &answer(&["Blue"], None)).unwrap(), vec![UiReply { req_id: 2, value: Some("Blue".into()) }]);
        let chat = Answer { chat: true, ..answer(&[], None) };
        assert_eq!(ui.answer("2", &chat).unwrap()[0].value.as_deref(), Some(CHAT_LABEL));
        let cancel = Answer { cancel: true, ..answer(&[], None) };
        assert_eq!(ui.answer("2", &cancel).unwrap()[0].value, None);
        assert_eq!(ui.answer("9", &cancel).unwrap_err().code, "not_found");
    }

    #[test]
    fn other_drives_editor() {
        let mut ui = UiState::default();
        ui.request(&ask(3, false, vec![], false), None, 0);
        assert_eq!(ui.answer("3", &answer(&[], Some("teal"))).unwrap()[0].value.as_deref(), Some(OTHER_LABEL));
        ui.end(3);
        ui.request(&UiRequestFrame::Editor { req_id: 4, title: "Custom answer: Colors?".into(), prefill: None }, None, 0);
        assert_eq!(ui.take_replies(), vec![UiReply { req_id: 4, value: Some("teal".into()) }]);
        assert!(ui.current().is_none(), "driven editor stays hidden");
    }

    #[test]
    fn multi_select_loop() {
        let mut ui = UiState::default();
        ui.request(&ask(5, true, vec![], false), None, 0);
        assert_eq!(ui.current().unwrap().kind, UiKind::MultiSelect);
        assert_eq!(ui.answer("5", &answer(&["Red", "Green"], None)).unwrap()[0].value.as_deref(), Some("Red"));
        ui.end(5);
        ui.request(&ask(6, true, vec![0], true), None, 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some("Green"));
        ui.end(6);
        ui.request(&ask(7, true, vec![0, 2], true), None, 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some(NEXT_LABEL));
        assert!(ui.current().is_none());
        ui.end(7);
        // Loop finished: the next request is visible again.
        ui.request(&ask(8, true, vec![], false), None, 0);
        assert!(ui.current().is_some());
    }

    #[test]
    fn approval_mapping() {
        let mut ui = UiState::default();
        let f = UiRequestFrame::Select {
            req_id: 1,
            title: "Allow tool: bash\nCommand: echo approved-run".into(),
            options: ["Approve", "Approve bash for this session", "Deny"].iter().map(|l| SelectItem::Label(l.to_string())).collect(),
            initial_index: None,
            selection_marker: None,
            checked_indices: None,
            markable_count: None,
            help_text: None,
        };
        ui.request(&f, Some("call_1".into()), 10);
        let n = ui.needs(true).unwrap();
        assert_eq!(n.kind, NeedsKind::Approval);
        assert_eq!(n.title, "Allow bash?");
        assert_eq!(n.command.as_deref(), Some("echo approved-run"));
        assert_eq!(n.options[0].tone, OptionTone::Primary);
        assert_eq!(n.options[2].tone, OptionTone::Danger);
        assert_eq!(ui.current().unwrap().call_id.as_deref(), Some("call_1"));
        assert_eq!(ui.answer("1", &answer(&["Approve"], None)).unwrap()[0].value.as_deref(), Some("Approve"));
    }
}
