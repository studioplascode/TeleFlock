//! What the proxy knows about the browser: its targets as the proxy's own DevTools connection
//! (`monitor`) reports them, which tab shows which page, and which pages agents own.
//!
//! Ownership is per page (the DevTools target of a tab's top-level document, the id the UI and
//! `BrowserTabOwner` use). A page is an agent's when the agent opened it (`Target.createTarget`,
//! `/json/new`), when one of its pages opened it (`openerId`: popups and `window.open`), or when
//! the user lent it. Every other page is the user's and does not exist for agents. Chrome's tab
//! targets (`type: "tab"`, the parents of pages since Chrome 112) belong to the owner of the page
//! they show.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use tf_proto::{ApiError, BrowserTabOwner, Millis};

use super::AttachKey;

/// An agent's activity (`active_at`) is recorded at most this often, per agent and per tab.
pub(super) const ACTIVE_EVERY: Millis = 2_000;

/// A target as the browser described it last (`TargetInfo`).
#[derive(Clone, Debug)]
pub(super) struct Target {
    pub kind: String,
    pub opener: Option<String>,
    pub info: Value,
    /// When the monitor first heard of it (`Registry::seq`).
    pub seq: u64,
}

/// A page an agent opened, or a user's page lent to one.
#[derive(Clone, Debug)]
pub(super) struct Owned {
    pub who: AttachKey,
    pub lent: bool,
    pub taken_over: bool,
    pub active_at: Option<Millis>,
}

/// What a target is to one agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Vis {
    /// The agent's (it opened it, or the user lent it): it sees and drives it.
    Mine,
    /// The user's or another agent's: it does not exist for the agent.
    Foreign,
    /// The agent's, but the user took it over until they hand it back.
    TakenOver,
    /// Not decided yet: a tab whose page is not known yet, or a new page that may still turn out
    /// to be an agent's (a `Target.createTarget` has not answered, or a popup of an agent's page
    /// the monitor has not adopted yet).
    Unknown,
}

#[derive(Default)]
pub(super) struct Registry {
    /// Every target the monitor reported, by id.
    targets: HashMap<String, Target>,
    /// The target each tab shows (its page), and back.
    tab_child: HashMap<String, String>,
    child_tab: HashMap<String, String>,
    /// Pages a tab holds that it does not show yet (`subtype`: a prerendered page), by page: one
    /// is the tab's page once activated.
    standby: HashMap<String, String>,
    /// Agents' pages, by page target id.
    owned: HashMap<String, Owned>,
    /// Browser contexts agents created (`Target.createBrowserContext`).
    contexts: HashMap<String, AttachKey>,
    /// Windows of agents' tabs (`Browser.getWindowForTarget`).
    windows: HashMap<i64, AttachKey>,
    /// Agents attached right now.
    attached: HashSet<AttachKey>,
    /// When each agent last sent the browser a command.
    active: HashMap<AttachKey, Millis>,
    /// `Target.createTarget` calls on their way, per connection (0: the proxy's own), each with
    /// `seq` when it left: a page first heard of after that may be its answer.
    creating: HashMap<u64, Vec<u64>>,
    /// Counts the targets the monitor heard of.
    seq: u64,
    /// The monitor has reported every target that existed when it connected.
    pub synced: bool,
    /// `tabs()` or `active_at` changed (the app shows them).
    pub shown_changed: bool,
    /// Anything changed: connections look again at what they hold back.
    pub changed: bool,
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

impl Owned {
    fn vis_for(&self, who: &AttachKey) -> Vis {
        match (self.who == *who, self.taken_over) {
            (false, _) => Vis::Foreign,
            (true, true) => Vis::TakenOver,
            (true, false) => Vis::Mine,
        }
    }
}

impl Registry {
    fn shown(&mut self) {
        self.shown_changed = true;
        self.changed = true;
    }

    // ───────────────────────────── the monitor's reports ─────────────────────────────

