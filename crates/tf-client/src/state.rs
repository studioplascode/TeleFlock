//! Client-side copy of each host's `HostState`: patch application, cache records, counts.

use tf_proto::{Column, HostState, Millis, StatePatch};

/// Applies hostd patches in order (entities are replaced whole; `None` deletes).
pub fn apply_patches(state: &mut HostState, ops: Vec<StatePatch>) {
    for op in ops {
        match op {
            StatePatch::Info { info } => state.info = info,
            StatePatch::Health { health } => state.health = Some(health),
            StatePatch::Usage { usage } => state.usage = usage,
            StatePatch::Workspace { id, value } => upsert(&mut state.workspaces, id, value, |w| &w.id),
            StatePatch::Agent { id, value } => upsert(&mut state.agents, id, value, |a| &a.id),
        }
    }
}

fn upsert<T>(list: &mut Vec<T>, id: String, value: Option<T>, key: impl Fn(&T) -> &String) {
    let pos = list.iter().position(|x| *key(x) == id);
    match (pos, value) {
        (Some(i), Some(v)) => list[i] = v,
        (None, Some(v)) => list.push(v),
        (Some(i), None) => {
            list.remove(i);
        }
        (None, None) => {}
    }
}

/// `(needs, running)` agent counts.
pub fn counts(state: &HostState) -> (u32, u32) {
    state.agents.iter().fold((0, 0), |(n, r), a| match a.column {
        Column::Needs => (n + 1, r),
        Column::Running => (n, r + 1),
        _ => (n, r),
    })
}

/// On-disk cache record (`data_dir/cache/<hostId>.json`).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheRecord {
    pub rev: u64,
    pub saved_at: Millis,
    pub state: HostState,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use tf_proto::*;

    pub fn host_state() -> HostState {
        HostState {
            info: HostInfo {
                hostname: "lab".into(),
                os: "linux".into(),
                arch: "x86_64".into(),
                home: "/root".into(),
                hostd_version: "0.1.0".into(),
                herdr: None,
                omp: None,
                herdr_session: "default".into(),
                herdr_sessions: vec!["default".into()],
                relay_port: DEFAULT_RELAY_PORT,
                setup: SetupStatus {
                    herdr_integration: true,
                    global_sharing: false,
                    global_bridge: false,
                    relay: true,
                    issues: vec![],
                },
                tools: None,
                pruned: Vec::new(),
            },
            health: None,
            workspaces: vec![],
            agents: vec![],
            usage: UsageTotals { cost_usd: 0.0, tokens: 0, input: 0, output: 0 },
        }
    }

    pub fn agent(id: &str, column: Column) -> Agent {
        Agent {
            id: id.into(),
            name: id.into(),
            kind: "omp".into(),
            pane_id: "w1:p1".into(),
            tab_id: "w1:t1".into(),
            workspace_id: "w1".into(),
            state: HerdrState::Idle,
            state_since: 0,
            column,
            archived: false,
            turns: 0,
            title: "t".into(),
            cwd: None,
            repo: None,
            branch: None,
            started_at: None,
            omp: None,
            live: Liveness {
                last_event_at: None,
                streaming: false,
                thinking: false,
                tool: None,
                tps: None,
                tps_split: None,
                line: None,
            },
            needs: None,
            parked: None,
            diff: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn patches_and_counts() {
        let mut s = host_state();
        apply_patches(
            &mut s,
            vec![
                StatePatch::Agent { id: "a".into(), value: Some(agent("a", Column::Running)) },
                StatePatch::Agent { id: "b".into(), value: Some(agent("b", Column::Needs)) },
                StatePatch::Agent { id: "c".into(), value: Some(agent("c", Column::Needs)) },
            ],
        );
        assert_eq!(counts(&s), (2, 1));
        apply_patches(
            &mut s,
            vec![
                StatePatch::Agent { id: "c".into(), value: None },
                StatePatch::Agent { id: "a".into(), value: Some(agent("a", Column::Review)) },
                StatePatch::Agent { id: "zz".into(), value: None },
            ],
        );
        assert_eq!(counts(&s), (1, 0));
        assert_eq!(s.agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    }
}
