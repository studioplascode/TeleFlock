//! App settings: defaults, validation, quiet hours, and the notification policy.

use tf_proto::{ApiError, MotionPref, NotifyKind, Settings};

pub fn default_settings(device_name: String) -> Settings {
    Settings {
        motion: MotionPref::System,
        notify_needs: true,
        notify_finished: true,
        notify_errors: true,
        notify_sound: true,
        quiet_start: None,
        quiet_end: None,
        keep_alive: true,
        terminal_font_size: 13,
        confirm_archive: false,
        default_model: None,
        default_thinking: None,
        default_plan: false,
        device_name,
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
    if s.default_model.as_deref().is_some_and(|m| m.trim().is_empty()) {
        s.default_model = None;
    }
    Ok(s)
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
        NotifyKind::Info => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hhmm() {
        assert_eq!(parse_hhmm("07:30"), Some(450));
        assert_eq!(parse_hhmm("7:05"), Some(425));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("1230"), None);
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
    fn kinds() {
        let mut s = default_settings("d".into());
        s.notify_finished = false;
        assert!(!wants(&s, NotifyKind::Finished));
        assert!(wants(&s, NotifyKind::Needs));
    }
}
