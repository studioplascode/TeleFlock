//! Signing in to Microsoft's sites with the Windows account (`BrowserConfig::microsoft_sign_in`;
//! Windows, off until the user turns it on on the device). It is Chrome's own integration with
//! Windows' Microsoft accounts, "Allow automatic sign-in to Microsoft® cloud identity providers":
//! the preference `auth.cloud_ap_auth.enabled` in `<profile>/Local State`, which Chrome's
//! `CloudAPAuthEnabled` policy sets (Windows 10 and later, Chrome 111 and later; in Google Chrome,
//! Chromium and Chrome for Testing; incognito contexts never use it). On, the browser adds the sign-in
//! proof Windows keeps for the account (the primary refresh token's `x-ms-RefreshTokenCredential`) to
//! its navigations to Microsoft's sign-in pages: Microsoft Entra ID signs in without asking and sees
//! the registered or managed device, as in Microsoft Edge. That hands the Windows work identity to
//! every tab, the tabs of the agents the user lets in too, which is more than keeping a sign-in the
//! user chose: so the user decides, and the organization's policy goes first.
//!
//! * The engine ([`support`]): only Google Chrome, Chromium and Chrome for Testing have the
//!   integration. Microsoft Edge has its own sign-in with the Windows account (its profile's account,
//!   Edge's settings and policies); other browsers and programs TeleFlock does not know are taken to
//!   have none. For those TeleFlock writes nothing (it only takes back a value it set while another
//!   engine ran) and never reports it on.
//! * The organization ([`organization`]; policies are only read, never written): `CloudAPAuthEnabled`
//!   0 in Google Chrome's or Chrome for Testing's policies (`SOFTWARE\Policies\Google\Chrome`,
//!   `…\Google\Chrome for Testing`, the location Chrome for Testing reads; machine or user,
//!   mandatory or recommended) or in the engine's own keeps TeleFlock from turning it on, also for
//!   an engine that does not read the policy that says no. The engine's own mandatory value is what
//!   the browser applies, whatever the profile says (the policy cannot be recommended: the browser
//!   ignores a recommended value).
//! * The profile ([`plan`]): TeleFlock sets the preference only where it is not set, records that it
//!   did (`config.json` `microsoftSignInSet`), and removes only its own value again when the user
//!   turns the setting off, the organization says no or the engine has no use for it. A value it did
//!   not set, an explicit 0 above all, stays as it is.
//! * When ([`before_start`], `run.rs`): before each start, once the last browser on the profile has
//!   exited (the browser reads `Local State` when it starts and writes it back when it quits).

use std::path::Path;

use serde_json::{Map, Value, json};
use tf_proto::{BrowserEngine, BrowserMicrosoftSignIn, MicrosoftSignInSource, MicrosoftSignInUnavailable};

use super::{discover, launch};
use crate::engine::Inner;

/// The policy's value name.
#[cfg(windows)]
const POLICY: &str = "CloudAPAuthEnabled";
/// Where Google Chrome reads its policies.
const CHROME_POLICIES: &str = r"SOFTWARE\Policies\Google\Chrome";
/// Where Chrome for Testing reads its policies (not Google Chrome's: an organization's Chrome
/// policies never reach it).
const CFT_POLICIES: &str = r"SOFTWARE\Policies\Google\Chrome for Testing";
const CHROMIUM_POLICIES: &str = r"SOFTWARE\Policies\Chromium";
/// The preference in `Local State`.
const PREF: [&str; 3] = ["auth", "cloud_ap_auth", "enabled"];

/// Where Windows keeps a policy: the machine's (`HKEY_LOCAL_MACHINE`) or the user's
/// (`HKEY_CURRENT_USER`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Hive {
    Machine,
    User,
}

/// Whether the engine has Chrome's integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Support {
    /// It has; its own policies are under this key.
    Chrome(&'static str),
    Unavailable(MicrosoftSignInUnavailable),
}

/// The engine that runs, or would (`None`: none found). TeleFlock's own browser is Chrome for
/// Testing whatever its name; a program configured by path is not known.
pub(super) fn support(engine: Option<&BrowserEngine>) -> Support {
    let Some(engine) = engine else { return Support::Unavailable(MicrosoftSignInUnavailable::Browser) };
    if engine.builtin {
        return Support::Chrome(CFT_POLICIES);
    }
    match engine.name.as_str() {
        discover::CHROME => Support::Chrome(CHROME_POLICIES),
        discover::CFT => Support::Chrome(CFT_POLICIES),
        discover::CHROMIUM => Support::Chrome(CHROMIUM_POLICIES),
        discover::EDGE => Support::Unavailable(MicrosoftSignInUnavailable::Edge),
        _ => Support::Unavailable(MicrosoftSignInUnavailable::Browser),
    }
}

