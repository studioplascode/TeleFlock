//! App settings: defaults, validation, quiet hours, and the notification policy.

use std::collections::{BTreeMap, HashSet};

use tf_proto::{ApiError, ModelPreset, MotionPref, NotifyKind, Settings};

/// Most model presets one device keeps (the app's Save as preset stops there too).
pub const MAX_MODEL_PRESETS: usize = 32;
/// Longest model preset name, in characters.
pub const MAX_PRESET_NAME: usize = 48;
/// Longest model preset id (the app makes `mp-<time>-<random>`).
const MAX_PRESET_ID: usize = 64;
/// A preset's roles and chains stay within what tf-hostd takes for one agent (`agentcfg`), so a
/// saved preset always fits a launch.
const MAX_PRESET_ROLES: usize = 64;
const MAX_PRESET_CHAINS: usize = 64;
const MAX_PRESET_CHAIN_LEN: usize = 16;
const MAX_PRESET_SELECTOR: usize = 256;

pub fn default_settings(device_name: String) -> Settings {
    Settings {
        motion: MotionPref::System,
        notify_needs: true,
        notify_finished: true,
        notify_errors: true,
        notify_presented: None,
        notify_sound: true,
        quiet_start: None,
        quiet_end: None,
        keep_alive: true,
        terminal_font_size: 13,
        default_model: None,
        default_thinking: None,
        default_plan: false,
        device_name,
        muted_agents: Vec::new(),
        templates: Vec::new(),
        auto_update: true,
        close_done: true,
        share_presence: None,
        idle_after_min: None,
        device_kind: None,
        capture_shortcut: None,
        model_presets: Vec::new(),
    }
}

/// Parses `HH:MM` into minutes after midnight.
pub fn parse_hhmm(s: &str) -> Option<u16> {
    let (h, m) = s.trim().split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    let h: u16 = h.parse().ok()?;
    let m: u16 = m.parse().ok()?;
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Normalizes and validates settings coming from `settings.set`.
pub fn validate(mut s: Settings) -> Result<Settings, ApiError> {
    for (name, v) in [("quietStart", &mut s.quiet_start), ("quietEnd", &mut s.quiet_end)] {
        if let Some(t) = v.as_deref() {
            if t.trim().is_empty() {
                *v = None;
                continue;
            }
            let mins = parse_hhmm(t)
                .ok_or_else(|| ApiError::new("invalid_params", format!("{name}: expected HH:MM, got `{t}`")))?;
            *v = Some(format!("{:02}:{:02}", mins / 60, mins % 60));
        }
    }
    if !(6..=40).contains(&s.terminal_font_size) {
        return Err(ApiError::new("invalid_params", "terminalFontSize must be between 6 and 40"));
    }
    s.device_name = s.device_name.trim().chars().take(64).collect();
    // Absent = the platform default, empty = off: both kept as they are; the shell parses it.
    if let Some(k) = s.capture_shortcut.as_mut() {
        *k = k.trim().chars().take(64).collect();
    }
    if s.default_model.as_deref().is_some_and(|m| m.trim().is_empty()) {
        s.default_model = None;
    }
    if s.idle_after_min.is_some_and(|m| !(1..=60).contains(&m)) {
        return Err(ApiError::new("invalid_params", "idleAfterMin must be between 1 and 60"));
    }
    s.model_presets = model_presets(std::mem::take(&mut s.model_presets))?;
    Ok(s)
}

/// Model presets as the app sends them, tidied: names on one line with single spaces and at most
/// [`MAX_PRESET_NAME`] characters, every model, role and chain trimmed and empty ones dropped (an
/// empty chain stays: it means "no fallbacks"). Refused: more than [`MAX_MODEL_PRESETS`], an id
/// that is not the app's kind or is used twice, a preset without a name, and roles or chains
/// beyond tf-hostd's limits for an agent.
fn model_presets(presets: Vec<ModelPreset>) -> Result<Vec<ModelPreset>, ApiError> {
    if presets.len() > MAX_MODEL_PRESETS {
        return Err(invalid(format!("at most {MAX_MODEL_PRESETS} model presets")));
    }
    let mut ids = HashSet::new();
    presets
        .into_iter()
        .map(|p| {
            let p = model_preset(p)?;
            if !ids.insert(p.id.clone()) {
                return Err(invalid(format!("two model presets have the id `{}`", p.id)));
            }
            Ok(p)
        })
        .collect()
}

fn model_preset(mut p: ModelPreset) -> Result<ModelPreset, ApiError> {
    p.id = p.id.trim().to_string();
    if !preset_id_ok(&p.id) {
        return Err(invalid(format!(
            "model preset id `{}`: letters, digits, `.`, `-` and `_`, at most {MAX_PRESET_ID}",
            clip(&p.id)
        )));
    }
    let name: String = p.name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_PRESET_NAME).collect();
    p.name = name.trim_end().to_string();
    if p.name.is_empty() {
        return Err(invalid(format!("model preset `{}` needs a name", p.id)));
    }
    let what = format!("model preset `{}`", p.name);
    p.model = match p.model.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(m) => Some(bounded(&what, m)?.to_string()),
    };
    let mut roles = BTreeMap::new();
    for (role, selector) in std::mem::take(&mut p.role_models) {
        let (role, selector) = (role.trim(), selector.trim());
        if !role.is_empty() && !selector.is_empty() {
            roles.insert(bounded(&what, role)?.to_string(), bounded(&what, selector)?.to_string());
        }
    }
    if roles.len() > MAX_PRESET_ROLES {
        return Err(invalid(format!("{what}: at most {MAX_PRESET_ROLES} model roles")));
    }
    p.role_models = roles;
    let mut chains = BTreeMap::new();
    for (key, entries) in std::mem::take(&mut p.fallback_chains) {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let entries = entries
            .iter()
            .map(|e| e.trim())
            .filter(|e| !e.is_empty())
            .map(|e| bounded(&what, e).map(str::to_string))
            .collect::<Result<Vec<_>, _>>()?;
        if entries.len() > MAX_PRESET_CHAIN_LEN {
            let key = clip(key);
            return Err(invalid(format!("{what}: fallback chain `{key}` has more than {MAX_PRESET_CHAIN_LEN} fallbacks")));
        }
        chains.insert(bounded(&what, key)?.to_string(), entries);
    }
    if chains.len() > MAX_PRESET_CHAINS {
        return Err(invalid(format!("{what}: at most {MAX_PRESET_CHAINS} fallback chains")));
    }
    p.fallback_chains = chains;
    Ok(p)
}

