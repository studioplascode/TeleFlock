//! The page's Content-Security-Policy per platform, as Tauri builds it: `tauri.conf.json` merged
//! with the platform's file (JSON Merge Patch). The Android WebView gives every frame Tauri's IPC,
//! invoke key included, and Tauri takes the top page's URL as any caller's origin, so a page loaded
//! into a frame there could act as the app (docs/architecture.md §8, "Framed content").
//! `tauri.android.conf.json` therefore replaces `frame-src` with the app's own `blob:` documents;
//! `srcdoc` frames (presented artifacts, scriptless on Android) are not fetched and need no source.
//! The policies are maps of directives so that the override replaces that one directive: over a
//! policy written as one string, the patch would leave Android with nothing but `frame-src`.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use tauri::utils::config::parse::read_from;
use tauri::utils::platform::Target;

type Policy = BTreeMap<String, Vec<String>>;

fn policy(config: &Value, key: &str) -> Policy {
    let Some(Value::Object(directives)) = config["app"]["security"].get(key) else {
        panic!("app.security.{key} must be a map of directives");
    };
    directives
        .iter()
        .map(|(name, sources)| {
            let sources = sources.as_str().unwrap_or_else(|| panic!("{key}.{name}: sources as one string"));
            (name.clone(), sources.split_whitespace().map(str::to_owned).collect())
        })
        .collect()
}

#[test]
fn android_frames_only_app_blobs() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
    let (android, files) = read_from(Target::Android, dir).expect("Android config");
    assert!(files.iter().any(|f| f.ends_with("tauri.android.conf.json")), "Tauri reads the Android file: {files:?}");
    for key in ["csp", "devCsp"] {
        let (mut base, mut android) = (policy(&base, key), policy(&android, key));
        assert_eq!(android.remove("frame-src"), Some(vec!["blob:".to_owned()]), "{key}: Android's frame-src");
        base.remove("frame-src");
        assert_eq!(android, base, "{key}: Android's other directives are the base policy's");
    }
}
