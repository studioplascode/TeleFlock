//! `session.context` (architecture §3.20): what fills an omp session's context window, computed by
//! omp itself (the data of its `/context` viewer) through the TeleFlock bridge (≥ 2.1.0,
//! `caps.context`; docs/bridge-protocol.md "Context breakdown"). hostd only checks and bounds the
//! answer: every list and string is capped, numbers are clamped to whole non-negative tokens.

use std::time::Duration;

use serde_json::{json, Map, Value};
use tf_proto::{ApiError, ContextXray, XrayCategory, XrayEntry, XrayGroup, XraySource};

use crate::ops::agent::{bridge_sid, omp_agent};
use crate::ops::Ctx;
use crate::util::{clip, now_ms};

/// omp tokenizes the whole history for it (as its own `/context` does); a long session takes a while.
const TIMEOUT: Duration = Duration::from_secs(30);
const RESTART_HINT: &str = "Restart the agent so its omp loads the current TeleFlock bridge (Mark done, then Resume), or run /context in its terminal";

const MAX_CATEGORIES: usize = 16;
const MAX_CHILDREN: usize = 64;
const MAX_TOP: usize = 10;
const MAX_PREVIEW: usize = 240;
const MAX_LABEL: usize = 160;

pub async fn get(ctx: &Ctx, agent_id: &str) -> Result<ContextXray, ApiError> {
    let a = omp_agent(ctx, agent_id)?;
    let sid = bridge_sid(ctx, agent_id).ok_or_else(|| {
        ApiError::new("unsupported", format!("{}'s omp has no TeleFlock bridge, which reads its context breakdown", a.name)).with_hint(RESTART_HINT)
    })?;
    if !ctx.bridge.by_session(&sid).is_some_and(|b| b.caps.context) {
        return Err(ApiError::new("unsupported", format!("{} runs a TeleFlock bridge older than 2.1.0, which can't read its context breakdown", a.name))
            .with_hint(RESTART_HINT));
    }
    let v = ctx.bridge.call(&sid, "context", json!({}), TIMEOUT).await.map_err(ApiError::from)?;
    parse(&v)
}

/// The bridge's `context` result as the wire type (docs/bridge-protocol.md "Context breakdown").
pub(crate) fn parse(v: &Value) -> Result<ContextXray, ApiError> {
    let o = v.as_object().ok_or_else(|| bad("not an object"))?;
    let source = match o.get("source").and_then(Value::as_str) {
        Some("omp") => XraySource::Omp,
        Some("estimate") => XraySource::Estimate,
        Some("usage") => XraySource::Usage,
        other => return Err(bad(&format!("unknown source {other:?}"))),
    };
    let categories = list(o, "categories", MAX_CATEGORIES).filter_map(category).collect();
    Ok(ContextXray {
        source,
        model: text(o, "model", MAX_LABEL),
        window: tokens(o, "window"),
        used: tokens(o, "used"),
        buffer: tokens(o, "buffer"),
        free: tokens(o, "free"),
        threshold: opt_tokens(o, "threshold"),
        categories,
        images: count(o, "images"),
        drop_images: o.get("dropImages").and_then(Value::as_bool).unwrap_or(false),
        snapcompact_saved: opt_tokens(o, "snapcompactSaved").filter(|&n| n > 0),
        at: o.get("at").and_then(Value::as_f64).filter(|f| f.is_finite() && *f > 0.0).map_or_else(now_ms, |f| f as i64),
    })
}

fn bad(why: &str) -> ApiError {
    ApiError::new("omp_error", format!("unexpected context breakdown from the bridge: {why}"))
}

fn list<'a>(o: &'a Map<String, Value>, key: &str, max: usize) -> impl Iterator<Item = &'a Map<String, Value>> {
    o.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).take(max)
}

fn text(o: &Map<String, Value>, key: &str, max: usize) -> Option<String> {
    o.get(key).and_then(Value::as_str).map(|s| clip(s, max)).filter(|s| !s.is_empty())
}

/// Whole non-negative tokens (estimates may come as floats; anything else counts 0).
fn opt_tokens(o: &Map<String, Value>, key: &str) -> Option<u64> {
    o.get(key).and_then(Value::as_f64).filter(|f| f.is_finite()).map(|f| f.max(0.0).round() as u64)
}

fn tokens(o: &Map<String, Value>, key: &str) -> u64 {
    opt_tokens(o, key).unwrap_or(0)
}

fn count(o: &Map<String, Value>, key: &str) -> u32 {
    tokens(o, key).min(u64::from(u32::MAX)) as u32
}

fn category(o: &Map<String, Value>) -> Option<XrayCategory> {
    Some(XrayCategory {
        id: text(o, "id", 64)?,
        label: text(o, "label", MAX_LABEL)?,
        tokens: opt_tokens(o, "tokens"),
        weight: tokens(o, "weight"),
        entries: count(o, "entries"),
        children: list(o, "children", MAX_CHILDREN)
            .filter_map(|c| {
                Some(XrayGroup { label: text(c, "label", MAX_LABEL)?, tokens: opt_tokens(c, "tokens"), weight: tokens(c, "weight"), entries: count(c, "entries") })
            })
            .collect(),
        top: list(o, "top", MAX_TOP).filter_map(entry).collect(),
    })
}

