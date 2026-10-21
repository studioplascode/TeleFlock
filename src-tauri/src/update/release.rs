//! GitHub release discovery: which release, if any, this platform updates to.
//!
//! Pure logic over the `GET /repos/{REPO}/releases` JSON; the HTTP side lives in `net.rs`.

use semver::Version;
use serde::Deserialize;

/// `owner/repo` the app updates from (public repo; the API is read anonymously).
pub const REPO: &str = "studioplascode/TeleFlock";
/// `productName` in tauri.conf.json: the prefix of every release asset.
const PRODUCT: &str = "TeleFlock";
/// Tauri static update manifest uploaded with each release (read by tauri-plugin-updater).
const MANIFEST: &str = "latest.json";

/// Newest 30 releases, newest first. Unauthenticated: 60 requests per hour per IP.
pub fn releases_url() -> String {
    format!("https://api.github.com/repos/{REPO}/releases?per_page=30")
}

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
}

/// Platforms with an update path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// NSIS installer, installed by tauri-plugin-updater from `latest.json`.
    Windows,
    /// Universal APK verified against its `.sha256`, installed by the system package installer.
    Android,
    /// x86_64 AppImage, replaced in place by tauri-plugin-updater from `latest.json`.
    AppImage,
    /// x86_64 `.deb`, installed by tauri-plugin-updater (`pkexec dpkg -i`) from `latest.json`.
    Deb,
    /// Universal (arm64 + x86_64) `.dmg` built by `.github/workflows/macos.yml`: offered as a
    /// manual download only. CI never holds the updater key and CI-built packages are never
    /// signed with it, so there is nothing the app could verify and install by itself.
    MacOs,
}

/// Why a Linux copy can't update itself (shown in Settings → Updates).
pub const LINUX_PACMAN: &str = "Installed with pacman: update TeleFlock with your package manager (AUR: teleflock-bin).";
pub const LINUX_OTHER: &str =
    "This copy can't update itself. Install the .deb or the AppImage from GitHub releases to get automatic updates.";
pub const OTHER_PLATFORM: &str = "No automatic updates on this platform: download new versions from GitHub releases.";

/// How the running Linux copy was installed: the inputs of [`Target::linux`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LinuxInstall {
    /// The bundler marked the binary as the AppImage's (`tauri::utils::platform::bundle_type`).
    pub appimage_bundle: bool,
    /// The bundler marked the binary as the `.deb`'s. The Arch package repackages that binary.
    pub deb_bundle: bool,
    /// `$APPIMAGE` is set: the AppImage runtime started us.
    pub appimage_env: bool,
    /// dpkg's database lists the running binary as part of the `teleflock` package.
    pub dpkg_owned: bool,
    /// pacman's database has a `teleflock*` package.
    pub pacman_owned: bool,
}

impl Target {
    /// The running platform, or why the app can't update itself here.
    pub fn current() -> Result<Self, &'static str> {
        if cfg!(windows) {
            Ok(Self::Windows)
        } else if cfg!(target_os = "android") {
            Ok(Self::Android)
        } else if cfg!(target_os = "macos") {
            Ok(Self::MacOs)
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Self::linux(LinuxInstall::detect())
        } else {
            Err(OTHER_PLATFORM)
        }
    }

    /// AppImage and `.deb` installs update through tauri-plugin-updater (which picks its
    /// installer from the same bundle marker); a pacman-managed copy (the Arch package carries
    /// the `.deb` binary) or a bare binary must not.
    pub fn linux(i: LinuxInstall) -> Result<Self, &'static str> {
        if i.appimage_bundle && i.appimage_env {
            Ok(Self::AppImage)
        } else if i.pacman_owned {
            Err(LINUX_PACMAN)
        } else if i.deb_bundle && i.dpkg_owned {
            Ok(Self::Deb)
        } else {
            Err(LINUX_OTHER)
        }
    }
}

impl LinuxInstall {
    /// The `.deb` package name (tauri-bundler: `productName` in kebab case).
    const DEB_PACKAGE: &str = "tele-flock";

    pub fn detect() -> Self {
        use tauri::utils::{config::BundleType, platform::bundle_type};
        let exe = std::env::current_exe().ok();
        let dpkg_owned = exe.is_some_and(|exe| {
            std::fs::read_to_string(format!("/var/lib/dpkg/info/{}.list", Self::DEB_PACKAGE))
                .is_ok_and(|list| list.lines().any(|l| std::path::Path::new(l) == exe))
        });
        let pacman_owned = std::fs::read_dir("/var/lib/pacman/local").is_ok_and(|dir| {
            dir.flatten().any(|e| e.file_name().to_str().is_some_and(|n| n.starts_with("teleflock")))
        });
        Self {
            appimage_bundle: bundle_type() == Some(BundleType::AppImage),
            deb_bundle: bundle_type() == Some(BundleType::Deb),
            appimage_env: std::env::var_os("APPIMAGE").is_some(),
            dpkg_owned,
            pacman_owned,
        }
    }
}