    /// A target was created or changed (`targetCreated`, `targetInfoChanged`, or an attach).
    /// `created`: it is new (not part of the monitor's first report): a new page whose opener is
    /// an agent's page that the user did not take over is that agent's (a popup).
    pub fn target_seen(&mut self, info: &Value, created: bool) {
        let (Some(id), Some(kind)) = (s(info, "targetId"), s(info, "type")) else { return };
        let opener = s(info, "openerId").map(String::from);
        if created
            && kind == "page"
            && !self.owned.contains_key(id)
            && let Some(o) = opener.as_deref().and_then(|o| self.owned.get(o))
            && !o.taken_over
        {
            let who = o.who.clone();
            self.owned.insert(id.to_string(), Owned { who, lent: false, taken_over: false, active_at: None });
            self.shown();
        }
        let seq = match self.targets.get(id) {
            Some(t) => t.seq,
            None => {
                self.seq += 1;
                self.seq
            }
        };
        self.targets.insert(id.to_string(), Target { kind: kind.to_string(), opener, info: info.clone(), seq });
        // A prerendered page activated: it is its tab's page now.
        if s(info, "subtype").is_none_or(str::is_empty)
            && let Some(tab) = self.standby.remove(id)
        {
            self.tab_shows(&tab, info);
        }
        self.changed = true;
    }

    /// A target is gone (`targetDestroyed`).
    pub fn target_gone(&mut self, id: &str) {
        self.targets.remove(id);
        self.standby.remove(id);
        if let Some(child) = self.tab_child.remove(id) {
            self.child_tab.remove(&child);
        }
        if let Some(tab) = self.child_tab.remove(id)
            && self.tab_child.get(&tab).is_some_and(|c| c == id)
        {
            self.tab_child.remove(&tab);
        }
        if self.owned.remove(id).is_some() {
            self.shown();
        }
        self.changed = true;
    }

    /// Tab `tab` holds the target `child` describes: its page, or a page it does not show yet
    /// (`subtype`, a prerendered page). A tab whose page was replaced (a prerendered page
    /// activated) keeps its owner.
    pub fn tab_shows(&mut self, tab: &str, child: &Value) {
        let Some(id) = s(child, "targetId") else { return };
        if !self.targets.contains_key(id) {
            self.target_seen(child, false);
        }
        if s(child, "subtype").is_some_and(|t| !t.is_empty()) {
            self.standby.insert(id.to_string(), tab.to_string());
            self.changed = true;
            return;
        }
        let before = self.tab_child.insert(tab.to_string(), id.to_string());
        self.child_tab.insert(id.to_string(), tab.to_string());
        if let Some(old) = before
            && old != id
        {
            self.child_tab.remove(&old);
            if let Some(o) = self.owned.remove(&old) {
                self.owned.insert(id.to_string(), o);
                self.shown();
            }
        }
        self.changed = true;
    }

    /// A new browser process (or none): its targets, owners, contexts and windows are gone.
    /// Attachments and agents' activity stay.
    pub fn reset(&mut self) {
        self.resync();
        self.owned.clear();
        self.contexts.clear();
        self.windows.clear();
        self.creating.clear();
        self.shown();
    }

    /// The monitor (re)connects to the same browser: it reports every target again; owners
    /// stay until `synced_now` drops those of targets that went meanwhile.
    pub fn resync(&mut self) {
        self.targets.clear();
        self.tab_child.clear();
        self.child_tab.clear();
        self.standby.clear();
        self.synced = false;
        self.changed = true;
    }

    /// The monitor reported every target there is: owners of pages that are gone go.
    pub fn synced_now(&mut self) {
        self.synced = true;
        let before = self.owned.len();
        let targets = &self.targets;
        self.owned.retain(|id, _| targets.contains_key(id));
        if self.owned.len() != before {
            self.shown();
        }
        self.changed = true;
    }

    // ───────────────────────────── decisions ─────────────────────────────

    /// What the target described by `info` (a `TargetInfo`) is to `who`. Only tabs and pages can
    /// be an agent's here; the browser target, workers, frames and browser UI are decided by the
    /// connection that attached them.
    pub fn vis(&self, who: &AttachKey, info: &Value) -> Vis {
        let Some(id) = s(info, "targetId") else { return Vis::Foreign };
        match s(info, "type") {
            Some("tab") => self.tab_vis(who, id),
            Some("page") => self.page_vis(who, id, s(info, "openerId")),
            _ => Vis::Foreign,
        }
    }

    /// What a bare target id (a command's `targetId`) is to `who`: undecided is not its.
    pub fn id_vis(&self, who: &AttachKey, id: &str) -> Vis {
        let v = self.raw_id_vis(who, id);
        if v == Vis::Unknown { Vis::Foreign } else { v }
    }

    fn raw_id_vis(&self, who: &AttachKey, id: &str) -> Vis {
        match self.targets.get(id).map(|t| t.kind.as_str()) {
            Some("tab") => self.tab_vis(who, id),
            Some("page") | None => self.page_vis(who, id, None),
            Some(_) => Vis::Foreign,
        }
    }

