//! Rules, matching, the loop guard and the fallback itself ([`super`]), the fallback against a
//! scripted bridge extension and a real (empty) state store.

use serde_json::{json, Value};

use tf_proto::ModelInfo;

use super::*;

const OPUS: &str = "anthropic/claude-opus-5-5";
const SONNET: &str = "anthropic/claude-sonnet-5-5";

fn rule(category: Option<&str>, from: Option<&str>, to: &str, after: RefusalAfter) -> RefusalRule {
    RefusalRule { category: category.map(str::to_owned), from: from.map(str::to_owned), to: to.to_owned(), thinking: None, after }
}

fn refusal(kind: &str, category: Option<&str>) -> Refusal {
    Refusal { kind: kind.into(), category: category.map(str::to_owned), explanation: Some("The request asks for working exploit code.".into()) }
}

/// The turn of the main agent that began at 1000 ended on a refusal of `anthropic/claude-opus-5-5`.
fn refused(category: Option<&str>) -> TurnError {
    TurnError {
        agent_id: "0-Main".into(),
        main: true,
        stop_reason: "error".into(),
        kind: "other".into(),
        provider: Some("anthropic".into()),
        model: Some("claude-opus-5-5".into()),
        message: "Refusal (cyber): The request asks for working exploit code.".into(),
        at: 2_000,
        refusal: Some(refusal("refusal", category)),
        model_name: Some("Claude Opus 5.5".into()),
        prompt_at: Some(1_000),
        ..Default::default()
    }
}

fn subagent_refused(category: Option<&str>) -> TurnError {
    TurnError { agent_id: "0-Task".into(), main: false, parent_id: Some("0-Main".into()), ..refused(category) }
}

fn models() -> ModelCatalog {
    let model = |id: &str, label: &str| ModelInfo { provider: "anthropic".into(), id: id.into(), label: Some(label.into()), thinking: vec![], context_window: None };
    ModelCatalog { models: vec![model("claude-opus-5-5", "Claude Opus 5.5"), model("claude-sonnet-5-5", "Claude Sonnet 5.5")], roles: vec![] }
}

fn with_rules(rules: Vec<RefusalRule>) -> (tempfile::TempDir, Refusals) {
    let dir = tempfile::tempdir().unwrap();
    let r = Refusals::open(dir.path().join(FILE));
    r.set(rules).unwrap();
    (dir, r)
}

fn open(dir: &tempfile::TempDir) -> Refusals {
    Refusals::open(dir.path().join(FILE))
}

// ───────────────────────────── storage ─────────────────────────────

#[test]
fn rules_are_kept_in_the_file_in_their_wire_shape_and_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let r = open(&dir);
    assert_eq!(r.config(), RefusalFallback { rules: vec![], notice: None }, "no file: no rules");
    let mut cyber = rule(Some("cyber"), Some(OPUS), SONNET, RefusalAfter::Back);
    cyber.thinking = Some(ThinkingLevel::High);
    let saved = r.set(vec![cyber, rule(None, None, SONNET, RefusalAfter::Stay)]).unwrap();
    assert_eq!(saved.rules.len(), 2);
    let file = dir.path().join(FILE);
    let on_disk: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(
        on_disk,
        json!({ "rules": [
            { "category": "cyber", "from": OPUS, "to": SONNET, "thinking": "high", "after": "back" },
            { "to": SONNET, "after": "stay" },
        ] })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600, "owner-only");
    }
    assert_eq!(open(&dir).config(), saved, "a restarted daemon has the same rules");
}