/// Where this platform's update for one release comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assets {
    /// tauri-plugin-updater platforms: `latest.json` names the package and carries its signature.
    Manifest { manifest_url: String },
    Android { apk_name: String, apk_url: String, sha256_url: String },
    /// Manual platforms (macOS): the package the user downloads and installs by hand.
    Download { url: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub tag: String,
    pub version: Version,
    pub assets: Assets,
}

/// `vX.Y.Z[-pre]` → version. Tags without the `v` prefix or with invalid semver are ignored.
pub fn parse_tag(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v')?).ok()
}

/// The update assets `release` carries for `target` (named after `version`), if complete.
pub fn assets_for(release: &Release, version: &Version, target: Target) -> Option<Assets> {
    let url = |name: &str| release.assets.iter().find(|a| a.name == name).map(|a| a.browser_download_url.clone());
    // latest.json names the package and carries its signature; require the package to exist too.
    let manifest = |package: String| {
        url(&package)?;
        Some(Assets::Manifest { manifest_url: url(MANIFEST)? })
    };
    match target {
        Target::Windows => manifest(format!("{PRODUCT}_{version}_x64-setup.exe")),
        Target::AppImage => manifest(format!("{PRODUCT}_{version}_amd64.AppImage")),
        Target::Deb => manifest(format!("{PRODUCT}_{version}_amd64.deb")),
        Target::MacOs => Some(Assets::Download { url: url(&format!("{PRODUCT}_{version}_universal.dmg"))? }),
        Target::Android => {
            let apk_name = format!("{PRODUCT}_{version}_universal.apk");
            let apk_url = url(&apk_name)?;
            let sha256_url = url(&format!("{apk_name}.sha256"))?;
            Some(Assets::Android { apk_name, apk_url, sha256_url })
        }
    }
}

/// Highest-versioned non-draft release (pre-releases included) with `target`'s update assets.
pub fn latest(releases: &[Release], target: Target) -> Option<Candidate> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let version = parse_tag(&r.tag_name)?;
            let assets = assets_for(r, &version, target)?;
            Some(Candidate { tag: r.tag_name.clone(), version, assets })
        })
        .max_by(|a, b| a.version.cmp(&b.version))
}

/// The release to update to: [`latest`] when it is newer than `current`.
pub fn newer(releases: &[Release], target: Target, current: &Version) -> Option<Candidate> {
    latest(releases, target).filter(|c| c.version > *current)
}