    /// How `who` lost the tab or page `top` it holds a session on: `TakenOver` (the user has it
    /// until hand back) or `Foreign` (it is not the agent's any more: a lent tab the user took
    /// back). Only a definite answer counts: nothing is decided while the monitor (re)reports
    /// the targets or before it knows which page a tab shows.
    pub fn lost(&self, who: &AttachKey, top: &str) -> Option<Vis> {
        if !self.synced || !self.targets.contains_key(top) {
            return None;
        }
        match self.raw_id_vis(who, top) {
            v @ (Vis::Foreign | Vis::TakenOver) => Some(v),
            Vis::Mine | Vis::Unknown => None,
        }
    }

    /// `top` was a target and is gone (closed, or replaced in its tab).
    pub fn gone(&self, top: &str) -> bool {
        self.synced && !self.targets.contains_key(top)
    }

    fn tab_vis(&self, who: &AttachKey, tab: &str) -> Vis {
        match self.tab_child.get(tab) {
            Some(child) => match self.targets.get(child).map(|t| t.kind.as_str()) {
                Some("page") | None => self.page_vis(who, child, None),
                // Browser UI (the toolbar and omnibox of a window) is nobody's.
                Some(_) => Vis::Foreign,
            },
            None => Vis::Unknown,
        }
    }

    fn page_vis(&self, who: &AttachKey, page: &str, opener: Option<&str>) -> Vis {
        if let Some(o) = self.owned.get(page) {
            return o.vis_for(who);
        }
        // A prerendered page is its tab's owner's.
        if let Some(tab) = self.standby.get(page) {
            return self.tab_vis(who, tab);
        }
        let known = self.targets.get(page);
        let opener = opener.or_else(|| known.and_then(|t| t.opener.as_deref()));
        // A popup of an agent's page the monitor has not reported yet: it adopts it.
        let popup = known.is_none() && opener.and_then(|o| self.owned.get(o)).is_some_and(|o| !o.taken_over);
        // A page newer than a `Target.createTarget` on its way may be its answer.
        let created = self.creating.values().flatten().min().is_some_and(|start| known.is_none_or(|t| t.seq > *start));
        if popup || created { Vis::Unknown } else { Vis::Foreign }
    }

    /// The page a tab or page target stands for.
    pub fn page_of<'a>(&'a self, id: &'a str) -> &'a str {
        self.tab_child.get(id).map(String::as_str).unwrap_or(id)
    }

    /// The tab that shows `page`, when known.
    pub fn tab_of(&self, page: &str) -> Option<&str> {
        self.child_tab.get(page).map(String::as_str)
    }

    /// The browser's last description of a target.
    pub fn info(&self, id: &str) -> Option<&Value> {
        self.targets.get(id).map(|t| &t.info)
    }

    /// The pages lent to `who` that it may drive now.
    pub fn lent_to(&self, who: &AttachKey) -> Vec<String> {
        let mut v: Vec<String> =
            self.owned.iter().filter(|(_, o)| o.lent && !o.taken_over && o.who == *who).map(|(id, _)| id.clone()).collect();
        v.sort();
        v
    }

    /// `who` has a page it can drive (an agent connecting without one gets a blank tab).
    pub fn has_live_tab(&self, who: &AttachKey) -> bool {
        self.owned
            .iter()
            .any(|(id, o)| o.who == *who && !o.taken_over && (!self.synced || self.targets.contains_key(id)))
    }

    // ───────────────────────────── owners ─────────────────────────────

    /// `who` opened `page` (`Target.createTarget` answered, `/json/new`).
    pub fn opened(&mut self, who: &AttachKey, page: &str) {
        self.owned
            .entry(page.to_string())
            .or_insert_with(|| Owned { who: who.clone(), lent: false, taken_over: false, active_at: None });
        self.shown();
    }

    /// A `Target.createTarget` of connection `conn` left.
    pub fn creating(&mut self, conn: u64) {
        self.creating.entry(conn).or_default().push(self.seq);
        self.changed = true;
    }

    /// A `Target.createTarget` of connection `conn` answered (the newest one is forgotten: the
    /// older ones stay the cautious bound).
    pub fn created(&mut self, conn: u64) {
        if let Some(v) = self.creating.get_mut(&conn) {
            v.pop();
            if v.is_empty() {
                self.creating.remove(&conn);
            }
        }
        self.changed = true;
    }

    /// Connection `conn` ended: its creations will not answer any more.
    pub fn conn_gone(&mut self, conn: u64) {
        if self.creating.remove(&conn).is_some() {
            self.changed = true;
        }
    }

    pub fn context_created(&mut self, who: &AttachKey, id: &str) {
        self.contexts.insert(id.to_string(), who.clone());
    }

