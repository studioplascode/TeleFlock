//! Toast XML for Windows notifications (platform-independent so it is unit-tested everywhere).

use crate::present::{Category, Presentation};

pub const ARG_ACTION: &str = "a:";
pub const ARG_REPLY: &str = "reply";
pub const INPUT_ID: &str = "reply";

pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// Toast tags are limited to 64 characters; hash longer ones.
pub fn short_tag(tag: &str) -> String {
    if tag.len() <= 64 {
        return tag.to_owned();
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in tag.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:.47}#{h:016x}", tag)
}

pub fn toast_xml(p: &Presentation) -> String {
    let mut x = String::with_capacity(1024);
    let scenario = if p.category == Category::Needs && !p.buttons.is_empty() { r#" scenario="reminder""# } else { "" };
    x.push_str(&format!(
        r#"<toast launch="{}" activationType="protocol"{scenario} displayTimestamp="{}">"#,
        xml_escape(&p.open_url),
        xml_escape(&timestamp(p.at))
    ));
    x.push_str(r#"<visual><binding template="ToastGeneric">"#);
    x.push_str(&format!("<text>{}</text>", xml_escape(&p.title)));
    if !p.body.is_empty() {
        x.push_str(&format!("<text>{}</text>", xml_escape(&p.body)));
    }
    if let Some(h) = &p.host_name {
        x.push_str(&format!(r#"<text placement="attribution">{}</text>"#, xml_escape(h)));
    }
    x.push_str("</binding></visual>");
    if p.reply || !p.buttons.is_empty() {
        x.push_str("<actions>");
        if p.reply {
            x.push_str(&format!(r#"<input id="{INPUT_ID}" type="text" placeHolderContent="Reply to the agent"/>"#));
            x.push_str(&format!(
                r#"<action content="Send" arguments="{ARG_REPLY}" hint-inputId="{INPUT_ID}" activationType="foreground"/>"#
            ));
        }
        for b in &p.buttons {
            let style = if b.destructive { r#" hint-buttonStyle="Critical""# } else { "" };
            x.push_str(&format!(
                r#"<action content="{}" arguments="{}" activationType="foreground"{style}/>"#,
                xml_escape(&b.label),
                xml_escape(&format!("{ARG_ACTION}{}", b.id))
            ));
        }
        x.push_str("</actions>");
    }
    if !p.sound {
        x.push_str(r#"<audio silent="true"/>"#);
    } else if p.category == Category::Needs {
        x.push_str(r#"<audio src="ms-winsoundevent:Notification.Reminder"/>"#);
    }
    x.push_str("</toast>");
    x
}

/// ISO-8601 UTC timestamp for `displayTimestamp`.
pub fn timestamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::present::Button;

    fn pres() -> Presentation {
        Presentation {
            host_id: "h".into(),
            notification_id: "n".into(),
            tag: "h/w1:p2".into(),
            category: Category::Needs,
            title: "Allow <bash>?".into(),
            body: "rm -rf \"build\" & more".into(),
            host_name: Some("forge".into()),
            open_url: "teleflock://agent/h/w1%3Ap2?n=n&x=1".into(),
            buttons: vec![
                Button { id: "allow".into(), label: "Allow".into(), destructive: false },
                Button { id: "deny".into(), label: "Deny".into(), destructive: true },
            ],
            reply: true,
            silent: false,
            sound: true,
            at: 1_760_000_000_000,
        }
    }

    #[test]
    fn xml_is_escaped_and_complete() {
        let x = toast_xml(&pres());
        assert!(x.contains(r#"launch="teleflock://agent/h/w1%3Ap2?n=n&amp;x=1""#));
        assert!(x.contains("<text>Allow &lt;bash&gt;?</text>"));
        assert!(x.contains("rm -rf &quot;build&quot; &amp; more"));
        assert!(x.contains(r#"arguments="a:deny" activationType="foreground" hint-buttonStyle="Critical""#));
        assert!(x.contains(r#"hint-inputId="reply""#));
        assert!(x.contains(r#"scenario="reminder""#));
        assert!(x.contains(r#"displayTimestamp="2025-10-09T08:53:20Z""#));
    }

    #[test]
    fn long_tags_are_shortened() {
        let t = short_tag(&"x".repeat(100));
        assert!(t.len() <= 64);
        assert_eq!(short_tag("h/a"), "h/a");
    }
}
