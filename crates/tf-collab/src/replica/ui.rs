//! Collab `ui-request`s → tf-proto [`UiRequest`] / [`NeedsYou`], and tf-proto [`Answer`]s →
//! exact `ui-response` values (`omp-collab.md` §7).
//!
//! * ask selects: sentinels `Other (type your own)` → `allowOther`, `Chat about this` →
//!   `allowChat`, `Next →` (checkbox submit) hidden; `selectionMarker: checkbox` → multi-select.
//! * approvals: titles starting `Allow tool:` → approval options (`Approve…` primary, `Deny` danger).
//! * editors → `editor`.
//! * the questions of a multi-question ask carry TeleFlock's bridge `nav` (bridge ≥ 2.2.0): it
//!   becomes `step` (progress, Back, the answer the question already has), and `Answer.back` is
//!   answered with its `back` value.
//!
//! Multi-step answers are driven here: "Other" answers send the sentinel and then the text to the
//! follow-up `Custom answer:` editor; multi-select answers toggle one label per round (each round is
//! a new reqId) and finish with `Next →`, or with "Other" and its editor when they carry text.
//! Intermediate rounds stay hidden from clients.

use std::collections::BTreeMap;

use tf_proto::{Answer, ApiError, AskStep, Millis, NeedsKind, NeedsOption, NeedsYou, OptionTone, UiKind, UiRequest};

use crate::frame::{SelectItem, UiRequestFrame};

pub const OTHER_LABEL: &str = "Other (type your own)";
pub const CHAT_LABEL: &str = "Chat about this";
pub const NEXT_LABEL: &str = "Next →";
pub const CUSTOM_ANSWER_PREFIX: &str = "Custom answer: ";
pub const APPROVAL_PREFIX: &str = "Allow tool: ";
/// omp's mark on the recommended option of a plain select (`addRecommendedSuffix`).
pub const RECOMMENDED_SUFFIX: &str = " (Recommended)";

/// A `ui-response` to send through [`crate::Guest::ui_response`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiReply {
    pub req_id: u64,
    /// Exact option label or editor text; `None` cancels.
    pub value: Option<String>,
}

/// What a ui-request belongs to, read off the transcript ([`super::Replica`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RequestCall {
    /// The tool call (ask tool / approval).
    pub call_id: Option<String>,
    /// An ask question's ★ recommended option: an index among its own options (the ask call's
    /// `recommended`).
    pub recommended: Option<usize>,
    /// An ask's explanation ([`UiRequest::context`]).
    pub context: Option<String>,
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
    /// Checkbox loop for `title` toward the `want` set, submitted with "Other" and `other` when
    /// set, else with `Next →`.
    Multi { title: String, want: Vec<String>, other: Option<String> },
}