#[test]
fn rules_are_normalised_and_invalid_ones_are_refused_without_changing_anything() {
    let (dir, r) = with_rules(vec![rule(Some("cyber"), Some(OPUS), SONNET, RefusalAfter::Stay)]);
    let before = r.config();
    let bytes = std::fs::read(dir.path().join(FILE)).unwrap();

    let saved = r
        .set(vec![
            RefusalRule { category: Some(" Cyber ".into()), from: Some(format!(" {OPUS}:high ")), to: format!("{SONNET}:low"), thinking: None, after: RefusalAfter::Stay },
            RefusalRule { category: Some("Any".into()), from: Some("*".into()), to: SONNET.into(), thinking: Some(ThinkingLevel::Max), after: RefusalAfter::Back },
        ])
        .unwrap();
    let want = RefusalRule { category: Some("cyber".into()), from: Some(OPUS.into()), to: SONNET.into(), thinking: Some(ThinkingLevel::Low), after: RefusalAfter::Stay };
    assert_eq!(saved.rules[0], want, "trimmed, lowercased, a real :level moved to `thinking`");
    assert_eq!(saved.rules[1], RefusalRule { category: None, from: None, to: SONNET.into(), thinking: Some(ThinkingLevel::Max), after: RefusalAfter::Back }, "any category, any model");
    r.set(before.rules.clone()).unwrap();

    let too_many = vec![rule(None, None, SONNET, RefusalAfter::Stay); MAX_RULES + 1];
    let long = "x".repeat(CATEGORY_MAX + 1);
    let bad = [
        (too_many, "at most 32 rules".to_string()),
        (vec![rule(None, None, "claude-sonnet-5-5", RefusalAfter::Stay)], r#"rule 1: "to" is a model as provider/id"#.into()),
        (vec![rule(None, None, "anthropic/claude-sonnet-*", RefusalAfter::Stay)], r#"rule 1: "to" is a model as provider/id"#.into()),
        (vec![rule(None, None, "", RefusalAfter::Stay)], r#"rule 1: "to" is a model as provider/id"#.into()),
        (vec![rule(None, Some("anthropic/claude-*-5"), SONNET, RefusalAfter::Stay)], r#"rule 1: "from" is a model as provider/id, an id, provider/* or a prefix ending in *"#.into()),
        (vec![rule(None, Some("anth*/claude-opus-5-5"), SONNET, RefusalAfter::Stay)], r#"rule 1: "from" is a model as provider/id, an id, provider/* or a prefix ending in *"#.into()),
        (vec![rule(None, Some("claude opus"), SONNET, RefusalAfter::Stay)], r#"rule 1: "from" is a model as provider/id, an id, provider/* or a prefix ending in *"#.into()),
        (vec![rule(Some("cy ber"), None, SONNET, RefusalAfter::Stay)], "rule 1: the category is one word of at most 64 characters".into()),
        (vec![rule(Some(&long), None, SONNET, RefusalAfter::Stay)], "rule 1: the category is one word of at most 64 characters".into()),
        (
            vec![rule(None, None, SONNET, RefusalAfter::Stay), rule(None, Some("Anthropic/Claude-Sonnet-5-5:high"), SONNET, RefusalAfter::Stay)],
            "rule 2: a model cannot fall back to itself".into(),
        ),
    ];
    for (rules, why) in bad {
        let e = r.set(rules).unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("invalid_params", why.as_str()));
    }
    assert_eq!(r.config(), before, "nothing changed in memory");
    assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), bytes, "nor on disk");
}

fn kept_copies(dir: &tempfile::TempDir) -> Vec<std::path::PathBuf> {
    let mut kept: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().path()).filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(&format!("{FILE}.bad-"))).collect();
    kept.sort();
    kept
}

#[test]
fn a_damaged_file_fails_closed_keeps_its_bytes_and_stays_closed_until_rules_are_saved() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(FILE);
    std::fs::write(&file, br#"{"rules": [oops"#).unwrap();
    let r = open(&dir);
    let closed = r.config();
    assert!(closed.rules.is_empty());
    let notice = closed.notice.clone().expect("the host says why there are no rules");
    assert!(notice.contains("could not be read") && notice.contains(".bad-"), "{notice}");
    let kept = kept_copies(&dir);
    assert_eq!(kept.len(), 1);
    assert_eq!(std::fs::read(&kept[0]).unwrap(), br#"{"rules": [oops"#, "the damaged bytes are kept");
    assert_eq!(r.pick("s1", &refused(Some("cyber"))), Pick::NoRule, "no refusal falls back while closed");

    let again = open(&dir).config();
    assert_eq!((again.rules.is_empty(), again.notice.is_some()), (true, true), "the next start loads the closed state: still closed");
    assert_eq!(kept_copies(&dir).len(), 1, "nothing damaged to keep any more");

    let saved = r.set(vec![rule(None, None, SONNET, RefusalAfter::Stay)]).unwrap();
    assert_eq!(saved.notice, None, "saving rules ends it");
    assert_eq!(open(&dir).config(), saved);
}

#[test]
fn a_file_with_a_rule_the_host_would_refuse_fails_closed_too() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = serde_json::to_vec(&json!({ "rules": [{ "to": "claude-sonnet-5-5", "after": "stay" }] })).unwrap();
    std::fs::write(dir.path().join(FILE), &bytes).unwrap();
    let c = open(&dir).config();
    assert!(c.rules.is_empty() && c.notice.as_deref().is_some_and(|n| n.contains(r#"rule 1: "to" is a model as provider/id"#)), "{c:?}");
    assert_eq!(std::fs::read(&kept_copies(&dir)[0]).unwrap(), bytes);
}

#[test]
fn an_unreadable_path_fails_closed_even_when_nothing_can_be_kept() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(FILE)).unwrap();
    let c = open(&dir).config();
    assert!(c.rules.is_empty());
    let notice = c.notice.unwrap();
    assert!(notice.contains("read:") && notice.contains("could not be kept"), "{notice}");
}

// ───────────────────────────── matching ─────────────────────────────

#[test]
fn categories_match_in_any_case_and_any_covers_safety_filter_flags() {
    let cyber = refusal("refusal", Some("Cyber"));
    assert!(category_matches(Some("cyber"), &cyber) && category_matches(Some(" CYBER "), &cyber));
    assert!(!category_matches(Some("bio"), &cyber));
    for any in [None, Some(""), Some("any"), Some("Any")] {
        assert!(category_matches(any, &cyber), "{any:?}");
    }
    let flagged = refusal("sensitive", None);
    assert!(category_matches(None, &flagged) && category_matches(Some("ANY"), &flagged), "a rule for any refusal covers safety-filter flags");
    assert!(!category_matches(Some("cyber"), &flagged), "a named category does not");
}

#[test]
fn model_selectors_match_by_id_provider_and_family_and_ignore_a_real_thinking_suffix() {
    let (anthropic, opus) = (Some("anthropic"), Some("claude-opus-5-5"));
    // Exactly, in any case.
    assert!(selector_matches(OPUS, anthropic, opus) && selector_matches("Anthropic/Claude-Opus-5-5", anthropic, opus));
    assert!(!selector_matches("anthropic/claude-opus-4-8", anthropic, opus));
    // A bare id is that id on every provider.
    assert!(selector_matches("claude-opus-5-5", Some("openrouter"), opus));
    assert!(!selector_matches("claude-opus-5", anthropic, opus));
    assert!(!selector_matches("openrouter/claude-opus-5-5", anthropic, opus));
    // `provider/*` is every model of the provider; a trailing `*` a family.
    assert!(selector_matches("anthropic/*", anthropic, opus) && !selector_matches("openai/*", anthropic, opus));
    assert!(selector_matches("claude-opus-*", anthropic, opus) && selector_matches("anthropic/claude-opus-*", anthropic, opus));
    assert!(!selector_matches("anthropic/claude-sonnet-*", anthropic, opus) && !selector_matches("openai/claude-opus-*", anthropic, opus));
    // A thinking level is not part of the model.
    assert!(selector_matches("anthropic/claude-opus-5-5:high", anthropic, opus) && selector_matches("claude-opus-*:xhigh", anthropic, opus));
    // A colon that is no level belongs to the id (`llama3:8b`).
    let (ollama, llama) = (Some("ollama"), Some("llama3:8b"));
    assert!(selector_matches("ollama/llama3:8b", ollama, llama) && selector_matches("ollama/llama3:8b:high", ollama, llama));
    assert!(!selector_matches("ollama/llama3", ollama, llama));
    // Anything; and a refusal that names no model matches only that.
    assert!(selector_matches("*", None, None));
    assert!(!selector_matches("claude-opus-5-5", anthropic, None) && !selector_matches("anthropic/claude-opus-*", anthropic, None));
    assert!(selector_matches("anthropic/*", anthropic, None));
}

#[test]
fn the_first_rule_that_applies_decides_and_a_rule_for_the_refusing_model_is_skipped() {
    let decides = rule(Some("cyber"), Some("claude-opus-*"), "openai/gpt-5.5", RefusalAfter::Back);
    let (_dir, r) = with_rules(vec![
        rule(Some("bio"), None, SONNET, RefusalAfter::Stay),
        rule(Some("cyber"), Some("openai/*"), SONNET, RefusalAfter::Stay),
        rule(None, None, "anthropic/claude-opus-5-5:high", RefusalAfter::Stay),
        decides.clone(),
        rule(None, None, SONNET, RefusalAfter::Stay),
    ]);
    let mut e = refused(Some("Cyber"));
    assert_eq!(r.pick("s1", &e), Pick::Rule(decides), "wrong category, wrong model and a switch to itself are passed over");
    e.prompt_at = Some(3_000);
    e.refusal = Some(refusal("sensitive", None));
    assert_eq!(r.pick("s1", &e), Pick::Rule(rule(None, None, SONNET, RefusalAfter::Stay)), "a safety-filter flag has no category: only the rule for any refusal covers it");
    let (_dir, none) = with_rules(vec![]);
    assert_eq!(none.pick("s1", &refused(Some("cyber"))), Pick::NoRule);
    let (_dir, only_itself) = with_rules(vec![rule(None, None, OPUS, RefusalAfter::Stay)]);
    assert_eq!(only_itself.pick("s1", &refused(Some("cyber"))), Pick::NoRule, "never the same model");
}

// ───────────────────────────── the loop guard ─────────────────────────────

#[test]
fn a_turn_falls_back_once_per_session_and_agent() {
    let (_dir, r) = with_rules(vec![rule(None, None, SONNET, RefusalAfter::Stay)]);
    let e = refused(Some("cyber"));
    assert!(matches!(r.pick("s1", &e), Pick::Rule(_)));
    assert_eq!(r.pick("s1", &e), Pick::Repeat, "the same turn again");
    let new_turn = TurnError { prompt_at: Some(5_000), ..e.clone() };
    assert!(matches!(r.pick("s1", &new_turn), Pick::Rule(_)), "a new turn falls back again");
    assert!(matches!(r.pick("s1", &subagent_refused(Some("cyber"))), Pick::Rule(_)), "a subagent of the same turn has its own");
    assert!(matches!(r.pick("s2", &e), Pick::Rule(_)), "another session too");
    let unknown = TurnError { prompt_at: None, ..e.clone() };
    assert_eq!(r.pick("s1", &unknown), Pick::Unknown, "a turn the bridge could not name is not fallen back from");
    let (_dir, none) = with_rules(vec![]);
    assert_eq!(none.pick("s1", &unknown), Pick::NoRule, "no rule applies, so nothing is unknown about it");
}

#[test]
fn two_rules_that_point_at_each_other_do_not_ping_pong() {
    let (_dir, r) = with_rules(vec![rule(None, Some(OPUS), SONNET, RefusalAfter::Stay), rule(None, Some(SONNET), OPUS, RefusalAfter::Stay)]);
    let on_opus = refused(Some("cyber"));
    assert!(matches!(r.pick("s1", &on_opus), Pick::Rule(rule) if rule.to == SONNET));
    let on_sonnet = TurnError { model: Some("claude-sonnet-5-5".into()), model_name: Some("Claude Sonnet 5.5".into()), ..on_opus };
    assert_eq!(r.pick("s1", &on_sonnet), Pick::Repeat, "Sonnet refused the same turn: it stops there");
}

#[test]
fn the_loop_guard_forgets_old_turns() {
    let mut t = Turns::default();
    assert!(t.first("s", "a", 0));
    for at in 1..=TURNS_KEEP as Millis {
        assert!(t.first("s", "a", at));
    }
    assert!(t.first("s", "a", 0), "the oldest turn was forgotten");
    assert!(!t.first("s", "a", TURNS_KEEP as Millis), "recent ones are kept");
}

// ───────────────────────────── words ─────────────────────────────

#[test]
fn the_notice_names_both_models_the_way_omp_does() {
    let (e, r) = (refused(Some("cyber")), rule(Some("cyber"), Some(OPUS), SONNET, RefusalAfter::Back));
    let names = Names::of(&e, &r, Some(&models()));
    assert_eq!(names, Names { from: "Opus 5.5".into(), to: "Sonnet 5.5".into() });
    let cyber = e.refusal.clone().unwrap();
    assert_eq!(notice_text(&names, &cyber, &e), "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued");
    assert_eq!(follow_up(&names, &cyber, &e, &r), "The request asks for working exploit code. Goes back to Opus 5.5 when the turn ends.");
    assert_eq!(follow_up(&names, &cyber, &e, &RefusalRule { after: RefusalAfter::Stay, ..r.clone() }), "The request asks for working exploit code. Stays on Sonnet 5.5.");

    let flagged = TurnError { refusal: Some(refusal("sensitive", None)), ..e.clone() };
    assert_eq!(notice_text(&names, flagged.refusal.as_ref().unwrap(), &flagged), "Opus 5.5 was flagged by safety filters; switched to Sonnet 5.5 and continued");
    let sub = subagent_refused(Some("cyber"));
    assert_eq!(notice_text(&names, &cyber, &sub), "Subagent 0-Task: Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued");
    assert_eq!(follow_up(&names, &cyber, &sub, &r), "The request asks for working exploit code. The subagent finishes its run on Sonnet 5.5.");

    // Without omp's name or a catalog: the model's id.
    let bare = TurnError { model_name: None, ..e };
    assert_eq!(Names::of(&bare, &r, None), Names { from: "claude-opus-5-5".into(), to: "claude-sonnet-5-5".into() });
    assert_eq!(Names::of(&bare, &r, Some(&models())).from, "Opus 5.5", "the catalog names it when the bridge did not");
}

// ───────────────────────────── the fallback itself ─────────────────────────────

#[cfg(unix)]
mod fallback {
    use std::sync::{Arc, Mutex};

    use tokio::task::JoinHandle;

    use tf_proto::host::ServerMsg;
    use tf_proto::{ActivityEvent, ClientInfo};

    use crate::bridge::fake::FakeExt;
    use crate::bridge::{BridgeEndpoint, BridgeHandle};
    use crate::clients::ClientHandle;

    use super::*;

    /// A herdr session's context in miniature: a bridge with one omp session (`s1`, bridge 2.3.0 with
    /// `refusals`) scripted by the test, a state store (the board's Activity and notifications) with
    /// one app attached, the replica's signals, and the board's word on the agent.
    struct Lab {
        _dir: tempfile::TempDir,
        ext: FakeExt,
        env: Env,
        refusals: Arc<Refusals>,
        updates: broadcast::Sender<OmpUpdate>,
        board: Arc<Mutex<Board>>,
        app: ClientHandle,
        agent: Agent,
    }

    const SETTLED: Board = Board { working: false, settled: true };

    impl Lab {
        async fn new(rules: Vec<RefusalRule>) -> Lab {
            let dir = tempfile::tempdir().unwrap();
            let refusals = Arc::new(Refusals::open(dir.path().join(FILE)));
            refusals.set(rules).unwrap();
            let bridge = BridgeHandle::bind(BridgeEndpoint::Unix(dir.path().join("bridge.sock")), "s".into()).unwrap();
            let mut ext = FakeExt::connect(&bridge).await;
            ext.hello_caps(7, "s1", "2.3.0", Some(json!({ "live": 1, "turnError": true, "refusals": true }))).await;
            // The board's store has a bridge of its own: its omp layer must not talk to the script.
            let persist = crate::state::persist::Persist::load(dir.path().join("state.json"));
            let cancel = CancellationToken::new();
            cancel.cancel();
            let other = BridgeHandle::bind(BridgeEndpoint::Unix(dir.path().join("board.sock")), "t".into()).unwrap();
            let omp = crate::omp::OmpHandle::start(0, persist.clone(), cancel, other.clone()).await;
            let state = StateHandle::new("lab", persist, omp, other);
            let app = ClientHandle::new("c1".into(), ClientInfo { app: "teleflock-desktop".into(), version: "0.9.0".into(), platform: "linux".into(), device: "Desk".into(), features: None });
            state.attach_client(&app);
            let board = Arc::new(Mutex::new(SETTLED));
            let seen = board.clone();
            let env = Env { bridge, state, cancel: CancellationToken::new(), board: Arc::new(move || Some(*seen.lock().unwrap())) };
            let mut agent = crate::state::parked::parked_agent(&crate::state::persist::ParkedRecord { agent_id: "a1".into(), name: "ana".into(), kind: "omp".into(), ..Default::default() });
            agent.parked = None;
            let (updates, _) = broadcast::channel(64);
            Lab { _dir: dir, ext, env, refusals, updates, board, app, agent }
        }

        /// The fallback for `e`, running (it answers when the script has answered the bridge calls).
        fn react(&self, e: TurnError) -> JoinHandle<()> {
            let (refusals, env, agent, updates) = (self.refusals.clone(), self.env.clone(), self.agent.clone(), self.updates.subscribe());
            let catalog = models();
            tokio::spawn(async move { react(&refusals, &env, updates, "s1", &agent, &e, async move || Some(catalog)).await })
        }

        fn activity(&self) -> Vec<ActivityEvent> {
            self.env.state.activity_page(None, 50, Some("a1")).0
        }

        /// What the app was told since the last call.
        fn notifications(&self) -> Vec<Notification> {
            let mut lines = Vec::new();
            self.app.take_batch(&mut lines);
            lines.iter().filter_map(|l| if let ServerMsg::Notify { notification, .. } = serde_json::from_str(l).unwrap() { Some(notification) } else { None }).collect()
        }

        /// The omp session reports it runs `model` (a `state` event, as the bridge sends them).
        async fn runs(&mut self, model: &str) {
            let (provider, id) = model.split_once('/').unwrap();
            self.ext
                .send(json!({ "t": "event", "event": "state", "sessionId": "s1", "data": {
                    "model": { "provider": provider, "id": id }, "thinking": "high", "fast": false, "mode": "normal", "idle": true,
                    "queue": { "steering": [], "followUp": [] }, "attached": true } }))
                .await;
            for _ in 0..200 {
                let now = self.env.bridge.by_session("s1").and_then(|b| b.state.model).map(|m| format!("{}/{}", m.provider, m.id));
                if now.as_deref() == Some(model) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("the bridge never showed the session on {model}");
        }

        fn signal(&self, signals: Vec<Signal>) {
            let _ = self.updates.send(OmpUpdate::Signals { session_id: "s1".into(), signals });
        }

        /// The next request of hostd to the bridge, if it comes within `ms`.
        async fn request(&mut self, ms: u64) -> Option<Value> {
            tokio::time::timeout(Duration::from_millis(ms), self.ext.recv_req()).await.ok()
        }

        /// Answers a `retryRefused` the way the bridge does after it switched models and went on.
        async fn went_on(&mut self, previous_thinking: &str) -> Value {
            let req = self.ext.recv_req().await;
            assert_eq!(req["op"], "retryRefused");
            self.ext
                .ok(
                    &req,
                    json!({ "started": true, "model": SONNET, "modelName": "Claude Sonnet 5.5",
                            "previous": { "model": OPUS, "name": "Claude Opus 5.5", "thinking": previous_thinking } }),
                )
                .await;
            req
        }
    }

    #[tokio::test]
    async fn a_rule_continues_the_turn_on_the_fallback_model_and_posts_once() {
        let mut lab = Lab::new(vec![rule(Some("cyber"), Some(OPUS), SONNET, RefusalAfter::Stay)]).await;
        let task = lab.react(refused(Some("cyber")));
        let req = lab.went_on("high").await;
        assert_eq!(
            req["params"],
            json!({ "agentId": null, "model": SONNET, "thinking": null, "notice": "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued" }),
            "the model, the refused turn's thinking level kept, and the transcript's notice"
        );
        task.await.unwrap();

        let acts = lab.activity();
        assert_eq!(acts.len(), 1, "{acts:?}");
        assert_eq!((acts[0].kind, acts[0].title.as_str()), (ActivityKind::ModelChanged, "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued"));
        assert_eq!(acts[0].detail.as_deref(), Some("The request asks for working exploit code. Stays on Sonnet 5.5."));
        let notes = lab.notifications();
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert_eq!((notes[0].kind, notes[0].agent_id.as_str(), notes[0].title.as_str()), (NotifyKind::Info, "a1", "ana · continued on Sonnet 5.5"));
        assert!(notes[0].body.starts_with("Opus 5.5 refused (cyber). The request asks for working exploit code."), "{}", notes[0].body);

        // `stay`: whatever the turn does next, the model is left alone.
        lab.signal(vec![Signal::TurnStarted, Signal::TurnEnded { aborted: false, error: None, refusal: None }]);
        assert!(lab.request(500).await.is_none(), "nothing switches the model back");
    }

    #[tokio::test]
    async fn a_rule_can_set_the_thinking_level_of_the_fallback_model() {
        let mut lab = Lab::new(vec![RefusalRule { thinking: Some(ThinkingLevel::Low), ..rule(None, None, SONNET, RefusalAfter::Stay) }]).await;
        let task = lab.react(refused(Some("cyber")));
        let req = lab.went_on("high").await;
        assert_eq!(req["params"]["thinking"], "low");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn the_main_agent_goes_back_once_the_continued_turn_has_ended() {
        let mut lab = Lab::new(vec![RefusalRule { thinking: Some(ThinkingLevel::Low), ..rule(Some("cyber"), Some(OPUS), SONNET, RefusalAfter::Back) }]).await;
        let task = lab.react(refused(Some("cyber")));
        lab.went_on("high").await;
        task.await.unwrap();
        let acts = lab.activity();
        assert_eq!(acts[0].detail.as_deref(), Some("The request asks for working exploit code. Goes back to Opus 5.5 when the turn ends."));
        lab.runs(SONNET).await;

        // The end of the refused turn is not the end of the continued one: it began before.
        lab.signal(vec![Signal::TurnEnded { aborted: false, error: Some("Refusal (cyber)".into()), refusal: Some(refusal("refusal", Some("cyber"))) }]);
        assert!(lab.request(400).await.is_none(), "the continued turn has not even begun");

        // The continued turn runs …
        lab.signal(vec![Signal::TurnStarted]);
        *lab.board.lock().unwrap() = Board { working: true, settled: false };
        assert!(lab.request(300).await.is_none());
        // … ends, and omp schedules a retry of it: not over.
        lab.signal(vec![Signal::TurnEnded { aborted: false, error: Some("529".into()), refusal: None }, Signal::Retry { attempt: 1, max: 3, error: "529".into() }]);
        *lab.board.lock().unwrap() = Board { working: false, settled: false };
        assert!(lab.request(400).await.is_none(), "omp's own retry is still to come");
        // The retry runs and ends; the agent is not settled yet (a job it waits for).
        lab.signal(vec![Signal::TurnStarted, Signal::TurnEnded { aborted: false, error: None, refusal: None }]);
        assert!(lab.request(400).await.is_none(), "not idle yet");
        *lab.board.lock().unwrap() = SETTLED;

        let back = lab.request(2_000).await.expect("back on the model the turn began with");
        assert_eq!((back["op"].as_str(), back["params"]["model"].as_str(), back["params"]["thinking"].as_str()), (Some("setModel"), Some(OPUS), Some("high")), "model and thinking level as they were");
        let req = back;
        lab.ext.ok(&req, json!({ "model": { "provider": "anthropic", "id": "claude-opus-5-5" }, "fast": false, "mode": "normal", "idle": true, "queue": { "steering": [], "followUp": [] }, "attached": true })).await;
        assert!(lab.request(300).await.is_none(), "once");
    }

    /// herdr's state trails the replica's by a moment: the board still reads `working` after the turn's
    /// end signal and settles later, with no further signal. The lab's first run lost the switch back
    /// to exactly this (the late `working` made the wait forget the turn had ended).
    #[tokio::test]
    async fn going_back_survives_a_board_that_settles_after_the_end_signal() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Back)]).await;
        let task = lab.react(refused(Some("cyber")));
        lab.went_on("high").await;
        task.await.unwrap();
        lab.runs(SONNET).await;

        lab.signal(vec![Signal::TurnStarted]);
        *lab.board.lock().unwrap() = Board { working: true, settled: false };
        tokio::time::sleep(Duration::from_millis(100)).await;
        lab.signal(vec![Signal::TurnEnded { aborted: false, error: None, refusal: None }]);
        assert!(lab.request(400).await.is_none(), "the board still says the agent works");
        *lab.board.lock().unwrap() = SETTLED;
        let back = lab.request(2_000).await.expect("back on the model the turn began with, though no signal came after the board settled");
        assert_eq!((back["op"].as_str(), back["params"]["model"].as_str()), (Some("setModel"), Some(OPUS)));
    }

    #[tokio::test]
    async fn going_back_yields_to_a_model_the_user_chose_meanwhile() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Back)]).await;
        let task = lab.react(refused(Some("cyber")));
        lab.went_on("high").await;
        task.await.unwrap();
        lab.runs("anthropic/claude-haiku-5-5").await;
        lab.signal(vec![Signal::TurnStarted, Signal::TurnEnded { aborted: false, error: None, refusal: None }]);
        assert!(lab.request(700).await.is_none(), "the user's model stays");
    }

    #[tokio::test]
    async fn going_back_stops_when_the_agent_leaves_the_board() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Back)]).await;
        let gone = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = gone.clone();
        let seen = lab.board.clone();
        lab.env.board = Arc::new(move || (!flag.load(std::sync::atomic::Ordering::SeqCst)).then(|| *seen.lock().unwrap()));
        let task = lab.react(refused(Some("cyber")));
        lab.went_on("high").await;
        task.await.unwrap();
        lab.runs(SONNET).await;
        gone.store(true, std::sync::atomic::Ordering::SeqCst);
        lab.signal(vec![Signal::TurnStarted, Signal::TurnEnded { aborted: false, error: None, refusal: None }]);
        assert!(lab.request(700).await.is_none());
    }

    #[tokio::test]
    async fn a_subagent_is_asked_again_while_its_status_lags_and_never_goes_back() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Back)]).await;
        let task = lab.react(subagent_refused(Some("cyber")));
        let notice = "Subagent 0-Task: Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued";
        for _ in 0..SUB_RETRIES {
            let req = lab.ext.recv_req().await;
            assert_eq!((req["op"].as_str(), req["params"]["agentId"].as_str(), req["params"]["notice"].as_str()), (Some("retryRefused"), Some("0-Task"), Some(notice)));
            lab.ext.ok(&req, json!({ "started": false })).await;
        }
        let req = lab.went_on("high").await;
        assert_eq!(req["params"]["agentId"], "0-Task");
        task.await.unwrap();
        assert!(lab.request(200).await.is_none(), "one call more would be a third retry");

        let acts = lab.activity();
        assert_eq!(acts.len(), 1, "{acts:?}");
        assert_eq!(acts[0].title, notice);
        assert_eq!(acts[0].detail.as_deref(), Some("The request asks for working exploit code. The subagent finishes its run on Sonnet 5.5."));
        assert_eq!(lab.notifications().len(), 1);
        lab.signal(vec![Signal::TurnStarted, Signal::TurnEnded { aborted: false, error: None, refusal: None }]);
        assert!(lab.request(500).await.is_none(), "a subagent finishes its run on the fallback model: no switch back");
    }

    #[tokio::test]
    async fn a_subagent_that_never_stops_running_keeps_its_refusal() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Stay)]).await;
        let task = lab.react(subagent_refused(Some("cyber")));
        for _ in 0..1 + SUB_RETRIES {
            let req = lab.ext.recv_req().await;
            assert_eq!(req["op"], "retryRefused");
            lab.ext.ok(&req, json!({ "started": false })).await;
        }
        task.await.unwrap();
        assert!(lab.request(200).await.is_none(), "asked 1 + {SUB_RETRIES} times, no more");
        let acts = lab.activity();
        assert_eq!(acts.len(), 1, "{acts:?}");
        assert_eq!((acts[0].kind, acts[0].title.as_str()), (ActivityKind::Error, "Refused · cyber"));
        assert_eq!(acts[0].detail.as_deref(), Some("Subagent 0-Task: The request asks for working exploit code. No fallback to Sonnet 5.5: the agent had already gone on."));
        let notes = lab.notifications();
        assert_eq!((notes.len(), notes[0].kind), (1, NotifyKind::Error));
    }

    #[tokio::test]
    async fn the_main_agent_that_had_already_gone_on_is_asked_once() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Stay)]).await;
        let task = lab.react(refused(Some("cyber")));
        let req = lab.ext.recv_req().await;
        lab.ext.ok(&req, json!({ "started": false })).await;
        task.await.unwrap();
        assert!(lab.request(200).await.is_none());
        assert_eq!(lab.activity()[0].kind, ActivityKind::Error);
    }

    #[tokio::test]
    async fn a_switch_whose_turn_did_not_continue_is_reported_and_taken_back_for_back() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Back)]).await;
        let task = lab.react(refused(Some("cyber")));
        lab.runs(SONNET).await;
        let req = lab.ext.recv_req().await;
        lab.ext.ok(&req, json!({ "started": false, "model": SONNET, "previous": { "model": OPUS, "name": "Claude Opus 5.5", "thinking": "medium" } })).await;
        let back = lab.ext.recv_req().await;
        assert_eq!((back["op"].as_str(), back["params"]["model"].as_str(), back["params"]["thinking"].as_str()), (Some("setModel"), Some(OPUS), Some("medium")));
        lab.ext.ok(&back, json!({ "fast": false, "mode": "normal", "idle": true, "queue": { "steering": [], "followUp": [] }, "attached": true })).await;
        task.await.unwrap();
        let acts = lab.activity();
        assert_eq!(acts.len(), 1, "{acts:?}");
        assert_eq!(acts[0].kind, ActivityKind::Error);
        assert_eq!(acts[0].detail.as_deref(), Some("The request asks for working exploit code. Switched to Sonnet 5.5, but the turn did not continue; back on Opus 5.5."));
        assert!(lab.request(200).await.is_none(), "the switch was not repeated");
    }

    #[tokio::test]
    async fn no_rule_leaves_the_refusal_and_posts_what_a_refusal_always_posted() {
        let mut lab = Lab::new(vec![rule(Some("bio"), None, SONNET, RefusalAfter::Stay)]).await;
        lab.react(refused(Some("cyber"))).await.unwrap();
        assert!(lab.request(200).await.is_none(), "nothing is asked of omp");
        let acts = lab.activity();
        assert_eq!(acts.len(), 1, "{acts:?}");
        assert_eq!((acts[0].kind, acts[0].title.as_str()), (ActivityKind::Error, "Refused · cyber"));
        assert_eq!(acts[0].detail.as_deref(), Some("The request asks for working exploit code."));
        let notes = lab.notifications();
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert_eq!((notes[0].kind, notes[0].title.as_str()), (NotifyKind::Error, "ana: Refused · cyber"));
    }

    #[tokio::test]
    async fn the_fallback_model_refusing_the_same_turn_is_not_fallen_back_from() {
        let mut lab = Lab::new(vec![rule(None, Some(OPUS), SONNET, RefusalAfter::Stay), rule(None, Some(SONNET), OPUS, RefusalAfter::Stay)]).await;
        let task = lab.react(refused(Some("cyber")));
        lab.went_on("high").await;
        task.await.unwrap();
        lab.notifications();

        let on_sonnet = TurnError { model: Some("claude-sonnet-5-5".into()), model_name: Some("Claude Sonnet 5.5".into()), ..refused(Some("cyber")) };
        lab.react(on_sonnet).await.unwrap();
        assert!(lab.request(200).await.is_none(), "no second fallback for the turn");
        let acts = lab.activity();
        assert_eq!(acts.len(), 2, "one entry per refusal: {acts:?}");
        assert_eq!(acts[0].kind, ActivityKind::Error);
        assert_eq!(acts[0].detail.as_deref(), Some("The request asks for working exploit code. The fallback model refused too: no further fallback for this turn."));
        assert_eq!(lab.notifications().len(), 1);
    }

    #[tokio::test]
    async fn a_turn_the_bridge_could_not_name_is_not_fallen_back_from() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Stay)]).await;
        lab.react(TurnError { prompt_at: None, ..refused(Some("cyber")) }).await.unwrap();
        assert!(lab.request(200).await.is_none());
        let acts = lab.activity();
        assert_eq!((acts.len(), acts[0].kind), (1, ActivityKind::Error));
        assert!(acts[0].detail.as_deref().unwrap().ends_with("No fallback: the turn could not be identified."));
    }

    #[tokio::test]
    async fn a_fallback_the_bridge_refuses_is_reported_with_the_reason() {
        let mut lab = Lab::new(vec![rule(None, None, SONNET, RefusalAfter::Stay)]).await;
        let task = lab.react(refused(Some("cyber")));
        let req = lab.ext.recv_req().await;
        lab.ext.send(json!({ "t": "res", "id": req["id"], "ok": false, "error": { "code": "auth_required", "message": "no credentials for anthropic/claude-sonnet-5-5" } })).await;
        task.await.unwrap();
        let acts = lab.activity();
        assert_eq!(acts.len(), 1, "{acts:?}");
        assert_eq!(acts[0].kind, ActivityKind::Error);
        assert_eq!(
            acts[0].detail.as_deref(),
            Some("The request asks for working exploit code. Falling back to Sonnet 5.5 failed: no credentials for anthropic/claude-sonnet-5-5")
        );
        assert_eq!(lab.notifications().len(), 1);
    }

    #[tokio::test]
    async fn retry_with_goes_on_once_and_tells_older_bridges_apart() {
        let mut lab = Lab::new(vec![]).await;
        let p = RefusalRetryParams { agent_id: "a1".into(), subagent_id: Some("0-Task".into()), model: SONNET.into(), thinking: Some(ThinkingLevel::High) };
        let (bridge, sent) = (lab.env.bridge.clone(), p.clone());
        let task = tokio::spawn(async move { one_off(&bridge, "s1", &sent, "Sonnet 5.5").await });
        let req = lab.ext.recv_req().await;
        assert_eq!(req["params"], json!({ "agentId": "0-Task", "model": SONNET, "thinking": "high", "notice": "Switched to Sonnet 5.5 and continued" }));
        lab.ext.ok(&req, json!({ "started": false })).await;
        assert_eq!(task.await.unwrap().unwrap(), RetryResult { started: false, via: RetryVia::Retry }, "nothing to go on with is the bridge's answer, not an error");
        assert!(lab.request(100).await.is_none());

        // Sessions of bridges without `refusals`, and unknown sessions, are `unsupported`.
        let mut old = FakeExt::connect(&lab.env.bridge).await;
        old.hello_caps(8, "s2", "2.2.0", Some(json!({ "live": 1, "turnError": true }))).await;
        assert_eq!(refusal_session(&lab.env.bridge, Some("s1".into())).unwrap(), "s1");
        for session in [Some("s2".to_owned()), Some("nope".to_owned()), None] {
            let e = refusal_session(&lab.env.bridge, session).unwrap_err();
            assert_eq!(e.code, "unsupported");
            assert!(e.hint.as_deref().is_some_and(|h| h.contains("Restart the agent")), "{e:?}");
        }
    }

    /// The 2.3.0 bridge fills `refusal` in every omp, but says `refusals` only where omp can go on
    /// with a refused turn (18.13 or newer, its agent registry found). Elsewhere the board posts the
    /// refusal from the transcript's signal (`state::on_signals`) and `retryRefused` is not for it:
    /// acting on it as well posted the refusal twice, or fell back where Retry with is refused.
    #[tokio::test]
    async fn only_a_bridge_that_can_go_on_triggers_the_fallback() {
        let mut lab = Lab::new(vec![]).await;
        let mut old = FakeExt::connect(&lab.env.bridge).await;
        old.hello_caps(8, "s2", "2.3.0", Some(json!({ "live": 1, "turnError": true }))).await;
        let (mut events, mut seen) = (lab.env.bridge.subscribe(), lab.env.bridge.subscribe());
        let turn_error = |session: &str, e: TurnError| json!({ "t": "event", "event": "turn_error", "sessionId": session, "data": e });
        old.send(turn_error("s2", refused(Some("cyber")))).await;
        lab.ext.send(turn_error("s1", TurnError { kind: "rateLimit".into(), refusal: None, ..refused(None) })).await;
        // Both reached hostd before the refusal of the bridge that can go on.
        for _ in 0..2 {
            while !matches!(seen.recv().await.unwrap(), BridgeEvent::TurnError { .. }) {}
        }
        lab.ext.send(turn_error("s1", refused(Some("cyber")))).await;
        let next = tokio::time::timeout(Duration::from_secs(5), next_refusal(&lab.env.bridge, &mut events)).await.expect("the refusal of s1");
        let (session, e) = next.unwrap();
        assert_eq!((session.as_str(), e.refusal.and_then(|r| r.category)), ("s1", Some("cyber".to_owned())));
    }
}
