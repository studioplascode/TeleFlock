//! `chat.*` (architecture §3.31): the folders TeleFlock made for chat tasks (`chat.list`) and
//! deleting a chat (`chat.delete`). The folder rules live in `crate::chats`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tracing::{info, warn};

use tf_proto::chats::{ChatDeleteParams, ChatDeletion, ChatFolder, ChatFolders};
use tf_proto::model::{Agent, HerdrState};
use tf_proto::{ApiError, HostMethod};

use crate::chats::{self, ChatRoot, Contents};
use crate::ops::{herdr_err, to_value, Ctx};
use crate::state::persist::PersistData;

/// How long a deleted chat's live agent may take to leave the board once its pane closed.
const LEAVE_WAIT: Duration = Duration::from_secs(5);

pub async fn handle(ctx: &Ctx, req: HostMethod) -> Result<Value, ApiError> {
    match req {
        HostMethod::ChatListReq(_) => to_value(list(ctx).await?),
        HostMethod::ChatDelete(p) => to_value(delete(ctx, p).await?),
        other => Err(ApiError::new("unknown_method", format!("`{}` is not a chat method", other.name()))),
    }
}

/// `chat.list`: every chat folder of this herdr session, newest first ([`listed`]), with what it
/// holds (`chats::inspect`, bounded).
async fn list(ctx: &Ctx) -> Result<ChatFolders, ApiError> {
    let root = ctx.chats.clone();
    let found = blocking("listing the chat folders", move || chats::list(&root)).await?;
    let agents = ctx.state.snapshot().agents;
    let elsewhere = elsewhere(ctx).await?;
    Ok(ChatFolders { dir: ctx.chats.path().display().to_string(), chats: listed(&ctx.chats, &agents, &elsewhere, found) })
}

