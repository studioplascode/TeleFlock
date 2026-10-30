//! Routing, escalation, retraction and push of [`Notifier`] against real client queues, a real
//! (empty) state store and a recording HTTP client, on tokio's paused clock.

#![cfg(unix)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use tf_proto::host::ServerMsg;
use tf_proto::{ClientInfo, DeviceKind, EscalateTo, Notification, NotifyKind, NotifyPolicy, Presence, PresenceState, PushChannelSave, PushKind, PushWhen};

use super::push::{Request, Response};
use super::store::NotifyFile;
use super::*;
use crate::clients::{ClientHandle, Features};
use crate::state::StateHandle;

struct Lab {
    n: Notifier,
    state: StateHandle,
    sent: Arc<Mutex<Vec<Request>>>,
    dir: tempfile::TempDir,
}

async fn lab(policy: NotifyPolicy) -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let persist = crate::state::persist::Persist::load(dir.path().join("state.json"));
    let cancel = CancellationToken::new();
    cancel.cancel();
    let bridge = crate::bridge::BridgeHandle::bind(crate::bridge::BridgeEndpoint::Unix(dir.path().join("b.sock")), "s".into()).unwrap();
    let omp = crate::omp::OmpHandle::start(0, persist.clone(), cancel, bridge.clone()).await;
    let state = StateHandle::new("lab", persist, omp, bridge);
    let sent = Arc::new(Mutex::new(Vec::new()));
    let rec = sent.clone();
    let http: Http = Arc::new(move |req| {
        rec.lock().unwrap().push(req);
        Box::pin(async { Ok(Response { status: 200, body: "{}".into() }) })
    });
    let file = NotifyFile { policy, channels: Vec::new() };
    let n = Notifier::with(dir.path().join("notify.json"), file, http, "forge".into(), CancellationToken::new());
    state.route_notifications(n.clone());
    Lab { n, state, sent, dir }
}

fn policy(after: u32, to: EscalateTo) -> NotifyPolicy {
    NotifyPolicy { route: true, escalate_after_s: after, escalate_to: to }
}

fn client(id: &str, device: &str, presence: bool) -> ClientHandle {
    let info = ClientInfo { app: "teleflock-desktop".into(), version: "0.7.0".into(), platform: "linux".into(), device: device.into(), features: None };
    ClientHandle::with_features(id.into(), info, Features { presence, ..Features::default() })
}

fn presence(state: PresenceState, device: DeviceKind) -> Presence {
    Presence { state, device, input_at: Some(1), os_notifications: true }
}

fn note(id: &str, kind: NotifyKind) -> Notification {
    Notification { id: id.into(), at: 1_000, kind, agent_id: String::new(), title: format!("{id} title"), body: format!("{id} body"), request_id: None, actions: vec![] }
}

