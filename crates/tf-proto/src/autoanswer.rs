//! "Decide for me" (architecture §3.23): when a question with a ★ recommended option waits long
//! enough for a person, tf-hostd answers it with the recommended option(s) by itself, whether or
//! not an app is connected. Set per agent (`AgentSpec.autoAnswer`, also per Dispatch message and
//! per automation run), per running agent (`agent.setAutoAnswer`) and per host (the default,
//! `host.autoAnswerSet`, published as `HostInfo.autoAnswer`). Only omp `ask` questions with a
//! recommendation qualify: never approvals, plan reviews, confirmations or free-text input. Every
//! answer it sent stays a review item ([`AutoDecision`], `HostInfo.decisions`) until someone marks
//! it reviewed on any device (`host.autoAnswerReview`).

use crate::Millis;

/// Shortest wait a policy may set (1 minute).
pub const AUTO_ANSWER_MIN_SECS: u32 = 60;
/// Longest wait a policy may set (24 hours); also the cap of a postponed countdown.
pub const AUTO_ANSWER_MAX_SECS: u32 = 86_400;
/// The wait a new policy starts with (20 minutes).
pub const AUTO_ANSWER_DEFAULT_SECS: u32 = 1_200;

wire_struct! {
    /// A decide-for-me policy.
    #[derive(Eq)]
    pub struct AutoAnswer {
        /// Off: questions wait for a person. An agent's own `enabled: false` also overrides a
        /// host default that is on.
        pub enabled: bool,
        /// How long a question waits for a person before tf-hostd picks the recommended option(s)
        /// (seconds, [`AUTO_ANSWER_MIN_SECS`]..=[`AUTO_ANSWER_MAX_SECS`]).
        pub after_secs: u32,
        /// Count down only while no TeleFlock app is connected to the agent's host (its herdr
        /// session): the countdown stops when an app connects and goes on from where it stood
        /// once the last one has disconnected.
        pub only_when_no_app: bool,
    }
}

impl AutoAnswer {
    /// A policy that is off (the host default of a host that never set one).
    pub const OFF: AutoAnswer = AutoAnswer { enabled: false, after_secs: AUTO_ANSWER_DEFAULT_SECS, only_when_no_app: false };

    /// `invalid_params` naming the problem when `after_secs` is out of range.
    pub fn validate(&self) -> Result<(), crate::ApiError> {
        if !(AUTO_ANSWER_MIN_SECS..=AUTO_ANSWER_MAX_SECS).contains(&self.after_secs) {
            return Err(crate::ApiError::new(
                "invalid_params",
                format!("autoAnswer.afterSecs must be {AUTO_ANSWER_MIN_SECS}–{AUTO_ANSWER_MAX_SECS} seconds (1 minute to 24 hours), not {}", self.after_secs),
            ));
        }
        Ok(())
    }
}

wire_enum! {
    /// Where an agent's policy comes from: the host default, or its own (`AgentSpec.autoAnswer`,
    /// `agent.setAutoAnswer`).
    pub enum AutoAnswerSource { Host, Agent }
}

wire_enum! {
    /// * `counting`: the recommended option(s) are picked at `deadline` unless someone answers
    ///   first.
    /// * `waitingForNoApp`: (`onlyWhenNoApp`) an app is connected: the countdown stands at
    ///   `remainingMs` and goes on once no app is connected.
    /// * `cancelled`: cancelled for this question (`agent.autoAnswerCancel`): it waits for a
    ///   person; `agent.autoAnswerPostpone` starts it again.
    /// * `answering`: due: tf-hostd is answering, or waits for the session's link to deliver the
    ///   answer.
    pub enum AutoAnswerStatus { Counting, WaitingForNoApp, Cancelled, Answering }
}

wire_struct! {
    /// The countdown on an agent's pending question (`NeedsYou` of kind `ask` with a ★
    /// recommended option).
    pub struct AutoAnswerCountdown {
        /// `NeedsYou.requestId` of the question.
        pub request_id: String,
        pub status: AutoAnswerStatus,
        /// When the recommended option(s) are picked (host clock); `counting` and `answering`.
        pub deadline: Option<Millis>,
        /// What is left of the wait (ms) while it stands still (`waitingForNoApp`, `cancelled`).
        pub remaining_ms: Option<i64>,
        /// Labels of the options that will be picked (the ★ recommended ones), or with `earlier`
        /// how the question's earlier answer reads (its options' labels, its typed text).
        pub picks: Vec<String>,
        /// The question already has the user's answer (`NeedsYou.step`: Back reopened it, or it
        /// came up again): that answer is sent, not ★ (hosts ≥ 0.8.0).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[ts(as = "Option<bool>", optional)]
        pub earlier: bool,
    }
}