/// `chat.list`'s rows: each folder `found` with what it holds and the agent on this board that
/// uses it (live first, else its card in Done or ended), titled by it, else by the folder's name.
/// A folder that only cards of another herdr session use is that session's chat: left out.
fn listed(root: &ChatRoot, agents: &[Agent], elsewhere: &Elsewhere, found: Vec<(PathBuf, Contents)>) -> Vec<ChatFolder> {
    found
        .into_iter()
        .filter_map(|(folder, c)| {
            let agent = chats::agent_in(root, agents, &folder);
            if agent.is_none() && elsewhere.contains_key(&folder) {
                return None;
            }
            let title = agent.map(|a| a.title.clone()).unwrap_or_else(|| folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            Some(ChatFolder {
                folder: folder.display().to_string(),
                agent_id: agent.map(|a| a.id.clone()),
                title,
                kept: c.kept,
                kept_count: c.kept_count,
                bytes: c.bytes,
                modified_at: c.modified_at,
            })
        })
        .collect()
}

/// The chat folders cards of the daemon's other herdr sessions work in, each with one such card's
/// title. The chats folder is the daemon's, a board one session's: such a folder is the other
/// session's chat, which this session neither lists nor removes.
type Elsewhere = HashMap<PathBuf, String>;

/// [`Elsewhere`] of `ctx`'s session ([`elsewhere_of`]): from the boards of the sessions whose
/// context is up and from `state.json`.
async fn elsewhere(ctx: &Ctx) -> Result<Elsewhere, ApiError> {
    let daemon = ctx.daemon().ok_or_else(|| ApiError::new("shutting_down", "tf-hostd is shutting down").retryable())?;
    let boards: Vec<(String, Vec<Agent>)> = daemon
        .all_ctxs()
        .await
        .into_iter()
        .filter(|c| c.herdr_session != ctx.herdr_session)
        .map(|c| (c.herdr_session.clone(), c.state.snapshot().agents))
        .collect();
    Ok(daemon.persist.read(|p| elsewhere_of(&ctx.chats, &ctx.herdr_session, &boards, p)))
}

/// The chat folders the cards of every herdr session but `own` work in: the agents on `boards`
/// (a session whose context is up: live agents, Done and ended cards) and the Done and ended
/// cards in `persisted` (`state.json`; a session whose context is not up has only those). Each
/// with the title of the first such card, else its name.
fn elsewhere_of(root: &ChatRoot, own: &str, boards: &[(String, Vec<Agent>)], persisted: &PersistData) -> Elsewhere {
    let live = boards.iter().filter(|(s, _)| s != own).flat_map(|(_, agents)| agents.iter().map(|a| (a.cwd.as_deref(), &a.title, &a.name)));
    let parked = persisted.sessions.iter().filter(|(s, _)| *s != own).flat_map(|(_, d)| d.parked.values().map(|r| (r.cwd.as_deref(), &r.title, &r.name)));
    let mut out = Elsewhere::new();
    for (cwd, title, name) in live.chain(parked) {
        if let Some(folder) = cwd.and_then(|c| root.folder_of(Path::new(c))) {
            let card = if title.is_empty() { name } else { title };
            out.entry(folder).or_insert_with(|| card.clone());
        }
    }
    out
}

/// `chat.delete`. With `dryRun`: what the folder holds, whether the agent is in a turn and which
/// other card works in the folder, nothing changes. Else the chat's agent ends and is forgotten
/// ([`end`]), then its folder goes when nothing in it is kept and no other card uses it, on this
/// board or another herdr session's ([`shared_with`]). The omp session file stays.
async fn delete(ctx: &Ctx, p: ChatDeleteParams) -> Result<ChatDeletion, ApiError> {
    let agents = ctx.state.snapshot().agents;
    let (folder, agent) = target(&ctx.chats, &agents, &p)?;
    let agent = agent.cloned();
    let working = agent.as_ref().is_some_and(in_turn);
    let shown = folder.display().to_string();
    let except = agent.as_ref().map(|a| a.id.as_str());
    if p.dry_run {
        let with = shared_with(&ctx.chats, &agents, &elsewhere(ctx).await?, &folder, except);
        let path = folder.clone();
        let c = blocking("reading the chat's folder", move || chats::inspect(&path)).await?;
        return Ok(deletion(shown, c, false, working, with));
    }
    if let Some(a) = &agent {
        end(ctx, a).await?;
    }
    // Another card in it (an agent working there, or one in Done or ended that resumes there), on
    // this board or another herdr session's.
    let others = ctx.state.snapshot().agents;
    if let Some(with) = shared_with(&ctx.chats, &others, &elsewhere(ctx).await?, &folder, except) {
        info!(folder = %shown, card = %with, "deleted chat's folder stays: another card uses it");
        let path = folder.clone();
        let c = blocking("reading the chat's folder", move || chats::inspect(&path)).await?;
        return Ok(deletion(shown, c, false, working, Some(with)));
    }
    let (root, path) = (ctx.chats.clone(), folder.clone());
    let (c, removed) = match tokio::task::spawn_blocking(move || chats::remove_if_unused(&root, &path)).await {
        Ok(Ok(done)) => done,
        Ok(Err(e)) => {
            let what = if agent.is_some() { "the chat was deleted, but its folder" } else { "the chat folder" };
            return Err(ApiError::new("io_error", format!("{what} {shown} could not be removed: {e}")).with_hint("Try again; `chat.list` still lists the folder"));
        }
        Err(e) => return Err(ApiError::new("internal", format!("removing the chat's folder: {e}"))),
    };
    info!(folder = %shown, removed, kept = c.kept_count, "chat deleted");
    Ok(deletion(shown, c, removed, working, None))
}

fn deletion(folder: String, c: Contents, removed: bool, working: bool, shared_with: Option<String>) -> ChatDeletion {
    ChatDeletion { folder, kept: c.kept, kept_count: c.kept_count, removed, working, shared_with }
}

/// Another card on the board (not `except`) that works in chat folder `folder`: the folder stays
/// with it.
fn sharer<'a>(root: &ChatRoot, agents: &'a [Agent], folder: &Path, except: Option<&str>) -> Option<&'a Agent> {
    agents.iter().find(|o| Some(o.id.as_str()) != except && uses(root, o, folder))
}