/// What a client was sent since the last call.
fn drain(c: &ClientHandle) -> Vec<ServerMsg> {
    let mut lines = Vec::new();
    c.take_batch(&mut lines);
    lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn alert_of(msgs: &[ServerMsg]) -> Vec<Option<bool>> {
    msgs.iter().filter_map(|m| if let ServerMsg::Notify { alert, .. } = m { Some(*alert) } else { None }).collect()
}

fn channel(lab: &Lab, kind: PushKind, when: PushWhen, url: Option<&str>) -> String {
    let (token, user, secret) = match kind {
        PushKind::Pushover => (Some("azGDORePK8gMaC0QOYAMyEEuzJnyUi".to_string()), Some("uQiRzpo4DXghDmr9QzzfQu27cmVRsG".to_string()), None),
        PushKind::Webhook => (None, None, Some("whsec_lab".to_string())),
        PushKind::Ntfy => (Some("tk_lab".to_string()), None, None),
    };
    lab.n
        .save_channel(PushChannelSave {
            id: None,
            kind,
            name: format!("{kind:?}"),
            enabled: true,
            when,
            kinds: vec![NotifyKind::Needs, NotifyKind::Error, NotifyKind::Finished],
            private: false,
            url: url.map(str::to_string),
            token,
            user,
            secret,
        })
        .unwrap()
}

/// Lets spawned deliveries run (paused clock: advances only when everything is idle).
async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

fn taken(lab: &Lab) -> Vec<(String, String, Value)> {
    std::mem::take(&mut *lab.sent.lock().unwrap())
        .into_iter()
        .map(|r| (r.method.to_string(), r.url.clone(), serde_json::from_slice(&r.body).unwrap_or(Value::Null)))
        .collect()
}

#[tokio::test]
async fn the_device_in_use_alerts_the_others_list_quietly() {
    let lab = lab(policy(300, EscalateTo::Phones)).await;
    let (desk, phone, old) = (client("c1", "Desk", true), client("c2", "Pixel", true), client("c3", "Old", false));
    for c in [&desk, &phone, &old] {
        lab.n.client_attached("lab", c);
    }
    lab.n.presence_changed(&desk, presence(PresenceState::Active, DeviceKind::Desktop));
    lab.n.presence_changed(&phone, presence(PresenceState::Idle, DeviceKind::Phone));
    let sinks = [desk.clone(), phone.clone(), old.clone()];
    lab.n.post(&lab.state, "lab", &sinks, note("n1", NotifyKind::Finished), None);
    assert_eq!(alert_of(&drain(&desk)), [Some(true)]);
    assert_eq!(alert_of(&drain(&phone)), [Some(false)]);
    assert_eq!(alert_of(&drain(&old)), [None], "older apps get the message they always got");

    // Away from the desk: the phone alerts at once.
    lab.n.presence_changed(&desk, presence(PresenceState::Away, DeviceKind::Desktop));
    lab.n.post(&lab.state, "lab", &sinks, note("n2", NotifyKind::Needs), None);
    assert_eq!((alert_of(&drain(&desk)), alert_of(&drain(&phone))), (vec![Some(false)], vec![Some(true)]));

    let s = lab.n.presence("lab");
    assert_eq!((s.apps, s.reporting, s.active), (3, 2, 0));
    assert!(lab.n.any_app_connected("lab") && !lab.n.any_app_connected("other"));
    let cfg = lab.n.config("lab", "c2");
    assert_eq!(cfg.devices.iter().map(|d| (d.name.as_str(), d.me, d.presence.is_some())).collect::<Vec<_>>(), [("Desk", false, true), ("Pixel", true, true), ("Old", false, false)]);
}

#[tokio::test(start_paused = true)]
async fn unseen_notifications_escalate_once_reads_stop_and_retract() {
    let lab = lab(policy(60, EscalateTo::Phones)).await;
    let (desk, phone, laptop) = (client("c1", "Desk", true), client("c2", "Pixel", true), client("c3", "Laptop", true));
    for c in [&desk, &phone, &laptop] {
        lab.n.client_attached("lab", c);
    }
    lab.n.presence_changed(&desk, presence(PresenceState::Active, DeviceKind::Desktop));
    lab.n.presence_changed(&phone, presence(PresenceState::Idle, DeviceKind::Phone));
    lab.n.presence_changed(&laptop, presence(PresenceState::Idle, DeviceKind::Desktop));
    let sinks = [desk.clone(), phone.clone(), laptop.clone()];
    lab.n.post(&lab.state, "lab", &sinks, note("n1", NotifyKind::Error), None);
    lab.n.post(&lab.state, "lab", &sinks, note("n2", NotifyKind::Needs), None);
    lab.n.post(&lab.state, "lab", &sinks, note("n3", NotifyKind::Finished), None);
    for c in [&desk, &phone, &laptop] {
        drain(c);
    }

    // Read on the desk before the deadline: the others drop it, nobody escalates it.
    tokio::time::sleep(Duration::from_secs(30)).await;
    lab.n.notify_read(&desk, vec!["n2".into(), "nope".into()]);
    assert!(drain(&desk).is_empty(), "the reader is not told");
    for c in [&phone, &laptop] {
        assert_eq!(drain(c), [ServerMsg::NotifyDone { ids: vec!["n2".into()], by: Some("Desk".into()) }]);
    }
    lab.n.notify_read(&laptop, vec!["n2".into()]);
    assert!(drain(&phone).is_empty(), "read once is enough");

    tokio::time::sleep(Duration::from_secs(29)).await;
    assert!(drain(&phone).is_empty(), "not yet");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(drain(&phone), [ServerMsg::NotifyAlert { id: "n1".into() }], "n1 only: n2 was read, n3 never escalates");
    assert!(drain(&laptop).is_empty() && drain(&desk).is_empty(), "phones first");
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert!(drain(&phone).is_empty(), "once");
}

#[tokio::test(start_paused = true)]
async fn escalation_to_all_and_without_a_phone() {
    let lab = lab(policy(10, EscalateTo::Phones)).await;
    let (desk, laptop) = (client("c1", "Desk", true), client("c3", "Laptop", true));
    for c in [&desk, &laptop] {
        lab.n.client_attached("lab", c);
    }
    lab.n.presence_changed(&desk, presence(PresenceState::Active, DeviceKind::Desktop));
    lab.n.presence_changed(&laptop, presence(PresenceState::Idle, DeviceKind::Desktop));
    lab.n.post(&lab.state, "lab", &[desk.clone(), laptop.clone()], note("n1", NotifyKind::Quiet), None);
    drain(&laptop);
    tokio::time::sleep(Duration::from_secs(11)).await;
    assert_eq!(drain(&laptop), [ServerMsg::NotifyAlert { id: "n1".into() }], "no phone connected: every other device");
}

#[tokio::test(start_paused = true)]
async fn unseen_pushes_wait_also_when_nobody_was_in_use() {
    let lab = lab(policy(60, EscalateTo::Phones)).await;
    channel(&lab, PushKind::Webhook, PushWhen::Unseen, Some("http://127.0.0.1:18737/hook"));
    // The desktop app is open, nobody is at it, no phone app (an iPhone with a push channel).
    let desk = client("c1", "Desk", true);
    lab.n.client_attached("lab", &desk);
    lab.n.presence_changed(&desk, presence(PresenceState::Idle, DeviceKind::Desktop));
    lab.n.post(&lab.state, "lab", &[desk.clone()], note("n1", NotifyKind::Needs), None);
    lab.n.post(&lab.state, "lab", &[desk.clone()], note("n2", NotifyKind::Error), None);
    assert_eq!(alert_of(&drain(&desk)), [Some(true), Some(true)], "nobody in use, no phone: every device at once");
    settle().await;
    assert!(taken(&lab).is_empty(), "an app is connected");
    lab.n.notify_read(&desk, vec!["n2".into()]);
    tokio::time::sleep(Duration::from_secs(61)).await;
    let sent: Vec<(String, String)> = taken(&lab).into_iter().map(|(_, _, b)| (b["id"].as_str().unwrap().to_string(), b["reason"].as_str().unwrap().to_string())).collect();
    assert_eq!(sent, [("n1".to_string(), "unseen".to_string())], "n2 was read in time");
    assert!(drain(&desk).is_empty(), "the desk alerted already");
}

#[tokio::test(start_paused = true)]
async fn pushes_go_out_when_nobody_is_connected_or_nobody_saw_it() {
    let lab = lab(policy(60, EscalateTo::Phones)).await;
    let ntfy = channel(&lab, PushKind::Ntfy, PushWhen::Offline, Some("http://127.0.0.1:18737/tf-lab"));
    channel(&lab, PushKind::Webhook, PushWhen::Unseen, Some("http://127.0.0.1:18737/hook"));
    channel(&lab, PushKind::Pushover, PushWhen::Always, None);

    // No app: every channel.
    lab.n.post(&lab.state, "lab", &[], note("n1", NotifyKind::Needs), None);
    settle().await;
    let mut urls: Vec<String> = taken(&lab).into_iter().map(|(_, u, _)| u).collect();
    urls.sort();
    assert_eq!(urls, ["http://127.0.0.1:18737/", "http://127.0.0.1:18737/hook", "https://api.pushover.net/1/messages.json"]);

    // An app in use: only `always` now, `unseen` once nobody read it in time, never twice.
    let desk = client("c1", "Desk", true);
    lab.n.client_attached("lab", &desk);
    lab.n.presence_changed(&desk, presence(PresenceState::Active, DeviceKind::Desktop));
    lab.n.post(&lab.state, "lab", &[desk.clone()], note("n2", NotifyKind::Error), None);
    settle().await;
    assert_eq!(taken(&lab).into_iter().map(|(_, u, _)| u).collect::<Vec<_>>(), ["https://api.pushover.net/1/messages.json"]);
    tokio::time::sleep(Duration::from_secs(61)).await;
    let sent = taken(&lab);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!((sent[0].1.as_str(), sent[0].2["event"].as_str(), sent[0].2["reason"].as_str(), sent[0].2["id"].as_str()), ("http://127.0.0.1:18737/hook", Some("notification"), Some("unseen"), Some("n2")));

    // Read on a device: the webhook hears `done`; ntfy clears what it still shows.
    lab.n.notify_read(&desk, vec!["n2".into(), "n1".into()]);
    settle().await;
    let mut sent = taken(&lab);
    sent.sort_by(|a, b| (&a.1, a.2["id"].as_str()).cmp(&(&b.1, b.2["id"].as_str())));
    assert_eq!(sent.len(), 3, "{sent:?}");
    let hooks: Vec<(&str, &str, &str, &str, &str)> = sent[..2]
        .iter()
        .map(|(_, u, b)| (u.as_str(), b["event"].as_str().unwrap(), b["id"].as_str().unwrap(), b["by"].as_str().unwrap(), b["reason"].as_str().unwrap()))
        .collect();
    assert_eq!(hooks, [("http://127.0.0.1:18737/hook", "done", "n1", "Desk", "read"), ("http://127.0.0.1:18737/hook", "done", "n2", "Desk", "read")]);
    assert_eq!((sent[2].0.as_str(), sent[2].1.as_str()), ("PUT", "http://127.0.0.1:18737/tf-lab/tf-n1/clear"), "only what ntfy still shows");

    // Secrets stay on the host: the view lists which ones are stored, never their values.
    let cfg = lab.n.config("lab", "c1");
    let json = serde_json::to_string(&cfg).unwrap();
    assert!(!json.contains("tk_lab") && !json.contains("whsec_lab") && !json.contains("azGDOReP") && !json.contains("tf-lab"), "{json}");
    assert_eq!(cfg.channels.iter().find(|c| c.id == ntfy).unwrap().saved, ["url", "token"]);
    let file = std::fs::read_to_string(lab.dir.path().join("notify.json")).unwrap();
    assert!(file.contains("tk_lab"), "kept in the owner-only file");
}

#[tokio::test(start_paused = true)]
async fn a_pushed_question_is_taken_back_once_answered_even_after_a_newer_note() {
    let lab = lab(policy(60, EscalateTo::Phones)).await;
    channel(&lab, PushKind::Ntfy, PushWhen::Unseen, Some("http://127.0.0.1:18737/tf-lab"));
    channel(&lab, PushKind::Webhook, PushWhen::Unseen, Some("http://127.0.0.1:18737/hook"));
    let mut ask = note("n1", NotifyKind::Needs);
    ask.agent_id = "a1".into();
    ask.request_id = Some("r1".into());
    // Nobody connected: pushed.
    lab.n.post(&lab.state, "lab", &[], ask, Some("fix".into()));
    settle().await;
    assert_eq!(taken(&lab).len(), 2);
    // The desk comes back and the agent finishes (the question was answered there): the newer
    // note replaces the question in the apps but goes to no `unseen` channel.
    let desk = client("c1", "Desk", true);
    lab.n.client_attached("lab", &desk);
    lab.n.presence_changed(&desk, presence(PresenceState::Active, DeviceKind::Desktop));
    let mut done = note("n2", NotifyKind::Finished);
    done.agent_id = "a1".into();
    lab.n.post(&lab.state, "lab", &[desk.clone()], done, Some("fix".into()));
    settle().await;
    assert!(taken(&lab).is_empty());
    // The question's cause is gone (its agent no longer waits on r1): its pushed copies go.
    tokio::time::sleep(Duration::from_secs(6)).await;
    let mut sent = taken(&lab);
    sent.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(sent.len(), 2, "{sent:?}");
    assert_eq!((sent[0].0.as_str(), sent[0].1.as_str()), ("POST", "http://127.0.0.1:18737/hook"));
    assert_eq!((sent[0].2["event"].as_str(), sent[0].2["id"].as_str(), sent[0].2["reason"].as_str()), (Some("done"), Some("n1"), Some("answered")));
    assert_eq!((sent[1].0.as_str(), sent[1].1.as_str()), ("PUT", "http://127.0.0.1:18737/tf-lab/tf-lab-a1/clear"));
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(taken(&lab).is_empty(), "once; the finished note never escalates");
}

#[tokio::test(start_paused = true)]
async fn bursts_then_one_summary_per_twenty_seconds() {
    let lab = lab(policy(0, EscalateTo::Phones)).await;
    channel(&lab, PushKind::Ntfy, PushWhen::Offline, Some("https://ntfy.sh/tf-lab-burst"));
    for i in 0..8 {
        lab.n.post(&lab.state, "lab", &[], note(&format!("n{i}"), NotifyKind::Finished), None);
    }
    settle().await;
    let sent = taken(&lab);
    assert_eq!(sent.len(), 5, "the burst");
    assert!(sent.iter().all(|(_, _, b)| b["sequence_id"].is_string()));
    tokio::time::sleep(Duration::from_secs(19)).await;
    assert!(taken(&lab).is_empty());
    tokio::time::sleep(Duration::from_secs(2)).await;
    let sent = taken(&lab);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].2["title"], "3 TeleFlock notifications");
    assert_eq!(sent[0].2["message"], "• n5 title\n• n6 title\n• n7 title");
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert!(taken(&lab).is_empty(), "nothing left");
}