/// What the organization's policy says for an engine with the integration.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct Policy {
    /// 0 anywhere TeleFlock looks: it does not turn the sign-in on.
    pub off: bool,
    /// The engine's own mandatory value (the machine's before the user's), which the browser
    /// applies over the profile's.
    pub applied: Option<bool>,
}

/// The organization's policy for an engine whose own policies are under `own`. `read` reads
/// `CloudAPAuthEnabled` under a key of a hive; values other than 0 and 1 are not the policy's, as
/// for the browser.
pub(super) fn organization(own: &str, read: &dyn Fn(Hive, &str) -> Option<u32>) -> Policy {
    let valid = |v: Option<u32>| v.filter(|v| *v <= 1);
    let mut keys = vec![CHROME_POLICIES, CFT_POLICIES];
    if !keys.contains(&own) {
        keys.push(own);
    }
    let off = keys.iter().any(|key| {
        let recommended = format!(r"{key}\Recommended");
        [Hive::Machine, Hive::User].into_iter().any(|h| valid(read(h, key)) == Some(0) || valid(read(h, &recommended)) == Some(0))
    });
    let applied = valid(read(Hive::Machine, own)).or_else(|| valid(read(Hive::User, own))).map(|v| v == 1);
    Policy { off, applied }
}

/// `CloudAPAuthEnabled` (a DWORD) under `key` in `hive`, in the 64-bit registry the browser reads.
#[cfg(windows)]
pub(super) fn read_policy(hive: Hive, key: &str) -> Option<u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY, RegGetValueW};
    let root = match hive {
        Hive::Machine => HKEY_LOCAL_MACHINE,
        Hive::User => HKEY_CURRENT_USER,
    };
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (key, name) = (wide(key), wide(POLICY));
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: NUL-terminated UTF-16 key and value names, and a DWORD buffer whose size is passed.
    let r = unsafe {
        RegGetValueW(root, key.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, std::ptr::null_mut(), (&raw mut value).cast(), &mut size)
    };
    (r == ERROR_SUCCESS).then_some(value)
}

/// Other systems have no registry (and no Microsoft sign-in through Windows).
#[cfg(not(windows))]
pub(super) fn read_policy(_: Hive, _: &str) -> Option<u32> {
    None
}

/// What a start does to the preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Change {
    Leave,
    /// TeleFlock sets it on (where nothing was set).
    Set,
    /// TeleFlock removes the value it set.
    Remove,
}

/// [`plan`]'s answer.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Plan {
    pub change: Change,
    /// The value in the profile is TeleFlock's afterwards (`config.json` `microsoftSignInSet`).
    pub ours: bool,
    /// What `browser.config` says.
    pub state: BrowserMicrosoftSignIn,
}

/// What a start does, from the engine's support, the user's choice (`chosen`), the organization's
/// policy, the preference in the profile (`current`; absent: `None`) and whether TeleFlock set that
/// value (`ours`, as recorded; it only ever sets 1).
pub(super) fn plan(support: Support, chosen: bool, policy: Policy, current: Option<i64>, ours: bool) -> Plan {
    let ours = ours && current == Some(1);
    let state = |active: bool, decided_by: Option<MicrosoftSignInSource>, unavailable: Option<MicrosoftSignInUnavailable>| BrowserMicrosoftSignIn {
        on: chosen,
        active,
        decided_by,
        unavailable,
    };
    let take_back = if ours { Change::Remove } else { Change::Leave };
    if let Support::Unavailable(why) = support {
        return Plan { change: take_back, ours: false, state: state(false, None, Some(why)) };
    }
    // TeleFlock's own value: set where nothing is (unless the engine's policy decides anyway), kept
    // while chosen and allowed, taken back otherwise; anyone else's value stays.
    let wanted = chosen && !policy.off && policy.applied.is_none();
    let (change, ours, after) = match (wanted, ours, current) {
        (true, true, _) => (Change::Leave, true, Some(1)),
        (true, false, None) => (Change::Set, true, Some(1)),
        (false, true, _) => (take_back, false, None),
        (_, false, other) => (Change::Leave, false, other),
    };
    let profile_on = after.map(|v| v != 0);
    let active = policy.applied.or(profile_on).unwrap_or(false);
    let decided_by = if policy.off || policy.applied.is_some() {
        Some(MicrosoftSignInSource::Organization)
    } else if !ours && profile_on.is_some_and(|on| on != chosen) {
        Some(MicrosoftSignInSource::Profile)
    } else {
        None
    };
    Plan { change, ours, state: state(active, decided_by, None) }
}