/// The title of another card (not `except`) that works in chat folder `folder`: on this board
/// ([`sharer`]), else on another herdr session's (`elsewhere`). The folder stays with it.
fn shared_with(root: &ChatRoot, agents: &[Agent], elsewhere: &Elsewhere, folder: &Path, except: Option<&str>) -> Option<String> {
    sharer(root, agents, folder, except).map(|o| o.title.clone()).or_else(|| elsewhere.get(folder).cloned())
}

/// A live agent in the middle of a turn (working, or asking something): deleting stops it.
fn in_turn(a: &Agent) -> bool {
    a.parked.is_none() && matches!(a.state, HerdrState::Working | HerdrState::Blocked)
}

/// What `chat.delete` acts on: the chat folder and the agent on the board that uses it. By
/// `agentId`: that agent (live, in Done or ended), which must run in a chat folder. By `folder`:
/// a chat folder itself (a direct child of the chats folder) and the agent using it, if any.
fn target<'a>(root: &ChatRoot, agents: &'a [Agent], p: &ChatDeleteParams) -> Result<(PathBuf, Option<&'a Agent>), ApiError> {
    let asked = p.folder.as_deref().map(crate::paths::expand_tilde);
    if let Some(id) = &p.agent_id {
        let a = agents.iter().find(|a| &a.id == id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{id}`")))?;
        let folder = a
            .cwd
            .as_deref()
            .and_then(|c| root.folder_of(Path::new(c)))
            .ok_or_else(|| ApiError::new("invalid_params", format!("{} is not a chat", a.name)))?;
        if asked.as_deref().is_some_and(|f| root.folder_of(f).as_ref() != Some(&folder)) {
            return Err(ApiError::new("invalid_params", format!("{} is a chat in {}, not in the folder given", a.name, folder.display())));
        }
        return Ok((folder, Some(a)));
    }
    let Some(path) = asked else { return Err(ApiError::new("invalid_params", "agentId or folder is required")) };
    let folder = root
        .folder_of(&path)
        .filter(|_| root.is_folder(&path))
        .ok_or_else(|| ApiError::new("invalid_params", format!("{} is not a chat folder (one directly in {})", path.display(), root.path().display())))?;
    let agent = chats::agent_in(root, agents, &folder);
    Ok((folder, agent))
}

/// Agent `a` works in chat folder `folder` (its cwd is it or in it).
fn uses(root: &ChatRoot, a: &Agent, folder: &Path) -> bool {
    a.cwd.as_deref().and_then(|c| root.folder_of(Path::new(c))).is_some_and(|f| f == folder)
}

/// Ends a chat's agent and forgets everything hostd keeps for it: a live one's pane closes as Mark
/// done closes it (its workspace too when it is alone there), also mid-turn; then its agent ledger
/// entry, auto-resume tickets, own omp settings, decide-for-me policy and card go, and
/// `HostInfo.pruned` lists it. A herdr failure closing the pane fails the delete with nothing
/// forgotten. Its omp session file stays (Past sessions, Search).
async fn end(ctx: &Ctx, a: &Agent) -> Result<(), ApiError> {
    // A resume of the card in flight would start it again in the folder that is about to go.
    let claim = match a.parked {
        Some(_) => Some(ctx.state.claim_resume(&a.id).ok_or_else(|| ApiError::new("busy", format!("{} is being resumed", a.name)).retryable())?),
        None => None,
    };
    if a.parked.is_none() {
        // A pending Mark done close would park its card again while it goes.
        ctx.state.cancel_park(&a.id);
        close(ctx, a).await?;
        if !left_board(ctx, &a.id, LEAVE_WAIT).await {
            warn!(agent = %a.id, "a deleted chat's agent is still on the board {} s after its pane closed; forgetting it anyway", LEAVE_WAIT.as_secs());
        }
    }
    let sid = a.omp.as_ref().and_then(|o| o.session_id.clone());
    crate::restart::forget_agent(ctx, &a.id);
    if let (Some(r), Some(sid)) = (crate::recovery::get(), sid.as_deref()) {
        r.close(&ctx.herdr_session, sid, None);
    }
    if let Err(e) = crate::agentcfg::Store::new(&ctx.paths).forget(&ctx.herdr_session, &a.id) {
        warn!(agent = %a.id, "dropping a deleted chat's omp settings: {e}");
    }
    crate::autoanswer::forget(ctx, &a.id);
    ctx.state.forget_chat(&a.id, sid.as_deref());
    drop(claim);
    info!(agent = %a.id, name = %a.name, "chat agent ended and forgotten");
    Ok(())
}

/// Closes a live chat agent's pane (`parked::close_pane`, as Mark done does). A pane that is gone
/// (or another agent's now) has nothing to close; herdr unreachable or refusing is the error.
async fn close(ctx: &Ctx, a: &Agent) -> Result<(), ApiError> {
    let pane = match ctx.herdr.pane_get(&a.pane_id).await {
        Ok(p) => Some(p),
        Err(e) if e.is_not_found() => None,
        Err(e) => return Err(herdr_err(e)),
    };
    match crate::state::parked::close_pane(ctx, a, pane, || false).await {
        // Gone meanwhile: closed.
        Err(e) if !e.is_not_found() => Err(herdr_err(e)),
        _ => Ok(()),
    }
}

/// Waits (at most `wait`) until the live agent `agent_id` is off the board. False: still there.
async fn left_board(ctx: &Ctx, agent_id: &str, wait: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if ctx.state.agent(agent_id).is_none_or(|a| a.parked.is_some()) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Runs file system work on the blocking pool; its error is an `io_error` saying what it did.
async fn blocking<T: Send + 'static>(what: &str, f: impl FnOnce() -> std::io::Result<T> + Send + 'static) -> Result<T, ApiError> {
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(ApiError::new("io_error", format!("{what}: {e}"))),
        Err(e) => Err(ApiError::new("internal", format!("{what}: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, name: &str, cwd: Option<&str>, parked: bool) -> Agent {
        let mut a = crate::state::parked::parked_agent(&crate::state::persist::ParkedRecord {
            agent_id: id.into(),
            name: name.into(),
            kind: "omp".into(),
            cwd: cwd.map(str::to_string),
            session_id: Some(format!("sid-{id}")),
            session_file: format!("/s/{id}.jsonl"),
            ..Default::default()
        });
        if !parked {
            a.parked = None;
            a.pane_id = format!("{id}:p1");
        }
        a
    }

    fn params(agent_id: Option<&str>, folder: Option<&str>) -> ChatDeleteParams {
        ChatDeleteParams { agent_id: agent_id.map(str::to_string), folder: folder.map(str::to_string), dry_run: false }
    }

    #[test]
    fn a_delete_finds_its_chat_by_agent_or_by_folder() {
        let root = ChatRoot::new(Path::new("/h/.teleflock/chats"));
        let agents = [
            card("t1", "trip", Some("/h/.teleflock/chats/trip-abc123"), true),
            card("t2", "trip-2", Some("/h/.teleflock/chats/trip-abc123/notes"), false),
            card("t3", "repo", Some("/h/src/app"), false),
            card("t4", "lost", None, true),
        ];
        let found = |p: ChatDeleteParams| target(&root, &agents, &p).map(|(f, a)| (f.display().to_string(), a.map(|a| a.id.clone())));
        let folder = "/h/.teleflock/chats/trip-abc123".to_string();
        // By agent: a parked card, or a live agent deeper in the folder.
        assert_eq!(found(params(Some("t1"), None)).unwrap(), (folder.clone(), Some("t1".into())));
        assert_eq!(found(params(Some("t2"), None)).unwrap(), (folder.clone(), Some("t2".into())));
        assert_eq!(found(params(Some("t2"), Some("/h/.teleflock/chats/trip-abc123/"))).unwrap().1.as_deref(), Some("t2"));
        // By folder: the live agent that uses it first.
        assert_eq!(found(params(None, Some("/h/.teleflock/chats/trip-abc123"))).unwrap(), (folder, Some("t2".into())));
        assert_eq!(found(params(None, Some("/h/.teleflock/chats/old-abc123"))).unwrap(), ("/h/.teleflock/chats/old-abc123".into(), None));
        // Never anything but a chat or a chat folder itself.
        let code = |p: ChatDeleteParams| found(p).unwrap_err().code;
        assert_eq!(code(params(Some("t3"), None)), "invalid_params");
        assert_eq!(code(params(Some("t4"), None)), "invalid_params");
        assert_eq!(code(params(Some("nope"), None)), "not_found");
        assert_eq!(code(params(Some("t1"), Some("/h/.teleflock/chats/other-abc123"))), "invalid_params");
        for folder in ["/h/.teleflock/chats", "/h/.teleflock/chats/trip-abc123/notes", "/h/src/app", "/h/.teleflock/chats-old/x", "relative/x"] {
            assert_eq!(code(params(None, Some(folder))), "invalid_params", "{folder}");
        }
        assert_eq!(code(params(None, None)), "invalid_params");
    }

    #[test]
    fn another_agent_in_the_folder_is_told_apart() {
        let root = ChatRoot::new(Path::new("/h/.teleflock/chats"));
        let folder = Path::new("/h/.teleflock/chats/trip-abc123");
        assert!(uses(&root, &card("t2", "trip", Some("/h/.teleflock/chats/trip-abc123/notes"), false), folder));
        assert!(!uses(&root, &card("t5", "plan", Some("/h/.teleflock/chats/plan-abc123"), false), folder));
        assert!(!uses(&root, &card("t6", "x", None, false), folder));
        // The card a delete names the folder's sharer: any other card in it (live, in Done or
        // ended), never the chat being deleted.
        let agents = [
            card("t1", "trip", Some("/h/.teleflock/chats/trip-abc123"), false),
            card("t5", "plan", Some("/h/.teleflock/chats/plan-abc123"), false),
            card("t7", "second", Some("/h/.teleflock/chats/trip-abc123/notes"), true),
        ];
        assert_eq!(sharer(&root, &agents, folder, Some("t1")).map(|a| a.id.as_str()), Some("t7"));
        assert_eq!(sharer(&root, &agents, folder, Some("t7")).map(|a| a.id.as_str()), Some("t1"));
        assert_eq!(sharer(&root, &agents[..2], folder, Some("t1")).map(|a| a.id.as_str()), None);
        // A folder deleted by itself has no chat of its own: any card in it keeps it.
        assert_eq!(sharer(&root, &agents[..2], folder, None).map(|a| a.id.as_str()), Some("t1"));
    }

    /// One chats folder per daemon, one board per herdr session: a folder a card of another
    /// session works in (live on its board, or its Done or ended card, also of a session whose
    /// context is not up) is that session's chat. `chat.list` here leaves it out, and
    /// `chat.delete` keeps it with that card as it keeps a folder another card here uses. This
    /// session's own cards are not "elsewhere": its own Done chat's folder still goes.
    #[test]
    fn chats_of_other_herdr_sessions_are_neither_listed_nor_removed() {
        use crate::state::persist::{ParkedRecord, PersistData};
        let root = ChatRoot::new(Path::new("/h/.teleflock/chats"));
        let at = |name: &str| root.path().join(name);
        let titled = |mut a: Agent, title: &str| {
            a.title = title.into();
            a
        };
        let record = |id: &str, title: &str, folder: &str| ParkedRecord {
            agent_id: id.into(),
            name: format!("{id}-name"),
            title: title.into(),
            cwd: Some(format!("/h/.teleflock/chats/{folder}")),
            session_file: format!("/s/{id}.jsonl"),
            ..Default::default()
        };
        // This session, "lab": a live chat, and a Done chat working deeper in its folder.
        let lab = vec![
            titled(card("t1", "mine", Some("/h/.teleflock/chats/mine-aaaaaa"), false), "Mine"),
            titled(card("t2", "done", Some("/h/.teleflock/chats/done-bbbbbb/notes"), true), "Done here"),
        ];
        // "default" is up: a live chat under the same agent id as one here (herdr ids are per
        // server), a Done card in this session's chat folder and one in a folder of its own.
        // "work" is not up: its ended chat is in `state.json` only (no title: its name).
        let boards = vec![("lab".to_owned(), lab.clone()), ("default".to_owned(), vec![titled(card("t1", "trip", Some("/h/.teleflock/chats/trip-cccccc"), false), "Plan the trip")])];
        let mut persisted = PersistData::default();
        let mut park = |session: &str, r: ParkedRecord| {
            persisted.sessions.entry(session.to_owned()).or_default().parked.insert(r.agent_id.clone(), r);
        };
        park("default", record("t8", "Second opinion", "mine-aaaaaa"));
        park("default", record("t9", "Postcodes", "postcodes-dddddd"));
        park("work", record("t3", "", "notes-eeeeee"));
        park("lab", record("t2", "Done here", "done-bbbbbb/notes"));
        let elsewhere = elsewhere_of(&root, "lab", &boards, &persisted);
        let mut used: Vec<(String, String)> = elsewhere.iter().map(|(f, t)| (f.file_name().unwrap().to_string_lossy().into_owned(), t.clone())).collect();
        used.sort();
        let want = [("mine-aaaaaa", "Second opinion"), ("notes-eeeeee", "t3-name"), ("postcodes-dddddd", "Postcodes"), ("trip-cccccc", "Plan the trip")];
        assert_eq!(used, want.map(|(f, t)| (f.to_owned(), t.to_owned())));

        // `chat.list`: this session's chats with their cards, and folders no card uses.
        let found = ["mine-aaaaaa", "done-bbbbbb", "trip-cccccc", "postcodes-dddddd", "notes-eeeeee", "old-ffffff"].map(|n| (at(n), Contents::default())).to_vec();
        let rows = listed(&root, &lab, &elsewhere, found);
        let rows: Vec<(&str, Option<&str>)> = rows.iter().map(|r| (r.title.as_str(), r.agent_id.as_deref())).collect();
        assert_eq!(rows, [("Mine", Some("t1")), ("Done here", Some("t2")), ("old-ffffff", None)]);

        // `chat.delete`: a folder another session's card works in stays with that card.
        let shared = |folder: &str, except: Option<&str>| shared_with(&root, &lab, &elsewhere, &at(folder), except);
        assert_eq!(shared("trip-cccccc", None).as_deref(), Some("Plan the trip"));
        assert_eq!(shared("notes-eeeeee", None).as_deref(), Some("t3-name"));
        assert_eq!(shared("mine-aaaaaa", Some("t1")).as_deref(), Some("Second opinion"));
        assert_eq!(shared("done-bbbbbb", Some("t2")), None);
        assert_eq!(shared("old-ffffff", None), None);
    }

    #[test]
    fn a_turn_in_progress_is_working_or_asking() {
        let mut a = card("t1", "trip", Some("/h/.teleflock/chats/trip-abc123"), false);
        for (state, working) in [(HerdrState::Working, true), (HerdrState::Blocked, true), (HerdrState::Idle, false), (HerdrState::Done, false)] {
            a.state = state;
            assert_eq!(in_turn(&a), working, "{state:?}");
        }
        // A card in Done or ended has no turn.
        let mut parked = card("t2", "trip", Some("/h/.teleflock/chats/trip-abc123"), true);
        parked.state = HerdrState::Working;
        assert!(!in_turn(&parked));
    }
}
