//! Which account served a provider request and whether the provider refused the model there
//! (architecture §3.22 "Model access"). omp writes the credential it sent on every assistant
//! message (`credentialId`, its `auth_credentials` row); tf-hostd learns from these which account
//! serves which model.

use serde_json::Value;
use tf_proto::Millis;

use super::util::{non_empty, s, ts};

/// One provider request of an omp agent, as its assistant message records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialUse {
    /// omp's credential id (`auth_credentials.id` in its `agent.db`).
    pub credential_id: i64,
    pub provider: String,
    /// Model id as omp requested it.
    pub model: String,
    /// The provider refused the model on that account; else it answered.
    pub denied: bool,
    /// When the request ran (the message's time, else the entry's).
    pub at: Millis,
    /// The account's fingerprint as omp records it on the host that wrote the transcript: the
    /// `credential_pin` entry omp writes right after a request moved the session to another account
    /// (`hash`, SHA-256 of provider and identity). A credential id only means something on the host
    /// whose store issued it; the fingerprint names the account anywhere.
    pub account: Option<String>,
}

impl CredentialUse {
    /// What an assistant message (`message_end`, or a session entry's `message`) shows about its
    /// account: it answered (`stop`, `toolUse`, `length`), or it refused the model
    /// ([`refused_model`]). Limits, outages and aborts say nothing about access: `None`. `entry_at`
    /// is the entry's own time, for a message without one.
    pub fn of(msg: &Value, entry_at: Option<Millis>) -> Option<CredentialUse> {
        if s(msg, "role")? != "assistant" {
            return None;
        }
        let credential_id = msg.get("credentialId")?.as_i64()?;
        let model = non_empty(msg, "model")?;
        let denied = match s(msg, "stopReason")? {
            "stop" | "toolUse" | "length" => false,
            "error" if non_empty(msg, "errorMessage").and_then(refused_model).as_deref() == Some(model) => true,
            _ => return None,
        };
        Some(CredentialUse { credential_id, provider: non_empty(msg, "provider")?.to_owned(), model: model.to_owned(), denied, at: ts(msg).or(entry_at)?, account: None })
    }

    /// [`CredentialUse::of`] for a session entry (`{type: "message", message, timestamp}`).
    pub fn of_entry(entry: &Value) -> Option<CredentialUse> {
        if s(entry, "type")? != "message" {
            return None;
        }
        CredentialUse::of(entry.get("message")?, ts(entry))
    }
}

/// Requests of one credential, model and outcome: the newest stands for them all.
pub(crate) type CredentialUses = std::collections::BTreeMap<(i64, String, bool), CredentialUse>;

/// Collects the requests of one transcript in file order ([`CredentialUses`]), pairing each with the
/// `credential_pin` entry that directly follows it (its account's fingerprint).
#[derive(Debug, Default)]
pub(crate) struct Collector {
    pub uses: CredentialUses,
    /// The request the previous entry was, while nothing came between it and a pin.
    last: Option<((i64, String, bool), Millis)>,
}

impl Collector {
    /// One session entry, in file order.
    pub fn entry(&mut self, entry: &Value) {
        if s(entry, "type") == Some("credential_pin") {
            if let (Some((key, at)), Some(hash)) = (self.last.take(), non_empty(entry, "hash")) {
                if let Some(u) = self.uses.get_mut(&key).filter(|u| u.at == at && Some(u.provider.as_str()) == non_empty(entry, "provider")) {
                    u.account = Some(hash.to_owned());
                }
            }
            return;
        }
        self.last = None;
        if let Some(u) = CredentialUse::of_entry(entry) {
            self.message(u);
        }
    }

    /// A request seen as a live message (no entry follows it here).
    pub fn message(&mut self, u: CredentialUse) {
        let key = (u.credential_id, u.model.clone(), u.denied);
        let at = u.at;
        if self.uses.get(&key).is_none_or(|seen| seen.at < u.at) {
            self.uses.insert(key.clone(), u);
        }
        self.last = Some((key, at));
    }