#[derive(Debug, Default)]
pub(crate) struct UiState {
    pending: BTreeMap<u64, Pending>,
    driver: Option<Driver>,
    replies: Vec<UiReply>,
    /// The latest ask call that showed a dialog and when its first one came: an ask's questions
    /// (each a request of its own, Back included) are one wait, so each keeps that `since`. Kept
    /// across [`UiState::clear`]: a dialog sent again after a resync still belongs to its call.
    began: Option<(String, Millis)>,
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

/// Next toggle of a checkbox round, else its submit: "Other" when the answer carries text (`other`),
/// else `Next →`.
fn multi_step(frame: &UiRequestFrame, want: &[String], other: bool) -> Result<String, ApiError> {
    let opts = labels(frame);
    let on = checked(frame);
    if let Some(w) = want.iter().find(|w| !on.contains(&w.as_str())) {
        return Ok(w.clone());
    }
    if let Some(extra) = on.iter().find(|c| !want.iter().any(|w| w == *c)) {
        return Ok((*extra).to_owned());
    }
    if other {
        return if opts.contains(&OTHER_LABEL) { Ok(OTHER_LABEL.to_owned()) } else { Err(invalid("this question does not accept a free-text answer")) };
    }
    if opts.contains(&NEXT_LABEL) {
        return Ok(NEXT_LABEL.to_owned());
    }
    Err(invalid("select at least one option"))
}

/// The driver after a checkbox round answered with `label`.
fn multi_driver(label: &str, title: String, want: Vec<String>, other: Option<String>) -> Option<Driver> {
    match label {
        NEXT_LABEL => None,
        OTHER_LABEL => other.map(|text| Driver::Other { text }),
        _ => Some(Driver::Multi { title, want, other }),
    }
}

/// The bridge's `nav` as an [`AskStep`]. The earlier answer's labels are option ids: only those the
/// select offers stay.
fn step(frame: &UiRequestFrame) -> Option<AskStep> {
    let nav = frame.nav()?;
    let offered = labels(frame);
    let answer = nav.answer.as_ref();
    Some(AskStep {
        index: nav.index,
        total: nav.total,
        can_back: nav.back.is_some(),
        choices: answer.map(|a| a.choices.iter().filter(|c| offered.contains(&c.as_str())).cloned().collect()).unwrap_or_default(),
        text: answer.and_then(|a| a.text.clone()),
    })
}

fn map(frame: &UiRequestFrame, call: &RequestCall, now: Millis) -> (UiRequest, NeedsYou) {
    let id = frame.req_id().to_string();
    let call_id = call.call_id.clone();
    let step = step(frame);
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
                context: call.context.clone(),
                step: step.clone(),
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
                context: call.context.clone(),
                step,
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
                    context: None,
                    step: None,
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
                    context: None,
                    step: None,
                };
                return (req, needs);
            }
            let allow_other = options.iter().any(|o| o.label() == OTHER_LABEL);
            let allow_chat = options.iter().any(|o| o.label() == CHAT_LABEL);
            let multi = is_checkbox(frame);
            // The ★ recommendation: omp's ask dialog only preselects it, so it comes from the tool
            // call; omp's plain select also marks its label. The id stays the exact label omp
            // offered, the label reads without omp's mark.
            let opts: Vec<NeedsOption> = options
                .iter()
                .filter(|o| !matches!(o.label(), OTHER_LABEL | CHAT_LABEL | NEXT_LABEL))
                .enumerate()
                .map(|(i, o)| {
                    let (label, marked) = match o.label().strip_suffix(RECOMMENDED_SUFFIX) {
                        Some(l) if !l.trim().is_empty() => (l, true),
                        _ => (o.label(), false),
                    };
                    NeedsOption {
                        id: o.label().to_owned(),
                        label: label.to_owned(),
                        description: o.description().map(str::to_owned),
                        recommended: marked || call.recommended == Some(i),
                        tone: OptionTone::Neutral,
                    }
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
                context: call.context.clone(),
                step: step.clone(),
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
                context: call.context.clone(),
                step,
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

    pub(crate) fn request(&mut self, frame: &UiRequestFrame, call: &RequestCall, now: Millis) {
        let req_id = frame.req_id();
        if self.pending.contains_key(&req_id) {
            return;
        }
        let (req, mut needs) = map(frame, call, now);
        // Asks only (an ask call's dialogs carry its `context`): approvals find their call by tool
        // name, so two of them can name the same one.
        if let (Some(call_id), Some(_)) = (&call.call_id, &call.context) {
            match &self.began {
                Some((c, since)) if c == call_id => needs.since = *since,
                _ => self.began = Some((call_id.clone(), now)),
            }
        }
        let mut hidden = false;
        // Anything but the round a driver waits for ends the drive.
        match (self.driver.take(), frame) {
            (Some(Driver::Other { text }), UiRequestFrame::Editor { title, .. }) if title.starts_with(CUSTOM_ANSWER_PREFIX) => {
                self.replies.push(UiReply { req_id, value: Some(text) });
                hidden = true;
            }
            (Some(Driver::Multi { title, want, other }), UiRequestFrame::Select { title: t, .. }) if *t == title && is_checkbox(frame) => {
                if let Ok(label) = multi_step(frame, &want, other.is_some()) {
                    self.driver = multi_driver(&label, title, want, other);
                    self.replies.push(UiReply { req_id, value: Some(label) });
                    hidden = true;
                }
            }
            _ => {}
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
        if answer.back {
            let Some(back) = frame.nav().and_then(|n| n.back.clone()) else {
                return Err(invalid("this question has no previous question to go back to"));
            };
            self.driver = None;
            return one(Some(back));
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
                for c in &answer.choices {
                    if !opts.contains(&c.as_str()) {
                        return Err(invalid(format!("\"{c}\" is not one of the options (labels must match exactly)")));
                    }
                }
                let free_text = text.is_some() && (answer.choices.is_empty() || is_checkbox(&frame));
                if free_text && !opts.contains(&OTHER_LABEL) {
                    return Err(invalid("this question does not accept a free-text answer"));
                }
                if is_checkbox(&frame) {
                    // Toggle toward the picked set (ticks the question came back with included),
                    // then submit: "Other" when there is text, so a typed answer without choices
                    // unticks them first; else `Next →`.
                    let want: Vec<String> = answer.choices.iter().filter(|c| c.as_str() != NEXT_LABEL).cloned().collect();
                    if want.is_empty() && text.is_none() {
                        return Err(invalid("choose an option"));
                    }
                    let other = text.map(str::to_owned);
                    let label = multi_step(&frame, &want, other.is_some())?;
                    self.driver = multi_driver(&label, title.clone(), want, other);
                    return one(Some(label));
                }
                if let (Some(text), true) = (text, answer.choices.is_empty()) {
                    self.driver = Some(Driver::Other { text: text.to_owned() });
                    return one(Some(OTHER_LABEL.to_owned()));
                }
                if answer.choices.is_empty() {
                    return Err(invalid("choose an option"));
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
    use crate::frame::{AskNav, AskNavAnswer};

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
            nav: None,
        }
    }

    /// `ask` as question `index` of 3 of a bridge ≥ 2.2.0 ask, with the answer it already has.
    fn nav_ask(req_id: u64, checkbox: bool, checked: Vec<u32>, next: bool, index: u32, earlier: Option<AskNavAnswer>) -> UiRequestFrame {
        let mut f = ask(req_id, checkbox, checked, next);
        let UiRequestFrame::Select { nav, .. } = &mut f else { unreachable!() };
        *nav = Some(AskNav { index, total: 3, back: (index > 0).then(|| "\0back".to_owned()), answer: earlier });
        f
    }

    fn answer(choices: &[&str], text: Option<&str>) -> Answer {
        Answer { choices: choices.iter().map(|c| c.to_string()).collect(), text: text.map(str::to_owned), cancel: false, chat: false, back: false }
    }

    fn no_call() -> RequestCall {
        RequestCall::default()
    }

    #[test]
    fn single_select_exact_labels() {
        let mut ui = UiState::default();
        ui.request(&ask(2, false, vec![], false), &no_call(), 0);
        let req = ui.current().unwrap();
        assert_eq!(req.kind, UiKind::Select);
        assert!(req.allow_other && req.allow_chat);
        assert_eq!(req.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Red", "Blue", "Green"]);
        assert!(req.options.iter().all(|o| !o.recommended), "no recommendation: nothing is ★");
        assert!(ui.answer("2", &answer(&["blue"], None)).is_err());
        assert_eq!(ui.answer("2", &answer(&["Blue"], None)).unwrap(), vec![UiReply { req_id: 2, value: Some("Blue".into()) }]);
        let chat = Answer { chat: true, ..answer(&[], None) };
        assert_eq!(ui.answer("2", &chat).unwrap()[0].value.as_deref(), Some(CHAT_LABEL));
        let cancel = Answer { cancel: true, ..answer(&[], None) };
        assert_eq!(ui.answer("2", &cancel).unwrap()[0].value, None);
        assert_eq!(ui.answer("9", &cancel).unwrap_err().code, "not_found");
    }

    #[test]
    fn recommended_option_from_the_call_or_omps_mark() {
        // omp's ask dialog: the call's `recommended` (an index among the question's options).
        let mut ui = UiState::default();
        ui.request(&ask(2, false, vec![], false), &RequestCall { call_id: Some("call_1".into()), recommended: Some(1), context: None }, 0);
        let n = ui.needs(true).unwrap();
        assert_eq!(n.options.iter().map(|o| o.recommended).collect::<Vec<_>>(), [false, true, false]);
        assert!(ui.current().unwrap().options[1].recommended);
        // An index past the options marks nothing.
        let mut ui = UiState::default();
        ui.request(&ask(3, true, vec![], false), &RequestCall { recommended: Some(7), ..no_call() }, 0);
        assert!(ui.needs(true).unwrap().options.iter().all(|o| !o.recommended));
        // omp's plain select marks the label: the label reads without it, the id stays exact.
        let mut ui = UiState::default();
        let mut f = ask(4, false, vec![], false);
        let UiRequestFrame::Select { options, .. } = &mut f else { unreachable!() };
        options[2] = SelectItem::Label(format!("Green{RECOMMENDED_SUFFIX}"));
        ui.request(&f, &no_call(), 0);
        let green = &ui.needs(true).unwrap().options[2];
        assert_eq!((green.id.as_str(), green.label.as_str(), green.recommended), ("Green (Recommended)", "Green", true));
        assert_eq!(ui.answer("4", &answer(&["Green (Recommended)"], None)).unwrap()[0].value.as_deref(), Some("Green (Recommended)"));
    }

    #[test]
    fn other_drives_editor() {
        let mut ui = UiState::default();
        ui.request(&ask(3, false, vec![], false), &no_call(), 0);
        assert_eq!(ui.answer("3", &answer(&[], Some("teal"))).unwrap()[0].value.as_deref(), Some(OTHER_LABEL));
        ui.end(3);
        ui.request(&UiRequestFrame::Editor { req_id: 4, title: "Custom answer: Colors?".into(), prefill: None, nav: None }, &no_call(), 0);
        assert_eq!(ui.take_replies(), vec![UiReply { req_id: 4, value: Some("teal".into()) }]);
        assert!(ui.current().is_none(), "driven editor stays hidden");
    }

    #[test]
    fn multi_select_loop() {
        let mut ui = UiState::default();
        ui.request(&ask(5, true, vec![], false), &no_call(), 0);
        assert_eq!(ui.current().unwrap().kind, UiKind::MultiSelect);
        assert_eq!(ui.answer("5", &answer(&["Red", "Green"], None)).unwrap()[0].value.as_deref(), Some("Red"));
        ui.end(5);
        ui.request(&ask(6, true, vec![0], true), &no_call(), 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some("Green"));
        ui.end(6);
        ui.request(&ask(7, true, vec![0, 2], true), &no_call(), 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some(NEXT_LABEL));
        assert!(ui.current().is_none());
        ui.end(7);
        // Loop finished: the next request is visible again.
        ui.request(&ask(8, true, vec![], false), &no_call(), 0);
        assert!(ui.current().is_some());
    }

    #[test]
    fn ask_context_reaches_the_request_and_the_board() {
        let mut ui = UiState::default();
        let call = RequestCall { call_id: Some("call_1".into()), recommended: None, context: Some("Two ways to store it.".into()) };
        ui.request(&ask(2, false, vec![], false), &call, 0);
        assert_eq!(ui.current().unwrap().context.as_deref(), Some("Two ways to store it."));
        assert_eq!(ui.needs(true).unwrap().context.as_deref(), Some("Two ways to store it."));
        assert_eq!(ui.current().unwrap().step, None, "a question without nav has no step");
    }

    #[test]
    fn back_answers_with_the_bridges_value() {
        let mut ui = UiState::default();
        // The first question offers no Back.
        ui.request(&nav_ask(2, false, vec![], false, 0, None), &no_call(), 0);
        assert_eq!(ui.current().unwrap().step, Some(AskStep { index: 0, total: 3, can_back: false, choices: vec![], text: None }));
        let back = Answer { back: true, ..answer(&[], None) };
        assert_eq!(ui.answer("2", &back).unwrap_err().code, "invalid_params");
        ui.end(2);
        // The second does; back answers with the bridge's value.
        ui.request(&nav_ask(3, false, vec![], false, 1, None), &no_call(), 0);
        assert!(ui.needs(true).unwrap().step.is_some_and(|s| s.can_back && s.index == 1));
        assert_eq!(ui.answer("3", &back).unwrap(), vec![UiReply { req_id: 3, value: Some("\0back".into()) }]);
        ui.end(3);
        // The first question comes back with its answer; an unknown label is not an option id.
        let earlier = AskNavAnswer { choices: vec!["Blue".into(), "Mauve".into()], text: None };
        ui.request(&nav_ask(4, false, vec![], false, 0, Some(earlier)), &no_call(), 0);
        assert_eq!(ui.current().unwrap().step.as_ref().unwrap().choices, ["Blue"]);
        // An earlier "Other" text comes back for the field.
        ui.end(4);
        ui.request(&nav_ask(5, false, vec![], false, 0, Some(AskNavAnswer { choices: vec![], text: Some("teal".into()) })), &no_call(), 0);
        assert_eq!(ui.needs(true).unwrap().step.unwrap().text.as_deref(), Some("teal"));
    }

    /// Back brings a multi-select up with its ticks: an answer toggles from those to the new set.
    #[test]
    fn multi_select_from_the_ticks_it_came_back_with() {
        let mut ui = UiState::default();
        let earlier = AskNavAnswer { choices: vec!["Red".into()], text: None };
        ui.request(&nav_ask(5, true, vec![0], true, 1, Some(earlier.clone())), &no_call(), 0);
        assert_eq!(ui.current().unwrap().step.as_ref().unwrap().choices, ["Red"]);
        assert_eq!(ui.answer("5", &answer(&["Blue"], None)).unwrap()[0].value.as_deref(), Some("Blue"));
        ui.end(5);
        ui.request(&nav_ask(6, true, vec![0, 1], true, 1, None), &no_call(), 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some("Red"), "the earlier tick goes");
        ui.end(6);
        ui.request(&nav_ask(7, true, vec![1], true, 1, None), &no_call(), 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some(NEXT_LABEL));
        ui.end(7);
        // The same ticks again: straight to Next.
        ui.request(&nav_ask(8, true, vec![0], true, 1, Some(earlier)), &no_call(), 0);
        assert_eq!(ui.answer("8", &answer(&["Red"], None)).unwrap()[0].value.as_deref(), Some(NEXT_LABEL));
    }

    /// A typed answer replaces the ticks: the ones a question came back with go first, then
    /// "Other" and its editor; text with choices toggles to those, then "Other".
    #[test]
    fn multi_select_text_unticks_then_other() {
        let mut ui = UiState::default();
        ui.request(&ask(5, true, vec![0], true), &no_call(), 0);
        assert_eq!(ui.answer("5", &answer(&[], Some("teal"))).unwrap()[0].value.as_deref(), Some("Red"));
        ui.end(5);
        ui.request(&ask(6, true, vec![], false), &no_call(), 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some(OTHER_LABEL));
        ui.end(6);
        ui.request(&UiRequestFrame::Editor { req_id: 7, title: "Custom answer: Colors?".into(), prefill: None, nav: None }, &no_call(), 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some("teal"));
        assert!(ui.current().is_none());
        ui.end(7);
        let mut ui = UiState::default();
        ui.request(&ask(8, true, vec![], false), &no_call(), 0);
        assert_eq!(ui.answer("8", &answer(&["Green"], Some("and teal"))).unwrap()[0].value.as_deref(), Some("Green"));
        ui.end(8);
        ui.request(&ask(9, true, vec![2], true), &no_call(), 0);
        assert_eq!(ui.take_replies()[0].value.as_deref(), Some(OTHER_LABEL));
    }

    /// One ask is one wait, however many questions it asks: each question (Back included) keeps
    /// the time the first one came, so the waiting timer and the oldest-first Inbox don't start
    /// over with every question. Before, each question waited since it came.
    #[test]
    fn an_asks_questions_wait_since_its_first() {
        let mut ui = UiState::default();
        let call = RequestCall { call_id: Some("call_1".into()), recommended: None, context: Some(String::new()) };
        ui.request(&nav_ask(2, false, vec![], false, 0, None), &call, 1_000);
        assert_eq!(ui.needs(true).unwrap().since, 1_000);
        ui.answer("2", &answer(&["Blue"], None)).unwrap();
        ui.end(2);
        ui.request(&nav_ask(3, true, vec![], false, 1, None), &call, 5_000);
        assert_eq!(ui.needs(true).unwrap().since, 1_000, "the second question");
        ui.answer("3", &Answer { back: true, ..answer(&[], None) }).unwrap();
        ui.end(3);
        let earlier = AskNavAnswer { choices: vec!["Blue".into()], text: None };
        ui.request(&nav_ask(4, false, vec![], false, 0, Some(earlier)), &call, 9_000);
        assert_eq!(ui.needs(true).unwrap().since, 1_000, "the first question again, after Back");
        // Its "Other" editor too.
        ui.end(4);
        ui.request(&UiRequestFrame::Editor { req_id: 5, title: "Custom answer: Colors?".into(), prefill: None, nav: None }, &call, 10_000);
        assert_eq!(ui.needs(true).unwrap().since, 1_000, "the Other editor");
        ui.end(5);
        // The next ask waits since its own first dialog; an approval since it came.
        ui.request(&ask(6, false, vec![], false), &RequestCall { call_id: Some("call_2".into()), ..call.clone() }, 12_000);
        assert_eq!(ui.needs(true).unwrap().since, 12_000);
        ui.end(6);
        ui.request(&ask(7, false, vec![], false), &RequestCall { call_id: Some("call_2".into()), ..no_call() }, 15_000);
        assert_eq!(ui.needs(true).unwrap().since, 15_000, "a dialog that is no ask's");
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
            nav: None,
        };
        ui.request(&f, &RequestCall { call_id: Some("call_1".into()), ..no_call() }, 10);
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