/// What the app makes: ASCII letters and digits with `.`, `-` and `_`, starting with a letter or digit.
fn preset_id_ok(id: &str) -> bool {
    id.len() <= MAX_PRESET_ID
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// A model, role or chain of a preset no longer than tf-hostd takes.
fn bounded<'a>(what: &str, s: &'a str) -> Result<&'a str, ApiError> {
    if s.len() > MAX_PRESET_SELECTOR {
        return Err(invalid(format!("{what}: `{}` is too long (at most {MAX_PRESET_SELECTOR} bytes)", clip(s))));
    }
    Ok(s)
}

fn invalid(message: String) -> ApiError {
    ApiError::new("invalid_params", message)
}

fn clip(s: &str) -> String {
    let mut out: String = s.chars().take(80).collect();
    if out.len() < s.len() {
        out.push('…');
    }
    out
}

/// Whether `now` (minutes after local midnight) falls inside the quiet window.
pub fn in_quiet_hours(s: &Settings, now_min: u16) -> bool {
    let (Some(a), Some(b)) = (
        s.quiet_start.as_deref().and_then(parse_hhmm),
        s.quiet_end.as_deref().and_then(parse_hhmm),
    ) else {
        return false;
    };
    match a.cmp(&b) {
        std::cmp::Ordering::Equal => false,
        std::cmp::Ordering::Less => now_min >= a && now_min < b,
        std::cmp::Ordering::Greater => now_min >= a || now_min < b,
    }
}

pub fn local_minutes_now() -> u16 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    (now.hour() * 60 + now.minute()) as u16
}

/// Whether a notification of `kind` should reach the OS at all.
pub fn wants(s: &Settings, kind: NotifyKind) -> bool {
    match kind {
        NotifyKind::Needs => s.notify_needs,
        NotifyKind::Finished => s.notify_finished,
        NotifyKind::Error | NotifyKind::Quiet => s.notify_errors,
        NotifyKind::Presented => s.notify_presented != Some(false),
        NotifyKind::Info => true,
    }
}