    /// The agent that created browser context `id`, if one did.
    pub fn context_owner(&self, id: &str) -> Option<&AttachKey> {
        self.contexts.get(id)
    }

    pub fn context_disposed(&mut self, id: &str) {
        self.contexts.remove(id);
    }

    pub fn window_of(&mut self, who: &AttachKey, id: i64) {
        self.windows.entry(id).or_insert_with(|| who.clone());
    }

    pub fn own_window(&self, who: &AttachKey, id: i64) -> bool {
        self.windows.get(&id).is_some_and(|w| w == who)
    }

    /// `who` sent a command, to `page` when it went to one of its pages.
    pub fn touch(&mut self, who: &AttachKey, page: Option<&str>, now: Millis) {
        let stale = |at: Option<Millis>| at.is_none_or(|t| now - t >= ACTIVE_EVERY);
        if stale(self.active.get(who).copied()) {
            self.active.insert(who.clone(), now);
            self.shown();
        }
        if let Some(o) = page.and_then(|p| self.owned.get_mut(p))
            && o.who == *who
            && stale(o.active_at)
        {
            o.active_at = Some(now);
            self.shown();
        }
    }

    pub fn active_at(&self, who: &AttachKey) -> Option<Millis> {
        self.active.get(who).copied()
    }

    pub fn attach(&mut self, who: &AttachKey) {
        if self.attached.insert(who.clone()) {
            self.shown();
        }
    }

    /// `who`'s attachment ended: the tabs it opened stay (detached), the ones lent to it go back
    /// to the user.
    pub fn detach(&mut self, who: &AttachKey) {
        let was = self.attached.remove(who);
        let before = self.owned.len();
        self.owned.retain(|_, o| !(o.lent && o.who == *who));
        if was || self.owned.len() != before {
            self.shown();
        }
    }

    pub fn is_attached(&self, who: &AttachKey) -> bool {
        self.attached.contains(who)
    }

    /// `browser.takeOver`: an agent's tab is the user's until `hand_back`; a lent tab goes back to
    /// the user for good.
    pub fn take_over(&mut self, page: &str) -> Result<(), ApiError> {
        let Some(o) = self.owned.get_mut(page) else {
            return Err(ApiError::new("not_found", format!("No agent uses tab {page}.")));
        };
        if o.lent {
            self.owned.remove(page);
        } else if o.taken_over {
            return Ok(());
        } else {
            o.taken_over = true;
        }
        self.shown();
        Ok(())
    }

    /// `browser.handBack`: the agent drives its tab again.
    pub fn hand_back(&mut self, page: &str) -> Result<(), ApiError> {
        let Some(o) = self.owned.get_mut(page) else {
            return Err(ApiError::new("not_found", format!("No agent tab {page}.")));
        };
        if o.taken_over {
            o.taken_over = false;
            self.shown();
        }
        Ok(())
    }

    /// `browser.lendTab`: one of the user's tabs becomes `who`'s to drive.
    pub fn lend(&mut self, page: &str, who: &AttachKey) -> Result<(), ApiError> {
        if !self.attached.contains(who) {
            return Err(ApiError::new("not_found", "That agent is not attached to the browser."));
        }
        if let Some(o) = self.owned.get(page) {
            return if o.who == *who {
                self.hand_back(page)
            } else {
                Err(ApiError::new("invalid_params", "This tab belongs to another agent."))
            };
        }
        if self.synced && self.targets.get(page).is_none_or(|t| t.kind != "page") {
            return Err(ApiError::new("not_found", format!("No tab {page}.")));
        }
        self.owned.insert(page.to_string(), Owned { who: who.clone(), lent: true, taken_over: false, active_at: None });
        self.shown();
        Ok(())
    }

    /// Agents' tabs for `BrowserStatus::tabs` (names are the caller's), in a stable order.
    pub fn tabs(&self) -> Vec<BrowserTabOwner> {
        let mut v: Vec<BrowserTabOwner> = self
            .owned
            .iter()
            .map(|(id, o)| BrowserTabOwner {
                target_id: id.clone(),
                host_id: o.who.host_id.clone(),
                agent_id: o.who.agent_id.clone(),
                agent_name: String::new(),
                lent: o.lent,
                taken_over: o.taken_over,
                detached: !self.attached.contains(&o.who),
                active_at: o.active_at,
            })
            .collect();
        v.sort_by(|a, b| (&a.host_id, &a.agent_id, &a.target_id).cmp(&(&b.host_id, &b.agent_id, &b.target_id)));
        v
    }
}