/// The preference in `<profile>/Local State` (absent, or not a number: `None`, as the browser takes
/// it). A file that is not JSON is an error: TeleFlock leaves it alone (on Windows it holds the key
/// the profile's cookies are encrypted with; the browser sets an unreadable one aside itself).
pub(super) fn current(profile: &Path) -> Result<Option<i64>, String> {
    let file = profile.join("Local State");
    match launch::read_prefs(&file) {
        Ok(Ok(state)) => Ok(pref_of(&state)),
        Ok(Err(e)) => Err(format!("{} is not JSON ({e})", file.display())),
        Err(e) => Err(format!("can't read {}: {e}", file.display())),
    }
}

fn pref_of(state: &Map<String, Value>) -> Option<i64> {
    let [a, b, c] = PREF;
    state.get(a)?.get(b)?.get(c)?.as_i64()
}

/// Applies `change` to `<profile>/Local State` (merged into what the browser wrote; written
/// atomically, readable by this user only).
pub(super) fn change(profile: &Path, change: Change) -> std::io::Result<()> {
    if change == Change::Leave {
        return Ok(());
    }
    let file = profile.join("Local State");
    let Ok(mut state) = launch::read_prefs(&file)? else { return Ok(()) };
    let changed = match change {
        Change::Set => launch::set_pref(&mut state, &PREF, json!(1)),
        Change::Remove => remove_pref(&mut state),
        Change::Leave => false,
    };
    if changed {
        launch::write_prefs(&file, &state)?;
    }
    Ok(())
}

/// Removes the preference, and the objects around it that it leaves empty (TeleFlock made them).
fn remove_pref(state: &mut Map<String, Value>) -> bool {
    let [a, b, c] = PREF;
    let Some(Value::Object(auth)) = state.get_mut(a) else { return false };
    let Some(Value::Object(cloud_ap)) = auth.get_mut(b) else { return false };
    if cloud_ap.remove(c).is_none() {
        return false;
    }
    if cloud_ap.is_empty() {
        auth.remove(b);
    }
    if auth.is_empty() {
        state.remove(a);
    }
    true
}

/// [`plan`] for a start of `engine` on `profile` (policies read with `read`), and its change made
/// unless `dry` (what `browser.config` asks).
pub(super) fn prepare(profile: &Path, engine: Option<&BrowserEngine>, chosen: bool, ours: bool, read: &dyn Fn(Hive, &str) -> Option<u32>, dry: bool) -> Result<Plan, String> {
    let current = current(profile)?;
    let support = support(engine);
    let policy = match support {
        Support::Chrome(own) => organization(own, read),
        Support::Unavailable(_) => Policy::default(),
    };
    let p = plan(support, chosen, policy, current, ours);
    if !dry {
        change(profile, p.change).map_err(|e| format!("can't change {}: {e}", profile.join("Local State").display()))?;
    }
    Ok(p)
}

/// What `browser.config` says about it on Windows: for the engine that runs, or would. An unreadable
/// `Local State` is said to be off (the start leaves it alone).
pub(super) fn state(profile: &Path, engine: Option<&BrowserEngine>, chosen: bool, ours: bool) -> BrowserMicrosoftSignIn {
    prepare(profile, engine, chosen, ours, &read_policy, true)
        .map(|p| p.state)
        .unwrap_or(BrowserMicrosoftSignIn { on: chosen, active: false, decided_by: None, unavailable: None })
}