/// The user muted this agent (`settings.mutedAgents` holds `<hostId>::<agentId>` keys).
pub fn is_muted(s: &Settings, host_id: &str, agent_id: &str) -> bool {
    s.muted_agents.iter().any(|k| k.split_once("::") == Some((host_id, agent_id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::ThinkingLevel;

    #[test]
    fn hhmm() {
        assert_eq!(parse_hhmm("07:30"), Some(450));
        assert_eq!(parse_hhmm("7:05"), Some(425));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("1230"), None);
    }

    #[test]
    fn legacy_settings_json_loads() {
        // A settings.json written before mutedAgents/templates/autoUpdate/modelPresets existed, and
        // with the `confirmArchive` key that 0.4.0 removed (unknown keys are ignored).
        let mut v = serde_json::to_value(default_settings("d".into())).unwrap();
        let o = v.as_object_mut().unwrap();
        o.remove("mutedAgents");
        o.remove("templates");
        o.remove("autoUpdate");
        o.remove("modelPresets");
        o.insert("confirmArchive".into(), serde_json::Value::Bool(true));
        let s: Settings = serde_json::from_value(v).unwrap();
        assert!(s.muted_agents.is_empty());
        assert!(s.templates.is_empty());
        assert!(s.model_presets.is_empty());
        assert!(s.auto_update);
        assert_eq!(s.device_name, "d");
    }

    #[test]
    fn muting() {
        let mut s = default_settings("d".into());
        assert!(!is_muted(&s, "lab", "a1"));
        s.muted_agents = vec!["lab::a1".into()];
        assert!(is_muted(&s, "lab", "a1"));
        assert!(!is_muted(&s, "lab", "a2"));
        assert!(!is_muted(&s, "other", "a1"));
    }

    #[test]
    fn quiet_windows() {
        let mut s = default_settings("d".into());
        assert!(!in_quiet_hours(&s, 0));
        s.quiet_start = Some("22:00".into());
        s.quiet_end = Some("07:00".into());
        assert!(in_quiet_hours(&s, 23 * 60));
        assert!(in_quiet_hours(&s, 60));
        assert!(!in_quiet_hours(&s, 7 * 60));
        assert!(!in_quiet_hours(&s, 12 * 60));
        s.quiet_start = Some("12:00".into());
        s.quiet_end = Some("13:00".into());
        assert!(in_quiet_hours(&s, 12 * 60 + 30));
        assert!(!in_quiet_hours(&s, 13 * 60));
    }

    #[test]
    fn validation() {
        let mut s = default_settings("d".into());
        s.quiet_start = Some("7:5".into());
        assert!(validate(s.clone()).is_err());
        s.quiet_start = Some("7:05".into());
        s.quiet_end = Some(" ".into());
        let v = validate(s.clone()).unwrap();
        assert_eq!(v.quiet_start.as_deref(), Some("07:05"));
        assert_eq!(v.quiet_end, None);
        s.terminal_font_size = 2;
        assert_eq!(validate(s).unwrap_err().code, "invalid_params");
    }

    #[test]
    fn capture_shortcut_keeps_off_and_trims() {
        let mut s = default_settings("d".into());
        assert_eq!(validate(s.clone()).unwrap().capture_shortcut, None);
        s.capture_shortcut = Some("  Ctrl+Shift+K ".into());
        assert_eq!(validate(s.clone()).unwrap().capture_shortcut.as_deref(), Some("Ctrl+Shift+K"));
        s.capture_shortcut = Some(" ".into());
        assert_eq!(validate(s).unwrap().capture_shortcut.as_deref(), Some(""));
    }

    #[test]
    fn kinds() {
        let mut s = default_settings("d".into());
        s.notify_finished = false;
        assert!(!wants(&s, NotifyKind::Finished));
        assert!(wants(&s, NotifyKind::Needs));
        // Presented documents: on unless switched off (settings files before 0.9.1 lack the key).
        assert!(wants(&s, NotifyKind::Presented));
        s.notify_presented = Some(false);
        assert!(!wants(&s, NotifyKind::Presented));
    }

    fn preset(id: &str, name: &str) -> ModelPreset {
        ModelPreset { id: id.into(), name: name.into(), model: None, thinking: None, role_models: BTreeMap::new(), fallback_chains: BTreeMap::new() }
    }

    fn with_presets(presets: Vec<ModelPreset>) -> Result<Vec<ModelPreset>, ApiError> {
        let mut s = default_settings("d".into());
        s.model_presets = presets;
        validate(s).map(|s| s.model_presets)
    }

    #[test]
    fn model_presets_are_tidied() {
        let mut p = preset(" mp-1 ", "  Opus \n  everywhere  ");
        p.model = Some("  ".into());
        p.thinking = Some(ThinkingLevel::High);
        p.role_models = BTreeMap::from([
            (" smol ".into(), " anthropic/claude-opus-5:high ".into()),
            ("task".into(), " ".into()),
            (" ".into(), "a/b".into()),
        ]);
        p.fallback_chains = BTreeMap::from([
            (" default ".into(), vec![" a/b ".into(), String::new()]),
            ("anthropic/*".into(), Vec::new()),
            ("  ".into(), vec!["x/y".into()]),
        ]);
        let mut long = preset("mp-2", &format!("{} tail", "x".repeat(MAX_PRESET_NAME)));
        long.model = Some(" openai/gpt-5.5 ".into());
        let out = with_presets(vec![p, long]).unwrap();
        let p = &out[0];
        assert_eq!((p.id.as_str(), p.name.as_str(), p.model.as_deref(), p.thinking), ("mp-1", "Opus everywhere", None, Some(ThinkingLevel::High)));
        assert_eq!(p.role_models, BTreeMap::from([("smol".to_string(), "anthropic/claude-opus-5:high".to_string())]));
        // An empty chain stays: it means "no fallbacks" for its key.
        assert_eq!(p.fallback_chains, BTreeMap::from([("anthropic/*".to_string(), vec![]), ("default".to_string(), vec!["a/b".to_string()])]));
        assert_eq!(out[1].name, "x".repeat(MAX_PRESET_NAME));
        assert_eq!(out[1].model.as_deref(), Some("openai/gpt-5.5"));
        assert!(with_presets(Vec::new()).unwrap().is_empty());
    }

    #[test]
    fn model_presets_refused() {
        let refused = |presets: Vec<ModelPreset>| {
            let e = with_presets(presets).unwrap_err();
            assert_eq!(e.code, "invalid_params");
            e.message
        };
        // Ids are the app's kind, and each names one preset.
        let long = "m".repeat(65);
        for id in ["", "  ", "bad id", "-mp", "mp/1", long.as_str()] {
            assert!(refused(vec![preset(id, "A")]).contains("model preset id"), "{id:?}");
        }
        assert!(refused(vec![preset("mp-1", "A"), preset(" mp-1", "B")]).contains("`mp-1`"));
        assert!(refused(vec![preset("mp-1", " \t ")]).contains("needs a name"));
        assert!(refused((0..=MAX_MODEL_PRESETS).map(|i| preset(&format!("mp-{i}"), &format!("P{i}"))).collect()).contains("at most 32 model presets"));
        // Roles and chains stay within what tf-hostd takes for one agent.
        let mut p = preset("mp-1", "Many roles");
        p.role_models = (0..=MAX_PRESET_ROLES).map(|i| (format!("r{i}"), "a/b".to_string())).collect();
        assert!(refused(vec![p]).contains("`Many roles`: at most 64 model roles"));
        let mut p = preset("mp-1", "Long chain");
        p.fallback_chains = BTreeMap::from([("default".to_string(), (0..=MAX_PRESET_CHAIN_LEN).map(|i| format!("a/m{i}")).collect())]);
        assert!(refused(vec![p]).contains("more than 16 fallbacks"));
        let mut p = preset("mp-1", "Long model");
        p.model = Some(format!("acme/{}", "x".repeat(MAX_PRESET_SELECTOR)));
        assert!(refused(vec![p]).contains("too long"));
        let mut p = preset("mp-1", "Many chains");
        p.fallback_chains = (0..=MAX_PRESET_CHAINS).map(|i| (format!("r{i}"), Vec::new())).collect();
        assert!(refused(vec![p]).contains("at most 64 fallback chains"));
    }
}
