//! Chat tasks (architecture §3.31): agents started without a repository or a folder of the user's,
//! like a chat app with omp's tools.
//!
//! * `agent.start` with [`crate::methods::StartTarget::Chat`]: tf-hostd makes a new empty folder for
//!   the chat (`<hostd home>/chats/<name>-<id>/`, never a repository), starts the agent there with
//!   the usual launch recipe and opens it in a new tab of its herdr workspace for chats. The board
//!   marks such agents (`Agent.chat`); `HostInfo.chats` says a host starts them.
//! * `chat.list`: every chat folder on the host but the chats of another herdr session, with the
//!   agent on the board that uses it and what it holds beyond what omp and TeleFlock wrote there.
//! * `chat.delete`: ends a chat (closes its pane, forgets its card) and removes its folder when
//!   nothing but omp's own `.omp/` folder is in it and no card of any herdr session works there; a
//!   folder holding anything else stays.

use crate::Millis;

wire_struct! {
    /// `chat.delete`: one chat, by its agent (live, in Done or ended) or by its folder (from
    /// `chat.list`; the agent on the board in that folder, if any, is deleted with it).
    pub struct ChatDeleteParams {
        pub agent_id: Option<String>,
        /// A chat folder (`ChatFolder.folder`): a direct child of `HostInfo.chats`.
        pub folder: Option<String>,
        /// Only say what deleting would do; nothing changes.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[ts(as = "Option<bool>", optional)]
        pub dry_run: bool,
    }
}

wire_struct! {
    /// What `chat.delete` did, or with `dryRun` would do.
    pub struct ChatDeletion {
        /// The chat's folder.
        pub folder: String,
        /// What the folder holds beyond what omp and TeleFlock wrote there (files the agent or
        /// someone made): names relative to the folder, sorted, at most 20. While there is any,
        /// the folder stays.
        pub kept: Vec<String>,
        /// How many such entries there are (`kept` lists the first 20).
        pub kept_count: u32,
        /// The folder was removed. Never with `dryRun`.
        pub removed: bool,
        /// The chat's agent is in the middle of a turn: deleting stops it.
        pub working: bool,
        /// Another card works in the same folder, on the board (an agent started in a chat's
        /// folder, e.g. from a tab of the workspace for chats) or of another herdr session on the
        /// host: its title. The folder stays with it, whatever it holds.
        pub shared_with: Option<String>,
    }
}

wire_struct! {
    /// One chat folder (`chat.list`).
    pub struct ChatFolder {
        /// Absolute path.
        pub folder: String,
        /// The agent on the board that runs (or ran) in it: live, in Done or ended. Absent: no
        /// card uses it any more (its card was deleted while files kept it, or its omp session
        /// file was deleted).
        pub agent_id: Option<String>,
        /// The agent's title, else the folder's name.
        pub title: String,
        /// As `ChatDeletion.kept` / `keptCount`: the folder goes with its chat only while both
        /// are empty.
        pub kept: Vec<String>,
        pub kept_count: u32,
        /// Bytes of everything in it.
        pub bytes: u64,
        /// The newest modification time found in it (the folder's own when it is empty).
        pub modified_at: Option<Millis>,
    }
}

wire_struct! {
    /// `chat.list`.
    pub struct ChatFolders {
        /// Where chat folders live (`HostInfo.chats`).
        pub dir: String,
        /// Newest modification first.
        pub chats: Vec<ChatFolder>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::methods::{AgentSpec, StartParams, StartTarget};
    use crate::HostMethod;
    use serde_json::json;

    #[test]
    fn chat_target_round_trips() {
        let p = StartParams {
            target: StartTarget::Chat {},
            spec: AgentSpec {
                name: Some("trip-plan".into()),
                kind: "omp".into(),
                model: None,
                thinking: None,
                plan: false,
                prompt: Some("Plan a weekend in Lisbon".into()),
                command: None,
                images: vec![],
                role_models: Default::default(),
                fallback_chains: Default::default(),
                auto_answer: None,
            },
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["target"], json!({ "kind": "chat" }));
        assert_eq!(serde_json::from_value::<StartParams>(v).unwrap(), p);
        let HostMethod::AgentStart(parsed) = HostMethod::parse("agent.start", json!({ "target": { "kind": "chat" }, "spec": { "kind": "omp", "plan": false } })).unwrap() else {
            panic!("agent.start");
        };
        assert_eq!(parsed.target, StartTarget::Chat {});
    }

    #[test]
    fn delete_params_default_to_a_real_delete() {
        let p: ChatDeleteParams = serde_json::from_value(json!({ "agentId": "t1" })).unwrap();
        assert_eq!((p.agent_id.as_deref(), p.folder.as_deref(), p.dry_run), (Some("t1"), None, false));
        // `dryRun: false` is left out on the wire.
        assert_eq!(serde_json::to_value(&p).unwrap(), json!({ "agentId": "t1" }));
        let dry: ChatDeleteParams = serde_json::from_value(json!({ "folder": "/h/.teleflock/chats/a-x1", "dryRun": true })).unwrap();
        assert!(dry.dry_run);
        let HostMethod::ChatDelete(parsed) = HostMethod::parse("chat.delete", json!({ "agentId": "t1", "dryRun": true })).unwrap() else {
            panic!("chat.delete");
        };
        assert!(parsed.dry_run);
        assert!(matches!(HostMethod::parse("chat.list", json!({})).unwrap(), HostMethod::ChatListReq(_)));
    }

    /// An old host's agent (no `chat`) reads as no chat; a chat says so, and only then.
    #[test]
    fn agent_chat_marker_is_optional() {
        let old = json!({
            "id": "t1", "name": "a", "kind": "omp", "paneId": "w1:p1", "tabId": "w1:t1", "workspaceId": "w1",
            "state": "idle", "stateSince": 0, "column": "review", "archived": false, "turns": 0, "title": "t",
            "live": { "streaming": false, "thinking": false }
        });
        let mut a: crate::Agent = serde_json::from_value(old.clone()).unwrap();
        assert!(!a.chat);
        assert_eq!(serde_json::to_value(&a).unwrap(), old, "a non-chat agent serializes as before");
        a.chat = true;
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["chat"], true);
        assert!(serde_json::from_value::<crate::Agent>(v).unwrap().chat);
    }

    #[test]
    fn folders_round_trip() {
        let list = ChatFolders {
            dir: "/home/u/.teleflock/chats".into(),
            chats: vec![ChatFolder {
                folder: "/home/u/.teleflock/chats/lisbon-k3x9q2".into(),
                agent_id: None,
                title: "lisbon-k3x9q2".into(),
                kept: vec!["itinerary.md".into()],
                kept_count: 1,
                bytes: 812,
                modified_at: Some(1_700_000_000_000),
            }],
        };
        let v = serde_json::to_value(&list).unwrap();
        assert_eq!(v["chats"][0]["keptCount"], 1);
        assert!(v["chats"][0].get("agentId").is_none());
        assert_eq!(serde_json::from_value::<ChatFolders>(v).unwrap(), list);
    }
}