#[tokio::test]
async fn channel_tests_report_and_wait_between() {
    let lab = lab(policy(0, EscalateTo::Phones)).await;
    let id = channel(&lab, PushKind::Webhook, PushWhen::Offline, Some("http://127.0.0.1:18737/hook"));
    let r = lab.n.test(&lab.state, "lab", NotifyTestParams { channel_id: Some(id.clone()), escalate: false }).await.unwrap();
    let push = r.push.unwrap();
    assert!(push.ok && push.test && push.status == Some(200));
    assert_eq!(taken(&lab)[0].2["reason"], "test");
    let again = lab.n.test(&lab.state, "lab", NotifyTestParams { channel_id: Some(id.clone()), escalate: false }).await.unwrap_err();
    assert_eq!(again.code, "busy");
    assert_eq!(lab.n.config("lab", "").channels[0].last.as_ref().map(|l| l.ok), Some(true), "stored as the channel's last result");

    // A routed test goes to the device in use.
    let (desk, phone) = (client("c1", "Desk", true), client("c2", "Pixel", true));
    for c in [&desk, &phone] {
        lab.n.client_attached("lab", c);
    }
    lab.n.presence_changed(&desk, presence(PresenceState::Active, DeviceKind::Desktop));
    let r = lab.n.test(&lab.state, "lab", NotifyTestParams { channel_id: None, escalate: true }).await.unwrap();
    assert_eq!(r.alerted, ["Desk"]);
    assert_eq!(alert_of(&drain(&phone)), [Some(false)]);
}