/// Parses a `sha256sum` line (`<64 hex>  <name>`) → lowercase hex digest.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn parse_sha256(text: &str) -> Option<String> {
    let hex = text.split_whitespace().next()?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| hex.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, assets: &[&str]) -> Release {
        Release {
            tag_name: tag.into(),
            draft,
            assets: assets
                .iter()
                .map(|n| Asset { name: (*n).into(), browser_download_url: format!("https://dl/{tag}/{n}") })
                .collect(),
        }
    }

    /// A release with every platform's assets, like `scripts/release.sh` + `macos.yml` publish.
    fn full(tag: &str) -> Release {
        let v = tag.trim_start_matches('v');
        let mut names = vec!["latest.json".to_owned()];
        for (package, sig) in [
            (format!("TeleFlock_{v}_x64-setup.exe"), true),
            (format!("TeleFlock_{v}_universal.apk"), false),
            (format!("TeleFlock_{v}_amd64.AppImage"), true),
            (format!("TeleFlock_{v}_amd64.deb"), true),
            (format!("TeleFlock_{v}_universal.dmg"), false),
            (format!("teleflock-bin-{v}-1-x86_64.pkg.tar.zst"), false),
        ] {
            if sig {
                names.push(format!("{package}.sig"));
            }
            names.push(format!("{package}.sha256"));
            names.push(package);
        }
        release(tag, false, &names.iter().map(String::as_str).collect::<Vec<_>>())
    }

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn tags() {
        assert_eq!(parse_tag("v1.2.3"), Some(v("1.2.3")));
        assert_eq!(parse_tag("v0.2.0-beta.1"), Some(v("0.2.0-beta.1")));
        assert_eq!(parse_tag("1.2.3"), None);
        assert_eq!(parse_tag("v1.2"), None);
        assert_eq!(parse_tag("nightly"), None);
    }

    #[test]
    fn semver_order_with_prereleases() {
        let rels = [full("v0.2.0-beta.2"), full("v0.2.0-beta.10"), full("v0.1.0"), full("v0.2.0-rc.1")];
        assert_eq!(latest(&rels, Target::Android).unwrap().tag, "v0.2.0-rc.1");
        let rels = [full("v0.2.0-rc.1"), full("v0.2.0"), full("v0.10.0-alpha.1"), full("v0.9.9")];
        assert_eq!(latest(&rels, Target::Windows).unwrap().tag, "v0.10.0-alpha.1");
        let rels = [full("v0.2.0-beta.2"), full("v0.2.0-beta.10")];
        assert_eq!(latest(&rels, Target::Windows).unwrap().tag, "v0.2.0-beta.10");
    }

    #[test]
    fn drafts_and_bad_tags_skipped() {
        let mut draft = full("v9.0.0");
        draft.draft = true;
        let rels = [draft, full("nightly"), full("v0.3.0")];
        assert_eq!(latest(&rels, Target::Windows).unwrap().tag, "v0.3.0");
    }

    #[test]
    fn platform_assets() {
        // v0.1.0 as published: installer + APK with checksums, no latest.json.
        let v010 = release(
            "v0.1.0",
            false,
            &[
                "TeleFlock_0.1.0_x64-setup.exe",
                "TeleFlock_0.1.0_x64-setup.exe.sha256",
                "TeleFlock_0.1.0_universal.apk",
                "TeleFlock_0.1.0_universal.apk.sha256",
            ],
        );
        assert_eq!(latest(std::slice::from_ref(&v010), Target::Windows), None);
        assert_eq!(
            latest(std::slice::from_ref(&v010), Target::Android).unwrap().assets,
            Assets::Android {
                apk_name: "TeleFlock_0.1.0_universal.apk".into(),
                apk_url: "https://dl/v0.1.0/TeleFlock_0.1.0_universal.apk".into(),
                sha256_url: "https://dl/v0.1.0/TeleFlock_0.1.0_universal.apk.sha256".into(),
            }
        );
        // APK without its checksum, or assets named for another version: not a candidate.
        let no_sum = release("v0.4.0", false, &["TeleFlock_0.4.0_universal.apk"]);
        let renamed = release("v0.5.0", false, &["TeleFlock_0.4.0_universal.apk", "TeleFlock_0.4.0_universal.apk.sha256"]);
        assert_eq!(latest(&[no_sum, renamed], Target::Android), None);
        // latest.json without the installer it should point at: not a candidate.
        let manifest_only = release("v0.6.0", false, &["latest.json"]);
        assert_eq!(latest(&[manifest_only], Target::Windows), None);
        // A newer Android-only release does not hide the older Windows one.
        let android_only = release("v0.7.0", false, &["TeleFlock_0.7.0_universal.apk", "TeleFlock_0.7.0_universal.apk.sha256"]);
        let rels = [android_only, full("v0.6.1")];
        assert_eq!(latest(&rels, Target::Windows).unwrap().tag, "v0.6.1");
        assert_eq!(latest(&rels, Target::Android).unwrap().tag, "v0.7.0");
        assert_eq!(
            latest(&rels, Target::Windows).unwrap().assets,
            Assets::Manifest { manifest_url: "https://dl/v0.6.1/latest.json".into() }
        );
    }

    #[test]
    fn linux_and_macos_assets() {
        let manifest = |tag: &str| Some(Assets::Manifest { manifest_url: format!("https://dl/{tag}/latest.json") });
        for target in [Target::AppImage, Target::Deb] {
            assert_eq!(latest(&[full("v0.2.0")], target).unwrap().assets, manifest("v0.2.0").unwrap());
        }
        // macOS: a manual download of the .dmg, never latest.json.
        assert_eq!(
            latest(&[full("v0.2.0")], Target::MacOs).unwrap().assets,
            Assets::Download { url: "https://dl/v0.2.0/TeleFlock_0.2.0_universal.dmg".into() }
        );
        // A Windows + Android-only release (v0.1.x style) is never offered to Linux or macOS.
        let older = release(
            "v0.3.0",
            false,
            &["TeleFlock_0.3.0_x64-setup.exe", "TeleFlock_0.3.0_universal.apk", "TeleFlock_0.3.0_universal.apk.sha256", "latest.json"],
        );
        for target in [Target::AppImage, Target::Deb, Target::MacOs] {
            assert_eq!(latest(std::slice::from_ref(&older), target), None);
        }
        // Each Linux format needs its own package next to latest.json.
        let appimage_only = release("v0.4.0", false, &["TeleFlock_0.4.0_amd64.AppImage", "latest.json"]);
        assert_eq!(assets_for(&appimage_only, &v("0.4.0"), Target::AppImage), manifest("v0.4.0"));
        assert_eq!(assets_for(&appimage_only, &v("0.4.0"), Target::Deb), None);
        let deb_only = release("v0.4.0", false, &["TeleFlock_0.4.0_amd64.deb", "latest.json"]);
        assert_eq!(assets_for(&deb_only, &v("0.4.0"), Target::Deb), manifest("v0.4.0"));
        assert_eq!(assets_for(&deb_only, &v("0.4.0"), Target::AppImage), None);
        // A package without latest.json is not a candidate for the updater platforms.
        let no_manifest = release("v0.4.1", false, &["TeleFlock_0.4.1_amd64.deb", "TeleFlock_0.4.1_amd64.AppImage"]);
        assert_eq!(latest(std::slice::from_ref(&no_manifest), Target::Deb), None);
        assert_eq!(latest(std::slice::from_ref(&no_manifest), Target::AppImage), None);
        // A release whose macOS build is still running (no .dmg yet) is not offered to macOS,
        // and an older one with its .dmg stays the macOS candidate meanwhile.
        let pending = release("v0.5.0", false, &["TeleFlock_0.5.0_amd64.deb", "latest.json"]);
        assert_eq!(latest(&[pending, full("v0.4.2")], Target::MacOs).unwrap().tag, "v0.4.2");
        // Pre-release package names carry the full semver.
        assert!(latest(&[full("v0.6.0-beta.1")], Target::Deb).is_some());
        assert!(latest(&[full("v0.6.0-beta.1")], Target::MacOs).is_some());
    }

    #[test]
    fn linux_install_kinds() {
        let appimage = LinuxInstall { appimage_bundle: true, appimage_env: true, ..Default::default() };
        assert_eq!(Target::linux(appimage), Ok(Target::AppImage));
        let deb = LinuxInstall { deb_bundle: true, dpkg_owned: true, ..Default::default() };
        assert_eq!(Target::linux(deb), Ok(Target::Deb));
        // The Arch package carries the .deb binary: pacman owns it, dpkg doesn't.
        let arch = LinuxInstall { deb_bundle: true, pacman_owned: true, ..Default::default() };
        assert_eq!(Target::linux(arch), Err(LINUX_PACMAN));
        // ...even on an Arch box that also has dpkg installed.
        assert_eq!(Target::linux(LinuxInstall { dpkg_owned: true, ..arch }), Err(LINUX_PACMAN));
        // The .deb's binary copied elsewhere, or the AppImage's binary run without its runtime
        // (e.g. extracted with --appimage-extract): nothing to update in place.
        assert_eq!(Target::linux(LinuxInstall { deb_bundle: true, ..Default::default() }), Err(LINUX_OTHER));
        assert_eq!(Target::linux(LinuxInstall { appimage_bundle: true, ..Default::default() }), Err(LINUX_OTHER));
        // A plain `cargo build` binary.
        assert_eq!(Target::linux(LinuxInstall::default()), Err(LINUX_OTHER));
    }

    #[test]
    fn newer_than_current() {
        let rels = [full("v0.2.0"), full("v0.2.1-beta.1")];
        assert_eq!(newer(&rels, Target::Windows, &v("0.1.0")).unwrap().tag, "v0.2.1-beta.1");
        assert_eq!(newer(&rels, Target::Windows, &v("0.2.1-beta.1")), None);
        assert_eq!(newer(&rels, Target::Windows, &v("0.2.1")), None);
        // A pre-release build moves on to its final release.
        assert_eq!(newer(&[full("v0.3.0")], Target::Android, &v("0.3.0-rc.2")).unwrap().tag, "v0.3.0");
        assert_eq!(newer(&[], Target::Android, &v("0.1.0")), None);
    }

    #[test]
    fn sha256_lines() {
        let hex = "C2A1b".to_owned() + &"0".repeat(59);
        assert_eq!(parse_sha256(&format!("{hex}  TeleFlock_0.1.0_universal.apk\n")), Some(hex.to_ascii_lowercase()));
        assert_eq!(parse_sha256("abc  file"), None);
        assert_eq!(parse_sha256(&format!("{}  f", "z".repeat(64))), None);
        assert_eq!(parse_sha256(""), None);
    }
}