    pub fn take(&mut self) -> Vec<CredentialUse> {
        self.last = None;
        std::mem::take(&mut self.uses).into_values().collect()
    }
}

/// The model a provider answered that the account has no access to. Anthropic answers a model the
/// account's organization cannot use with HTTP 404 and `{"type":"error","error":{"type":
/// "not_found_error","message":"model: <id>"}}`, which omp keeps as the error text `404 {…}`
/// (omp ≥ 18.20 classifies the same answer as an account-policy error and rotates on it).
pub fn refused_model(error: &str) -> Option<String> {
    let body = error.trim_start().strip_prefix("404")?.trim_start();
    // The JSON object may be followed by omp's notes (`retry-after-ms=…`).
    let v: Value = serde_json::Deserializer::from_str(body).into_iter::<Value>().next()?.ok()?;
    let e = v.get("error")?;
    if s(e, "type")? != "not_found_error" {
        return None;
    }
    let model = s(e, "message")?.strip_prefix("model: ")?.trim();
    (!model.is_empty()).then(|| model.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shape omp writes for Anthropic's answer to a model the account cannot use: credential 3
    /// is refused Claude Mythos 5.2 (404), credential 5 answers with it.
    const REFUSED: &str = r#"404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-mythos-5-2"},"request_id":"req_test_0001"}"#;

    fn message(credential: i64, stop: &str, error: Option<&str>) -> Value {
        json!({
            "role": "assistant", "api": "anthropic-messages", "provider": "anthropic", "model": "claude-mythos-5-2",
            "credentialId": credential, "stopReason": stop, "errorMessage": error, "timestamp": 1_790_000_000_000_i64, "content": []
        })
    }

    #[test]
    fn a_refused_model_and_an_answer_name_their_account() {
        assert_eq!(refused_model(REFUSED).as_deref(), Some("claude-mythos-5-2"));
        let denied = CredentialUse::of(&message(3, "error", Some(REFUSED)), None).unwrap();
        assert_eq!((denied.credential_id, denied.denied, denied.model.as_str(), denied.at), (3, true, "claude-mythos-5-2", 1_790_000_000_000));
        let served = CredentialUse::of(&message(5, "toolUse", None), None).unwrap();
        assert!(!served.denied && served.provider == "anthropic");
        let entry = json!({ "type": "message", "timestamp": "2026-09-21T14:13:20.000Z", "message": message(3, "error", Some(REFUSED)) });
        assert_eq!(CredentialUse::of_entry(&entry).map(|c| c.credential_id), Some(3));
    }

    #[test]
    fn other_failures_say_nothing_about_access() {
        let limit = r#"429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}} retry-after-ms=60000"#;
        assert_eq!(CredentialUse::of(&message(6, "error", Some(limit)), None), None);
        assert_eq!(CredentialUse::of(&message(6, "aborted", None), None), None);
        // Another model's refusal is not this one's (a fallback answered for it).
        let other = REFUSED.replace("claude-mythos-5-2", "claude-fable-5");
        assert_eq!(CredentialUse::of(&message(3, "error", Some(&other)), None), None);
        assert_eq!(refused_model("404 Not Found"), None);
        assert_eq!(refused_model(r#"404 {"type":"error","error":{"type":"not_found_error","message":"file: x"}}"#), None);
        assert_eq!(refused_model(&REFUSED.replacen("404", "400", 1)), None);
        // No credential (an API key from the environment, an older omp): nothing to learn.
        let mut keyless = message(3, "stop", None);
        keyless.as_object_mut().unwrap().remove("credentialId");
        assert_eq!(CredentialUse::of(&keyless, None), None);
        assert_eq!(CredentialUse::of(&json!({ "role": "user", "credentialId": 1 }), None), None);
    }
}