/// Before a start of `engine` (Windows): the profile signs in to Microsoft's sites with the Windows
/// account when the user chose it, the engine has the integration and nothing says otherwise; it no
/// longer holds TeleFlock's value otherwise ([`plan`]).
pub(super) async fn before_start(inner: &Inner, profile: &Path, engine: &BrowserEngine) {
    let b = &inner.browser;
    let (chosen, recorded) = {
        let st = b.st.lock().unwrap();
        (st.config.microsoft_sign_in, st.config.microsoft_sign_in_set)
    };
    let p = match prepare(profile, Some(engine), chosen, recorded, &read_policy, false) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("browser: {e}; Microsoft sign-in with the Windows account is left as it is this time");
            return;
        }
    };
    if p.change != Change::Leave || chosen {
        log::info!("browser: Microsoft sign-in with the Windows account for {}: {:?} ({:?})", engine.name, p.change, p.state);
    }
    if p.ours != recorded {
        b.st.lock().unwrap().config.microsoft_sign_in_set = p.ours;
        super::save_config(inner).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const ORG: Option<MicrosoftSignInSource> = Some(MicrosoftSignInSource::Organization);
    const PROFILE: Option<MicrosoftSignInSource> = Some(MicrosoftSignInSource::Profile);
    const CHROME: Support = Support::Chrome(CHROME_POLICIES);
    const NONE: Policy = Policy { off: false, applied: None };
    const OFF: Policy = Policy { off: true, applied: None };

    fn state(on: bool, active: bool, decided_by: Option<MicrosoftSignInSource>) -> BrowserMicrosoftSignIn {
        BrowserMicrosoftSignIn { on, active, decided_by, unavailable: None }
    }

    fn plan_of(change: Change, ours: bool, state: BrowserMicrosoftSignIn) -> Plan {
        Plan { change, ours, state }
    }

    /// The decision for an engine with the integration: off by default and untouched; on where
    /// nothing is set; never over an organization's no (TeleFlock's own value removed); never over
    /// an explicit value TeleFlock did not set; turned off, only TeleFlock's own value goes.
    #[test]
    fn the_choice_the_organization_and_the_profile() {
        // The setting off: nothing is touched, nothing is recorded.
        for current in [None, Some(0), Some(1)] {
            let p = plan(CHROME, false, NONE, current, false);
            assert_eq!((p.change, p.ours), (Change::Leave, false), "{current:?}");
        }
        assert_eq!(plan(CHROME, false, NONE, None, false).state, state(false, false, None));
        // On, no policy, nothing set: TeleFlock sets it and records it; then leaves it.
        assert_eq!(plan(CHROME, true, NONE, None, false), plan_of(Change::Set, true, state(true, true, None)));
        assert_eq!(plan(CHROME, true, NONE, Some(1), true), plan_of(Change::Leave, true, state(true, true, None)));
        // Turned off again: TeleFlock's own value goes, the profile is off as before.
        assert_eq!(plan(CHROME, false, NONE, Some(1), true), plan_of(Change::Remove, false, state(false, false, None)));
        // On, but the organization's policy says no (Google Chrome's or Chrome for Testing's): not
        // turned on, said so; TeleFlock's own earlier value goes.
        assert_eq!(plan(CHROME, true, OFF, None, false), plan_of(Change::Leave, false, state(true, false, ORG)));
        assert_eq!(plan(CHROME, true, OFF, Some(1), true), plan_of(Change::Remove, false, state(true, false, ORG)));
        assert_eq!(plan(CHROME, false, OFF, None, false).state, state(false, false, ORG));
        // The engine's own policy decides whatever the user chose; nothing to set.
        let applied = |on: bool| Policy { off: !on, applied: Some(on) };
        assert_eq!(plan(CHROME, true, applied(true), None, false), plan_of(Change::Leave, false, state(true, true, ORG)));
        assert_eq!(plan(CHROME, false, applied(true), Some(0), false), plan_of(Change::Leave, false, state(false, true, ORG)));
        assert_eq!(plan(CHROME, false, applied(true), Some(1), true).change, Change::Remove, "TeleFlock's own value still goes when turned off");
        assert_eq!(plan(CHROME, true, applied(false), Some(1), true), plan_of(Change::Remove, false, state(true, false, ORG)));
        // An explicit 0 TeleFlock did not set stays, also when the user turns it on: said so.
        assert_eq!(plan(CHROME, true, NONE, Some(0), false), plan_of(Change::Leave, false, state(true, false, PROFILE)));
        // A recorded value that is no longer TeleFlock's 1 (someone set 0 since, or the profile was
        // cleared) is not TeleFlock's to remove.
        assert_eq!(plan(CHROME, false, NONE, Some(0), true), plan_of(Change::Leave, false, state(false, false, None)));
        assert_eq!(plan(CHROME, true, NONE, None, true), plan_of(Change::Set, true, state(true, true, None)));
        // Someone else's 1 stays too: on although the user did not choose it.
        assert_eq!(plan(CHROME, false, NONE, Some(1), false), plan_of(Change::Leave, false, state(false, true, PROFILE)));
    }

    fn engine(name: &str, builtin: bool) -> BrowserEngine {
        BrowserEngine { name: name.into(), path: format!(r"C:\{name}.exe"), version: None, builtin, blocked: false }
    }

    /// Only Google Chrome, Chromium and Chrome for Testing have the integration; Edge has its own;
    /// anything else has none.
    #[test]
    fn engines() {
        assert_eq!(support(Some(&engine(discover::CHROME, false))), Support::Chrome(CHROME_POLICIES));
        assert_eq!(support(Some(&engine(discover::CFT, true))), Support::Chrome(CFT_POLICIES));
        assert_eq!(support(Some(&engine("chrome.exe", true))), Support::Chrome(CFT_POLICIES), "TeleFlock's own browser, whatever its name");
        assert_eq!(support(Some(&engine(discover::CHROMIUM, false))), Support::Chrome(CHROMIUM_POLICIES));
        assert_eq!(support(Some(&engine(discover::EDGE, false))), Support::Unavailable(MicrosoftSignInUnavailable::Edge));
        for other in [discover::BRAVE, "chrome.exe", "msedge.exe"] {
            assert_eq!(support(Some(&engine(other, false))), Support::Unavailable(MicrosoftSignInUnavailable::Browser), "{other}");
        }
        assert_eq!(support(None), Support::Unavailable(MicrosoftSignInUnavailable::Browser));
    }

    /// The policy stores read: Google Chrome's and Chrome for Testing's for a no whatever runs,
    /// machine and user, mandatory and recommended; the engine's own mandatory value as applied.
    #[test]
    fn organization_policies() {
        let read_from = |set: &[(Hive, &str, u32)]| {
            let map: HashMap<(Hive, String), u32> = set.iter().map(|(h, k, v)| ((*h, k.to_string()), *v)).collect();
            move |h: Hive, k: &str| map.get(&(h, k.to_string())).copied()
        };
        assert_eq!(organization(CFT_POLICIES, &read_from(&[])), NONE);
        for (hive, key) in [
            (Hive::Machine, CHROME_POLICIES.to_string()),
            (Hive::User, format!(r"{CHROME_POLICIES}\Recommended")),
            (Hive::Machine, format!(r"{CFT_POLICIES}\Recommended")),
            (Hive::User, CFT_POLICIES.to_string()),
        ] {
            let off = read_from(&[(hive, key.as_str(), 0)]);
            for own in [CFT_POLICIES, CHROME_POLICIES, CHROMIUM_POLICIES] {
                assert!(organization(own, &off).off, "{key} in {hive:?} says no for {own}");
            }
        }
        // Applied only from the engine's own mandatory value: Google Chrome's yes does not reach
        // Chrome for Testing (it reads its own), a recommended yes is ignored as by the browser.
        let chrome_on = read_from(&[(Hive::Machine, CHROME_POLICIES, 1)]);
        assert_eq!(organization(CHROME_POLICIES, &chrome_on), Policy { off: false, applied: Some(true) });
        assert_eq!(organization(CFT_POLICIES, &chrome_on), NONE);
        assert_eq!(organization(CFT_POLICIES, &read_from(&[(Hive::User, &format!(r"{CFT_POLICIES}\Recommended"), 1)])), NONE);
        assert_eq!(organization(CFT_POLICIES, &read_from(&[(Hive::User, CFT_POLICIES, 1)])), Policy { off: false, applied: Some(true) });
        // The machine's value before the user's; another engine's no does not count; other values
        // are not the policy's.
        let both = read_from(&[(Hive::Machine, CHROME_POLICIES, 1), (Hive::User, CHROME_POLICIES, 0)]);
        assert_eq!(organization(CHROME_POLICIES, &both), Policy { off: true, applied: Some(true) });
        assert_eq!(organization(CFT_POLICIES, &read_from(&[(Hive::Machine, CHROMIUM_POLICIES, 0)])), NONE);
        assert_eq!(organization(CHROME_POLICIES, &read_from(&[(Hive::Machine, CHROME_POLICIES, 2)])), NONE);
    }

    /// From the engine to the file: Edge or an unknown program with the setting on writes nothing
    /// and says why; a value TeleFlock set while another engine ran is taken back; Chrome for Testing
    /// gets it; an explicit 0 stays.
    #[test]
    fn prepare_per_engine() {
        let td = tempfile::tempdir().unwrap();
        let profile = td.path().join("profile");
        let file = profile.join("Local State");
        let no_policy = |_: Hive, _: &str| None;
        let edge = engine(discover::EDGE, false);
        let p = prepare(&profile, Some(&edge), true, false, &no_policy, false).unwrap();
        assert_eq!((p.change, p.ours, p.state.active, p.state.unavailable), (Change::Leave, false, false, Some(MicrosoftSignInUnavailable::Edge)));
        assert!(!file.exists(), "nothing written for Edge");
        let unknown = engine("browser.exe", false);
        assert_eq!(prepare(&profile, Some(&unknown), true, false, &no_policy, false).unwrap().state.unavailable, Some(MicrosoftSignInUnavailable::Browser));
        assert!(!file.exists(), "nothing written for an unknown program");
        let cft = engine(discover::CFT, true);
        let p = prepare(&profile, Some(&cft), true, false, &no_policy, false).unwrap();
        assert_eq!((p.change, p.ours, p.state.clone()), (Change::Set, true, state(true, true, None)));
        assert_eq!(current(&profile), Ok(Some(1)));
        // The same profile now run by Edge: TeleFlock's own value goes, nothing else is written.
        let p = prepare(&profile, Some(&edge), true, true, &no_policy, false).unwrap();
        assert_eq!((p.change, p.ours, p.state.active), (Change::Remove, false, false));
        assert_eq!(current(&profile), Ok(None));
        // A dry run (`browser.config`) only says what a start would do.
        assert_eq!(prepare(&profile, Some(&cft), true, false, &no_policy, true).unwrap().change, Change::Set);
        assert_eq!(current(&profile), Ok(None));
        // An explicit 0 somebody else set stays with the setting on.
        std::fs::write(&file, json!({ "auth": { "cloud_ap_auth": { "enabled": 0 } } }).to_string()).unwrap();
        let p = prepare(&profile, Some(&cft), true, false, &no_policy, false).unwrap();
        assert_eq!((p.change, p.state), (Change::Leave, state(true, false, PROFILE)));
        assert_eq!(current(&profile), Ok(Some(0)));
        // The organization's no from Google Chrome's policies holds for Chrome for Testing too.
        std::fs::remove_file(&file).unwrap();
        let chrome_off = |h: Hive, k: &str| (h == Hive::Machine && k == CHROME_POLICIES).then_some(0);
        let p = prepare(&profile, Some(&cft), true, false, &chrome_off, false).unwrap();
        assert_eq!((p.change, p.state), (Change::Leave, state(true, false, ORG)));
        assert!(!file.exists());
    }

    /// The preference in `Local State`: set into what the browser wrote (the cookies' key stays),
    /// removed with only the objects TeleFlock made, a file that is not JSON left alone.
    #[test]
    fn local_state() {
        let td = tempfile::tempdir().unwrap();
        let profile = td.path().join("profile");
        let file = profile.join("Local State");
        let read = || serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(current(&profile), Ok(None), "before the first start");
        change(&profile, Change::Set).unwrap();
        assert_eq!(read(), json!({ "auth": { "cloud_ap_auth": { "enabled": 1 } } }));
        change(&profile, Change::Remove).unwrap();
        assert_eq!(read(), json!({}), "what TeleFlock made goes with it");
        let written = json!({ "os_crypt": { "encrypted_key": "RFBBUEkBAAAA0Iyd3wEV0RGM" }, "auth": { "ntlm_v2_enabled": true } });
        std::fs::write(&file, written.to_string()).unwrap();
        change(&profile, Change::Set).unwrap();
        let v = read();
        assert_eq!(v["os_crypt"], written["os_crypt"]);
        assert_eq!(v["auth"], json!({ "ntlm_v2_enabled": true, "cloud_ap_auth": { "enabled": 1 } }));
        change(&profile, Change::Remove).unwrap();
        assert_eq!(read(), written);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // A value that is not a number is not the preference; a file that is not JSON is left as it is.
        std::fs::write(&file, json!({ "auth": { "cloud_ap_auth": { "enabled": "yes" } } }).to_string()).unwrap();
        assert_eq!(current(&profile), Ok(None));
        std::fs::write(&file, "{\"os_crypt\": ").unwrap();
        assert!(current(&profile).unwrap_err().contains("not JSON"));
        change(&profile, Change::Set).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"os_crypt\": ");
    }
}