fn entry(o: &Map<String, Value>) -> Option<XrayEntry> {
    Some(XrayEntry {
        id: text(o, "id", MAX_LABEL)?,
        label: text(o, "label", MAX_LABEL).unwrap_or_default(),
        info: text(o, "info", MAX_LABEL),
        tokens: tokens(o, "tokens"),
        preview: o.get("preview").and_then(Value::as_str).map(|s| clip(&s.split_whitespace().collect::<Vec<_>>().join(" "), MAX_PREVIEW)).unwrap_or_default(),
        chars: tokens(o, "chars"),
        at: opt_tokens(o, "at").filter(|&t| t > 0).map(|t| t as i64),
        call_id: text(o, "callId", MAX_LABEL),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed `context` answer of bridge 2.1.0 on omp 18.13.3 (lab), source `omp`.
    fn sample() -> Value {
        json!({
            "source": "omp", "model": "Lab Mock", "window": 200000, "used": 23116, "buffer": 30000, "free": 146884,
            "threshold": 170000, "images": 1, "dropImages": true, "snapcompactSaved": 0, "at": 1_761_740_000_000_i64,
            "categories": [
                {"id": "system-prompt", "label": "System Prompt (excluding Skills)", "tokens": 9874, "weight": 10420, "entries": 3,
                 "top": [{"id": "system-prompt/0", "label": "System Block 1", "tokens": 10102, "preview": "You are a  coding\n agent", "chars": 41003}]},
                {"id": "skills", "label": "Skills", "tokens": 233, "weight": 246, "entries": 0},
                {"id": "built-in-tools", "label": "Built-in Tools", "tokens": 11001.6, "weight": 11612, "entries": 24},
                {"id": "tool-output", "label": "Tool Output", "tokens": 2008, "weight": 2120, "entries": 2,
                 "children": [{"label": "bash", "tokens": 1508, "weight": 1592, "entries": 1}, {"label": "read", "tokens": 500, "weight": 528, "entries": 1}],
                 "top": [{"id": "tool-output/4/4", "label": "bash", "tokens": 1592, "preview": "line\nline", "chars": 6100, "at": 1_761_739_990_000_i64, "callId": "toolu_1"}]},
                {"id": "", "label": "no id: dropped", "tokens": 1}
            ]
        })
    }

    #[test]
    fn parses_omps_breakdown() {
        let x = parse(&sample()).unwrap();
        assert_eq!(x.source, XraySource::Omp);
        assert_eq!((x.window, x.used, x.buffer, x.free, x.threshold), (200_000, 23_116, 30_000, 146_884, Some(170_000)));
        assert_eq!((x.images, x.drop_images, x.snapcompact_saved, x.model.as_deref()), (1, true, None, Some("Lab Mock")));
        assert_eq!(x.categories.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["system-prompt", "skills", "built-in-tools", "tool-output"]);
        let sp = &x.categories[0];
        assert_eq!((sp.tokens, sp.weight, sp.entries), (Some(9874), 10_420, 3));
        assert_eq!(sp.top[0].preview, "You are a coding agent");
        assert_eq!(x.categories[2].tokens, Some(11_002)); // rounded
        let out = &x.categories[3];
        assert_eq!(out.children.iter().map(|c| (c.label.as_str(), c.tokens)).collect::<Vec<_>>(), [("bash", Some(1508)), ("read", Some(500))]);
        assert_eq!(out.top[0].call_id.as_deref(), Some("toolu_1"));
        assert_eq!(out.top[0].at, Some(1_761_739_990_000));
    }

    #[test]
    fn bounds_whatever_the_bridge_sends() {
        let mut v = sample();
        v["used"] = json!(-5);
        v["window"] = json!("200000");
        v["images"] = json!(1e12);
        let entries: Vec<Value> = (0..50).map(|i| json!({"id": format!("e{i}"), "label": "x".repeat(500), "tokens": i, "preview": "y ".repeat(500)})).collect();
        v["categories"][0]["top"] = Value::Array(entries);
        v["categories"][1]["tokens"] = Value::Null;
        let x = parse(&v).unwrap();
        assert_eq!((x.used, x.window, x.images), (0, 0, u32::MAX));
        let top = &x.categories[0].top;
        assert_eq!(top.len(), MAX_TOP);
        assert!(top.iter().all(|e| e.label.chars().count() <= MAX_LABEL && e.preview.chars().count() <= MAX_PREVIEW));
        assert_eq!(x.categories[1].tokens, None); // omp shows "—"
        let many: Vec<Value> = (0..40).map(|i| json!({"id": format!("c{i}"), "label": "c"})).collect();
        assert_eq!(parse(&json!({"source": "estimate", "categories": many})).unwrap().categories.len(), MAX_CATEGORIES);
    }

    #[test]
    fn totals_only_and_bad_answers() {
        let x = parse(&json!({"source": "usage", "window": 272000, "used": 1000, "free": 271000})).unwrap();
        assert_eq!((x.source, x.categories.len(), x.threshold, x.drop_images), (XraySource::Usage, 0, None, false));
        assert!(x.at > 0);
        assert_eq!(parse(&json!({"source": "magic"})).unwrap_err().code, "omp_error");
        assert_eq!(parse(&json!([1, 2])).unwrap_err().code, "omp_error");
    }
}