wire_struct! {
    /// `Agent.autoAnswer`: the agent's decide-for-me policy (present while one is on, or the agent
    /// has its own) and the countdown on its pending question.
    pub struct AgentAutoAnswer {
        /// The policy in force: the agent's own, else the host default.
        pub policy: AutoAnswer,
        pub source: AutoAnswerSource,
        pub countdown: Option<AutoAnswerCountdown>,
    }
}

wire_struct! {
    /// `agent.setAutoAnswer`: a running (or parked) agent's own policy; absent = the host default
    /// again. A changed policy applies to the pending question at once (time already waited
    /// counts).
    pub struct SetAutoAnswerParams {
        pub agent_id: String,
        pub policy: Option<AutoAnswer>,
    }
}

wire_struct! {
    /// `agent.autoAnswerCancel`: this question waits for a person.
    pub struct AutoAnswerRef {
        pub agent_id: String,
        /// `AutoAnswerCountdown.requestId`: a request that is no longer pending is `not_found`.
        pub request_id: String,
    }
}

wire_struct! {
    /// `agent.autoAnswerPostpone`: adds `secs` to the question's wait (a cancelled countdown starts
    /// again with `secs` left). What is left is capped at 24 hours.
    pub struct AutoAnswerPostponeParams {
        pub agent_id: String,
        pub request_id: String,
        pub secs: u32,
    }
}

wire_struct! {
    /// One option of a question decide for me answered ([`AutoDecision::options`]).
    pub struct AutoDecisionOption {
        pub label: String,
        /// omp's ★ recommendation.
        pub recommended: bool,
        /// Sent (a multi-select may have sent several).
        pub picked: bool,
    }
}

wire_struct! {
    /// A question decide for me answered, for the user to look at when they are back (§3.23
    /// "Review"). tf-hostd keeps it per herdr session until someone marks it reviewed on any device
    /// (`host.autoAnswerReview`); `HostInfo.decisions` lists the unreviewed ones (hosts ≥ 0.9.0).
    pub struct AutoDecision {
        pub id: String,
        pub agent_id: String,
        /// The agent's name when it was answered (kept after the agent ended).
        pub agent_name: String,
        /// `NeedsYou.requestId` of the question.
        pub request_id: String,
        /// `NeedsYou.title`: omp's short label for the question.
        pub title: String,
        pub question: String,
        /// The question's options in their order, with what was sent.
        pub options: Vec<AutoDecisionOption>,
        /// A multi-select (several options could be picked).
        pub multi: bool,
        /// Typed ("Other") text that was sent: part of an earlier answer.
        pub text: Option<String>,
        /// The question's earlier answer was sent (Back reopened it, or it came up again), not ★.
        pub earlier: bool,
        /// When it was answered (host clock).
        pub at: Millis,
        /// How long the question waited for a person (the policy's wait plus postponements, ms).
        pub waited_ms: i64,
        /// Whose policy answered it: the agent's own, or the host default.
        pub source: AutoAnswerSource,
        /// The agent's omp session, to open it once the agent ended (Past sessions).
        pub session_id: Option<String>,
        pub session_file: Option<String>,
        /// The agent's folder.
        pub cwd: Option<String>,
        /// The "decided for you" notification: retracted on every device once this is reviewed
        /// (`notifyDone`); opening it leads here (`HostPage::Decisions`).
        pub notification_id: Option<String>,
    }
}

wire_struct! {
    /// `host.autoAnswerReview`: these decisions were looked at, for every device of the session
    /// (their "decided for you" notifications are retracted everywhere). `all`: every unreviewed
    /// one. Ids already reviewed, or no longer kept, are skipped.
    pub struct AutoAnswerReviewParams {
        #[serde(default)]
        #[ts(as = "Option<Vec<String>>", optional)]
        pub ids: Vec<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[ts(as = "Option<bool>", optional)]
        pub all: bool,
    }
}

wire_struct! {
    /// What `host.autoAnswerReview` marked: the ids that were unreviewed until now.
    pub struct AutoAnswerReviewed {
        pub reviewed: Vec<String>,
    }
}