fn agent(column: &str, needs_request: Option<&str>) -> tf_proto::Agent {
    let mut v = serde_json::json!({
        "id": "a1", "name": "fix", "kind": "omp", "paneId": "p", "tabId": "t", "workspaceId": "w", "state": "idle", "stateSince": 0,
        "column": column, "archived": false, "turns": 1, "title": "t", "live": { "streaming": false, "thinking": false }
    });
    if let Some(r) = needs_request {
        v["needs"] = serde_json::json!({ "kind": "ask", "requestId": r, "since": 0, "title": "Q", "question": "?", "options": [], "multi": false, "allowOther": false, "allowChat": false, "answerable": true });
    }
    serde_json::from_value(v).unwrap()
}

#[test]
fn causes_that_still_hold() {
    let mut n = note("n", NotifyKind::Needs);
    n.agent_id = "a1".into();
    n.request_id = Some("r1".into());
    assert!(still_relevant(Some(&agent("needs", Some("r1"))), &n));
    assert!(!still_relevant(Some(&agent("needs", Some("r2"))), &n), "a newer question");
    assert!(!still_relevant(Some(&agent("running", None)), &n), "answered");
    assert!(!still_relevant(None, &n), "gone");
    let mut archived = agent("needs", Some("r1"));
    archived.archived = true;
    assert!(!still_relevant(Some(&archived), &n));
    n.kind = NotifyKind::Error;
    assert!(still_relevant(Some(&agent("review", None)), &n) && !still_relevant(Some(&agent("running", None)), &n));
    n.kind = NotifyKind::Quiet;
    assert!(still_relevant(Some(&agent("running", None)), &n) && !still_relevant(Some(&agent("review", None)), &n));
    assert!(still_relevant(None, &note("host-level", NotifyKind::Error)));
}
