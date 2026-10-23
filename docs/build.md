# Building TeleFlock (Linux host → Windows NSIS, Android APK, Linux .deb / AppImage / Arch; macOS in CI)

Status as of 2026-10-20 on `aron-dev` (Debian 13 trixie, x86_64). Both targets were proven with a throwaway
Tauri 2 + React TS app at `.research/tauri-hello/`. Evidence tags: `[observed]` = run on this box,
`[source]` = docs/code (linked), `[inferred]` = not verified.

## 0. TL;DR from a fresh shell

The real app is built with four scripts (§10). Each builds the frontend, then `tf-hostd` for every
deploy target (embedded into the app), then the packages, and copies them to `dist-release/`:

```bash
scripts/build-windows.sh     # -> dist-release/TeleFlock_<version>_x64-setup.exe (+ .sig for the updater)
scripts/build-android.sh     # -> dist-release/TeleFlock_<version>_universal.apk (signed)
scripts/build-linux.sh       # -> dist-release/TeleFlock_<version>_amd64.{deb,AppImage} (+ .sig) and
                             #    teleflock-bin-<pkgver>-1-x86_64.pkg.tar.zst (Arch), §12
scripts/build-hostd.sh       # only tf-hostd -> target/hostd-dist/<triple>/tf-hostd[.exe]
scripts/set-version.sh X.Y.Z && scripts/release.sh   # version bump → published GitHub release (§11)
```

macOS is built by `.github/workflows/macos.yml` on a GitHub macOS runner (§13); iOS is not built (§14).

The underlying commands (what the scripts run):

```bash
. /root/.teleflock-android-env                       # JAVA_HOME, ANDROID_HOME, NDK_HOME, PATH
export CARGO_TARGET_DIR=/root/TeleFlock/target/<YourAgentName>   # repo rule: private target dir per agent

# Windows NSIS installer (cross-compiled):
bun tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
#   -> $CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/nsis/<productName>_<version>_x64-setup.exe

# Android signed universal APK:
export TELEFLOCK_KEYSTORE_PROPERTIES=/root/.teleflock-keys/keystore.properties
bun tauri android build --apk
#   -> src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Run both from the directory that holds `package.json` (repo root for the real app). `[observed]`

## 1. Proof artifacts (hello app)

| Artifact | Path | Size | sha256 |
|---|---|---|---|
| NSIS installer | `/root/TeleFlock/target/Toolchain/x86_64-pc-windows-msvc/release/bundle/nsis/tauri-hello_0.1.0_x64-setup.exe` | 1,589,551 B (1.52 MiB) | `9e091fd2…a655cfb` |
| App exe (inside installer) | `/root/TeleFlock/target/Toolchain/x86_64-pc-windows-msvc/release/tauri-hello.exe` | 4,406,784 B | — |
| Signed APK (universal, 4 ABIs) | `/root/TeleFlock/.research/tauri-hello/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` | 18,707,050 B (17.8 MiB) | `f5f2a06e…7e238916d` |

Verification performed `[observed]`:
- `file` → installer: `PE32 executable … Nullsoft Installer self-extracting archive`; app: `PE32+ executable … (GUI), x86-64`.
- `7z l <setup.exe>` → payload contains `tauri-hello.exe` plus `$PLUGINSDIR/nsis_tauri_utils.dll`, `System.dll`, `nsDialogs.dll`, `StartMenu.dll`, `NSISdl.dll`.
- `llvm-objdump -p tauri-hello.exe` imports only system DLLs (kernel32, user32, ole32, combase, dwmapi, `api-ms-win-crt-*` UCRT, …). WebView2Loader is linked statically, so no extra DLL ships.
- `apksigner verify -v --print-certs` → `Verifies`, scheme v2 = true, signer `CN=TeleFlock, O=TeleFlock`, cert SHA-256 `0cf2f823fd49cb12bbcccd2341b31fd508ac1722ec6531ad9808f690d4097fd9`. v1 (JAR) is false, which is fine because minSdk is 24 and v2 covers API 24+.
- `aapt2 dump badging` → `package: name='dev.teleflock.hello' versionCode='1000' versionName='0.1.0' … compileSdkVersion='37'`, `minSdkVersion:'24'`, `targetSdkVersion:'37'`.
- APK contains `lib/{arm64-v8a,armeabi-v7a,x86,x86_64}/libtauri_hello_lib.so`.
- 16 KB page-size ready (Play requirement for targetSdk ≥ 35): `zipalign -c -P 16 -v 4` → `Verification successful`, and `llvm-readelf -lW` shows `LOAD` alignment `0x4000` for arm64-v8a and x86_64. NDK r29 does this by default.
- Not yet done: running the installer on real Windows and installing the APK on a device. No Windows host or device is attached to this box. **Smoke-test both on real hardware before relying on them.** Install the APK with `adb install -r <apk>`.

Build times on 15 cores `[observed]`: Windows cold build 2m02s, including a 23 s first-time MSVC CRT/SDK download. Android cold build for all 4 ABIs 5m18s, including the Gradle 9.6.1 download.

## 2. Installed toolchain (machine state)

| Component | Version | Location | How it was installed |
|---|---|---|---|
| Tauri Linux deps | libwebkit2gtk-4.1-dev 2.54.0, libayatana-appindicator3-dev 0.5.94, librsvg2-dev 2.60, libxdo-dev, libssl-dev, build-essential, patchelf 0.18, pkg-config, file, curl, wget | apt | `apt-get install` (§3) |
| LLVM toolchain | clang/lld/llvm 19 (`1:19.0-63`) | `/usr/bin/{clang,lld-link,llvm-rc,llvm-lib}`; `/usr/local/bin/clang-cl → /usr/lib/llvm-19/bin/clang-cl` | apt + manual symlink |
| NSIS | 3.11-1 (Debian package; includes Stubs and Plugins) | `/usr/bin/makensis` | apt |
| 7zip | (Debian) | `/usr/bin/7z` | apt (only used to inspect installers) |
| Rust | rustc 1.99.1 stable | `~/.rustup` | pre-existing |
| Rust targets | `x86_64-pc-windows-msvc aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` | rustup | `rustup target add` |
| cargo-xwin | 0.23.1 | `~/.cargo/bin/cargo-xwin`; MSVC CRT and Windows SDK cache at `~/.cache/cargo-xwin` (1.1 GB, includes its own `clang-cl` and `cmake` dirs) | `cargo install --locked cargo-xwin` |
| JDK | Temurin 17.0.20.1+1 | `/opt/jdk/jdk-17.0.20.1+1` | tarball (Debian 13 has **no** `openjdk-17` package, only 21) |
| Android cmdline-tools | 23.0 (build 16111833) | `/opt/android-sdk/cmdline-tools/latest` | zip |
| platform-tools | 37.0.1 | `/opt/android-sdk/platform-tools` | sdkmanager |
| SDK platforms | `android-36`, `android-37.0` | `/opt/android-sdk/platforms` | sdkmanager |
| build-tools | 36.0.0, 37.0.0 | `/opt/android-sdk/build-tools` | sdkmanager |
| NDK | r29 `29.0.14206865` | `/opt/android-sdk/ndk/29.0.14206865` | sdkmanager |
| Gradle / AGP | Gradle 9.6.1 (wrapper, auto-download) and AGP 9.3.1, as generated by tauri-cli 2.12.3 | `~/.gradle` | the first build downloads them |
| Bun / Node | bun 1.4.3, node 24 | — | pre-existing |
| Tauri (hello) | tauri-cli 2.12.3 (npm `@tauri-apps/cli`), tauri 2.12.4, tauri-build 2.7.3, wry 0.57.0, tao 0.37.1 | — | `create-tauri-app` 4.8.0 |

Why these versions:
- NDK r29 matches Tauri's own Android CI, `tauri-apps/tauri` `.github/workflows/test-android.yml` (`nttld/setup-ndk` `ndk-version: r29`; that job uses Java 25 Temurin). `[source]` https://github.com/tauri-apps/tauri/blob/dev/.github/workflows/test-android.yml
- The Tauri prerequisites page pins no specific NDK. `[source]` https://v2.tauri.app/start/prerequisites/
- JDK 17 is the minimum for AGP 8+ and Gradle 9. It worked for AGP 9.3.1 and Gradle 9.6.1. `[observed]`
- compileSdk/targetSdk 37 and minSdk 24 come from tauri-cli 2.12.3's template (`gen/android/app/build.gradle.kts`). AGP needs the matching `platforms;android-37.0`. Install it up front so Gradle doesn't try to auto-download it. `[observed]`

## 3. Reproducing the toolchain on a fresh Debian 13 box

```bash
# Linux Tauri deps + Windows cross tools  [observed]
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf pkg-config nsis lld llvm clang unzip 7zip
sudo ln -sf /usr/lib/llvm-19/bin/clang-cl /usr/local/bin/clang-cl   # Debian only ships clang-cl-19

rustup target add x86_64-pc-windows-msvc \
  aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cargo install --locked cargo-xwin

# JDK 17 (Temurin tarball; checksum from api.adoptium.net)  [observed]
curl -sSL -o /tmp/jdk17.tgz 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz'
echo "3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e  /tmp/jdk17.tgz" | sha256sum -c
sudo mkdir -p /opt/jdk && sudo tar -xzf /tmp/jdk17.tgz -C /opt/jdk

# Android cmdline-tools + SDK packages  [observed]
curl -sSL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
sudo mkdir -p /opt/android-sdk/cmdline-tools && unzip -q /tmp/clt.zip -d /tmp/clt \
  && sudo mv /tmp/clt/cmdline-tools /opt/android-sdk/cmdline-tools/latest
. /root/.teleflock-android-env        # file content in §4
yes | sdkmanager --licenses >/dev/null
sdkmanager --install "platform-tools" "platforms;android-36" "platforms;android-37.0" \
  "build-tools;36.0.0" "build-tools;37.0.0" "ndk;29.0.14206865"
```

`sdkmanager --list` (cmdline-tools 23) prints package paths with `/`, e.g. `ndk/29.0.14206865`, but `--install` takes the `;` form. `[observed]`

## 4. Environment

`/root/.teleflock-android-env` (sourceable, idempotent) `[observed]`:

```bash
export JAVA_HOME=/opt/jdk/jdk-17.0.20.1+1
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# NDK_HOME = highest installed NDK under $ANDROID_HOME/ndk
export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" | sort -V | tail -n1)"   # -> …/29.0.14206865
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

It is sourced from `/root/.bashrc` and `/root/.profile`, so new interactive and login shells pick it up. Non-interactive tool shells must source it explicitly: `. /root/.teleflock-android-env`.

Other variables:
- `CARGO_TARGET_DIR=/root/TeleFlock/target/<AgentName>`: repo rule. Tauri honours it for both bundling and the Android jniLibs symlinks (`jniLibs/<abi>/lib*.so → $CARGO_TARGET_DIR/<triple>/release/…`). `[observed]`
- `XWIN_CACHE_DIR` (optional, default `~/.cache/cargo-xwin`): cargo-xwin's MSVC CRT and Windows SDK cache. `[source]` https://v2.tauri.app/distribute/windows-installer/#install-cargo-xwin
- `TELEFLOCK_KEYSTORE_PROPERTIES=/root/.teleflock-keys/keystore.properties`: release signing (§6).

## 5. Windows: Linux → `x86_64-pc-windows-msvc` NSIS

This follows Tauri's documented route: https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos `[source]`

```bash
cd <app root>              # contains package.json; src-tauri/ below
bun install
CARGO_TARGET_DIR=/root/TeleFlock/target/<Agent> \
  bun tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

Output paths:
- `$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/nsis/<productName>_<version>_x64-setup.exe`
- `$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/<mainBinaryName>.exe`
- Without `CARGO_TARGET_DIR`, these land under the workspace `target/`. For the real app that is `/root/TeleFlock/target/`, because the Cargo workspace root is the repo root, not `src-tauri/target`.
- For the real app, `productName` is `TeleFlock` and `mainBinaryName` is `teleflock`, giving `TeleFlock_0.1.0_x64-setup.exe` `[inferred from src-tauri/tauri.conf.json]`.

Expected warnings, all harmless `[observed]`:
- `lld-link: Cannot use debug info for 'libcmt.lib(…)' [LNK4099]`: the MSVC CRT PDBs are missing.
- `Cross-platform compilation is experimental`.
- `Signing … only supported on Windows hosts … skipping signing`. For Authenticode, set `bundle.windows.signCommand`, e.g. with `osslsigncode`.
- `Wrong package type msi for platform Linux … ignoring msi`. MSI (WiX) can only be built on Windows. Pass `--bundles nsis` to avoid this.
- `warning 5202: -OUTPUTCHARSET is disabled for non Win32 platforms` (makensis).

Downloads during the first build: cargo-xwin fetches the MSVC CRT and Windows SDK (~1.1 GB cache, 23 s here), and the bundler downloads `nsis_tauri_utils.dll` v0.5.3 from GitHub. Builds need network the first time. `[observed]`

Gotchas:
- **C/C++ deps** (`ring`, `aws-lc-sys`, `libgit2`, …) compile through `clang-cl`. cargo-xwin brings its own copy under `~/.cache/cargo-xwin/clang-cl`, and the `/usr/local/bin/clang-cl` symlink covers crates that call it directly. Crates needing `nasm` (aws-lc-sys with `prebuilt-nasm` off) or `cmake`: cargo-xwin also provides a cmake toolchain in `~/.cache/cargo-xwin/cmake`. Ask the Toolchain owner before adding apt packages. `[inferred]`
- Only `x86_64` was proven. `aarch64-pc-windows-msvc` should work the same way after `rustup target add aarch64-pc-windows-msvc`. `[inferred]`
- The WebView2 runtime is not bundled. The default `webviewInstallMode` is `downloadBootstrapper`. Win10 and Win11 ship the Evergreen runtime. `[source]` same page, "WebView2 Installation Options".
- The native CI route (`windows-latest`, `.github/workflows/windows.yml`) is the primary release path. The cross-build is for fast local iteration and agent smoke builds.

## 6. Android

### 6.1 One-time project init

```bash
. /root/.teleflock-android-env
bun tauri android init            # generates src-tauri/gen/android (commit it; build outputs are gitignored)
```

Observed output: `Info Using installed NDK: /opt/android-sdk/ndk/29.0.14206865` … `Project generated successfully!`
The generated project uses compileSdk/targetSdk 37, minSdk 24, AGP 9.3.1, Gradle wrapper 9.6.1, and `androidx.webkit:webkit:1.14.0`. `[observed]`
`gen/android/.gitignore` already ignores `keystore.properties`, `key.properties`, `local.properties` and `build`. `[observed]`

### 6.2 Release signing (MUST be applied to the real app's `gen/android/app/build.gradle.kts`)

Keystore `[observed]`:
- Directory: `/root/.teleflock-keys/` (mode 700, files 600). It lives outside the repo and is **never committed**.
  - `teleflock-release.jks`: PKCS12, RSA 4096, alias `teleflock`, validity 10000 days, `CN=TeleFlock, O=TeleFlock`. Cert SHA-256 `0C:F2:F8:23:FD:49:CB:12:BB:CC:CD:23:41:B3:1F:D5:08:AC:17:22:EC:65:31:AD:98:08:F6:90:D4:09:7F:D9`.
  - `keystore.properties`: `password=<random 32 chars>`, `keyAlias=teleflock`, `storeFile=/root/.teleflock-keys/teleflock-release.jks`. A PKCS12 store uses the same password for store and key.
- How it was created:
  ```bash
  umask 077; mkdir -p /root/.teleflock-keys; cd /root/.teleflock-keys
  PW=$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)
  keytool -genkeypair -v -keystore teleflock-release.jks -storetype PKCS12 -keyalg RSA -keysize 4096 \
    -validity 10000 -alias teleflock -storepass "$PW" -keypass "$PW" -dname "CN=TeleFlock, O=TeleFlock"
  printf 'password=%s\nkeyAlias=teleflock\nstoreFile=/root/.teleflock-keys/teleflock-release.jks\n' "$PW" > keystore.properties
  ```
- **Back this keystore up.** Losing it means existing installs can never be updated in place, because Android rejects signature changes.

Gradle wiring. This is Tauri's documented approach (https://v2.tauri.app/distribute/sign/android/ `[source]`) with one change: the properties file can live outside the repo, through an env var. Tauri's original reads `keystore.properties` from `gen/android/`. Applied to `.research/tauri-hello/src-tauri/gen/android/app/build.gradle.kts` `[observed]`:

```kotlin
// after the tauriProperties block (java.util.Properties is already imported by the template)
val keystorePropertiesFile: File = System.getenv("TELEFLOCK_KEYSTORE_PROPERTIES")
    ?.let { file(it) }
    ?: rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

android {
    // ... defaultConfig { ... }
    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("password")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("password")
            }
        }
    }
    buildTypes {
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            // ... template's optimization/proguard lines unchanged
        }
    }
}
```

If the properties file is missing, the release build still succeeds but produces `app-universal-release-unsigned.apk`. Android will not install that file. `[inferred from AGP behaviour; the CI workflow falls back to apksigner]`

### 6.3 Build

```bash
. /root/.teleflock-android-env
export CARGO_TARGET_DIR=/root/TeleFlock/target/<Agent>
export TELEFLOCK_KEYSTORE_PROPERTIES=/root/.teleflock-keys/keystore.properties
bun tauri android build --apk                       # all 4 ABIs, universal APK
# faster single-ABI build for phones:  bun tauri android build --apk --target aarch64
# AAB for Play:                        bun tauri android build --aab
```

Output paths:
- APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` `[observed]`
- With `--split-per-abi`, the output goes to `…/apk/<abi>/release/` `[inferred]`.

Verify:

```bash
BT=$ANDROID_HOME/build-tools/37.0.0
$BT/apksigner verify -v --print-certs <apk>
$BT/aapt2 dump badging <apk> | head -4
$BT/zipalign -c -P 16 -v 4 <apk> | tail -1      # 16 KB page alignment
adb install -r <apk>                             # on a device / emulator
```

Expected noise `[observed]`: AGP 9 prints deprecation warnings for template-set options (`android.proguard.failOnMissingFiles`, `android.builtInKotlin=false`, `android.newDsl=false`, `applicationVariants`). They are harmless until AGP 10.

Gotchas:
- `versionCode` comes from `tauri.conf.json` `version` (0.1.0 → 1000). Override it with `bundle.android.versionCode`. `[observed]`
- The real app sets `bundle.android.debugApplicationIdSuffix: ".debug"`, so debug and release builds install side by side. `[source: src-tauri/tauri.conf.json]`
- A nested crate under a directory with a parent Cargo workspace (e.g. `.research/*` under `/root/TeleFlock/Cargo.toml`) must declare an empty `[workspace]` table, or cargo errors with "believes it's in a workspace". The hello app does this. `[observed]`
- Running `tauri android dev` against a device needs the device reachable over adb and the dev server reachable from the device (`TAURI_DEV_HOST`). Not exercised here.

## 7. Linux host checks

```bash
cd src-tauri && CARGO_TARGET_DIR=/root/TeleFlock/target/<Agent> cargo check
```

On the hello app this finished in 34 s `[observed]`. The Linux deps from §3 are enough for `cargo check`/`cargo build` of the desktop crate on Linux, which other agents use for fast iteration. Linux release packages are built in a container instead (§12).

For the real app: `CARGO_TARGET_DIR=target/<Agent> cargo check -p teleflock` and `cargo test -p teleflock` (unit tests + the core bridge against the real engine). Windows-only code: `cargo xwin check -p teleflock --target x86_64-pc-windows-msvc`. `[observed]`

`Cargo.lock` pins `rust-ini` to **0.21.1**: 0.21.3 added fields to `ParseOption` that `tauri-plugin-deep-link` 2.6.2 does not set, which breaks its Linux build (`E0063`). Do not `cargo update` it past 0.21.1 until deep-link is fixed upstream. `[observed]`

## 8. CI drafts (`.github/workflows/`)

All workflows assume this layout:
- `package.json` and `bun.lock` at the repo root, built with bun.
- `src-tauri/` at the repo root.
- Cargo workspace root at `/root/TeleFlock/Cargo.toml`, so `target/` is at the repo root (rust-cache `workspaces: '. -> target'`).

| Workflow | Runner | Produces | Notes |
|---|---|---|---|
| `hostd.yml` (reusable, also manual) | `ubuntu-latest` | artifact `tf-hostd-dist` = `target/hostd-dist/<triple>/tf-hostd[.exe]` | runs `scripts/build-hostd.sh` (installs zig, cargo-zigbuild, cargo-xwin). Every app workflow `needs:` it and downloads it to `target/hostd-dist` with `TF_HOSTD_DIST` set, so the app embeds the daemon. |
| `windows.yml` | `windows-latest` | `target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe` → artifact `teleflock-windows-nsis` | `bun tauri build --target x86_64-pc-windows-msvc --bundles nsis` with `bundle.createUpdaterArtifacts: false`; native MSVC, no xwin. Never gets the updater key, so the artifact has no `.sig` and can't be published as an update. Authenticode signing is not wired up yet (`bundle.windows.signCommand`). |
| `android.yml` | `ubuntu-latest` | `src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk` → artifact `teleflock-android-apk` | Temurin 17, `sdkmanager` installs `ndk;29.0.14206865`, `platforms;android-37.0`, `build-tools;37.0.0`; uses the committed `gen/android` (runs `tauri android init --ci` only if missing); signs via `TELEFLOCK_KEYSTORE_PROPERTIES` (Gradle) or falls back to zipalign + apksigner. |
| `linux.yml` | `ubuntu-22.04` | `target/release/bundle/{deb,appimage}/*` → artifact `teleflock-linux` | Same environment as the release container (§12): Tauri's apt deps, `bun tauri build --bundles deb,appimage` with `createUpdaterArtifacts: false` (`NO_STRIP=true`); prints `dpkg-deb --info/--contents`, the desktop entry and the glibc floor. No secrets, `permissions: contents: read`, third-party actions pinned by commit SHA. The Arch package is only built by `scripts/build-linux.sh`. |
| `macos.yml` | `macos-latest` (build), `ubuntu-latest` (upload) | `TeleFlock_<v>_universal.dmg` + `.sha256` → artifact `teleflock-macos`; for a `v*` tag also attached to that tag's release | Runs on `v*` tag pushes and by hand. `build` (read-only token, actions pinned by SHA): `tf-hostd` for `aarch64-` and `x86_64-apple-darwin` (embedded for Local mode on the Mac), `bun tauri build --target universal-apple-darwin --bundles app,dmg` with `createUpdaterArtifacts: false`, checks the tag = app version, `lipo -archs`, `codesign --verify` (ad-hoc) and `CFBundleURLTypes`. `upload` (only for tags; `contents: write`; no checkout, only `actions/download-artifact` + the runner's `gh`): waits up to 60 min for the release, then `gh release upload` without `--clobber`, so existing assets are never replaced (§13). |

Android secrets, from the local keystore:
- `ANDROID_KEY_BASE64`: `base64 -w0 /root/.teleflock-keys/teleflock-release.jks`
- `ANDROID_KEY_PASSWORD`: the `password=` value in `keystore.properties`
- `ANDROID_KEY_ALIAS`: `teleflock`

CI never gets the updater key (§11.1): PR and branch builds would otherwise be able to sign
packages every installed app accepts. Releases are built and signed on this box with
`scripts/release.sh` (§11). The macOS `.dmg` is the only release asset built in CI, and it is
never signed with the updater key: macOS installs are updated by hand (§13).

The workflows have not been run on GitHub yet. Validate them on the first push. `[inferred]`

## 9. Throwaway proof app

The proof app is `.research/tauri-hello/`, scaffolded with:

```bash
bunx create-tauri-app@latest tauri-hello -m bun -t react-ts --identifier dev.teleflock.hello --tauri-version 2 -y
```

Changes after scaffolding:
- An empty `[workspace]` table in `src-tauri/Cargo.toml`.
- The signing block in `gen/android/app/build.gradle.kts`.

It is safe to delete. Its build outputs live under `/root/TeleFlock/target/Toolchain/` and `gen/android/app/build/`.

## 10. The real app (`src-tauri/`, scripts)

### 10.1 Pipeline

| Script | Steps | Output |
|---|---|---|
| `scripts/build-hostd.sh [triple…]` | installs zig 0.15.2 (`/opt/zig`, sha256-checked), `cargo-zigbuild`, `cargo-xwin` and rustup targets if missing; builds `tf-hostd` for `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` (zigbuild, checked static) and `x86_64-pc-windows-msvc` (xwin). Build dir `target/hostd-build`. | `target/hostd-dist/<triple>/tf-hostd[.exe]` |
| `scripts/build-windows.sh` | checks the updater signing key (§11.1) → `bun run build` → `build-hostd.sh` → `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis` with `createUpdaterArtifacts: false` (frontend not rebuilt by tauri) → `tf_updater_sign` signs the installer | `dist-release/TeleFlock_<ver>_x64-setup.exe` + `.sig` + `.sha256` |
| `scripts/build-android.sh [tauri args]` | `bun run build` → `build-hostd.sh` → `tauri android build --apk` → `apksigner verify` + `zipalign -c -P 16` | `dist-release/TeleFlock_<ver>_universal.apk` + `.sha256` |
| `scripts/build-linux.sh` | checks docker + the updater key → `bun run build` → `build-hostd.sh` → `tauri build --bundles deb,appimage` with `createUpdaterArtifacts: false` inside the Ubuntu 22.04 builder container (`packaging/linux/Dockerfile`; no key inside) → `tf_updater_sign` on the host for both packages → Arch package from `packaging/arch/PKGBUILD` via `makepkg` in `archlinux:base-devel`, installed with `pacman -U` in a fresh container + `ldd` + `namcap` (§12) | `dist-release/TeleFlock_<ver>_amd64.{deb,AppImage}` + `.sig` + `.sha256`, `teleflock-bin-<pkgver>-1-x86_64.pkg.tar.zst` + `.sha256`, `dist-release/aur/{PKGBUILD,.SRCINFO}` |

Common env: `CARGO_TARGET_DIR` (defaults `target/release-windows`, `target/release-android`, `target/release-linux`), `SKIP_FRONTEND=1`, `SKIP_HOSTD=1`, `TF_HOSTD_DIST`. tf-client's `build.rs` embeds whatever is in `TF_HOSTD_DIST` (default `target/hostd-dist`), so build hostd **before** the app. `dist-release/` is a build output (not committed). Updater signing goes through `scripts/updater-key.sh` (sourced by the Windows and Linux scripts; the key only reaches `tauri signer sign`, §11.1).

Toolchain added for this (on top of §2) `[observed]`: zig 0.15.2 at `/opt/zig/zig-x86_64-linux-0.15.2`, `cargo-zigbuild` 0.23.4, rustup targets `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`.

### 10.2 What is in `src-tauri`

- Commands `core_call`, `core_term_input`, `core_events` (API in `src-tauri/README.md`); the app embeds `tf_client::Engine` and implements its `Platform`.
- Plugins: single-instance (desktop, first), deep-link (`teleflock://`, desktop + Android), snap-layout (desktop; Win11 overlay on `#tf-max`), updater (desktop; installs on Windows and Linux AppImage/.deb; macOS only gets a download link, §11), log, and the Kotlin plugin `src-tauri/plugins/teleflock-android` (crate `tauri-plugin-teleflock-android`, `links` = name, Kotlin package `dev.teleflock.android`).
- `tauri.conf.json`: `minWidth 420` (Snap Layouts needs ≤ 500), `transparent: true` + `backgroundColor #0b0b1000` (window can take Mica at runtime via `setEffects`; the page paints its own opaque background), NSIS `currentUser` + `installerHooks` (`src-tauri/windows/installer-hooks.nsh` removes the toast AUMID key on uninstall).
- Platform overrides (merged over `tauri.conf.json` by the CLI; `app.windows` is replaced whole, so each repeats the window): `tauri.linux.conf.json` (opaque undecorated window: no Mica on Linux and WebKitGTK transparency needs a compositor; `.deb` section, `libayatana-appindicator3-1` dependency for the tray, desktop entry `linux/teleflock.desktop` with `Exec=teleflock %u` so `teleflock://` links reach the app), `tauri.macos.conf.json` (native traffic lights over the custom title bar: `decorations: true`, `titleBarStyle: Overlay`, `hiddenTitle`, `trafficLightPosition {14, 20}`; `TitleBar.tsx` hides its Windows-style buttons and pads 80 px on macOS; ad-hoc `signingIdentity: "-"`, `minimumSystemVersion 11.0`).
- `gen/android` is generated by `tauri android init --ci` and committed with three edits: the signing block (§6.2), a dark brand theme (no white flash), `windowSoftInputMode="adjustResize"`. The deep-link plugin's build script adds the `teleflock` intent filter to the manifest on every build.
- Icons: `bun tauri icon src/assets/logo/icon-manifest.json` regenerates `src-tauri/icons/` and writes the adaptive Android launcher icons (`mipmap-*/ic_launcher*.png`, `mipmap-anydpi-v26/ic_launcher.xml`) straight into `gen/android/app/src/main/res`. Re-run it after any fresh `tauri android init`: the template ships Tauri's default icon. Drop the `icons/ios/` it also emits (no iOS target, §14).

### 10.3 Artifacts built from the tree (2026-10-20) `[observed]`

| Artifact | Size | Verification |
|---|---|---|
| `dist-release/TeleFlock_0.1.0_x64-setup.exe` | 15,241,728 B (sha256 `804c4296…16a03e25`) | `file`: Nullsoft installer; payload `teleflock.exe` (PE32+ GUI x86-64, 29.7 MB incl. 3 zstd-embedded tf-hostd); installer.nsi includes the hooks and writes `Software\Classes\teleflock` (URL Protocol) |
| `dist-release/TeleFlock_0.1.0_universal.apk` | 80,812,194 B (sha256 `44a79db3…3d397823`) | `apksigner`: V2 signer `CN=TeleFlock, O=TeleFlock`, cert SHA-256 `0cf2f823…097fd9`; `zipalign -c -P 16` OK; merged manifest has `KeepAliveService` (`foregroundServiceType=0x200` remoteMessaging), `ActionReceiver`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE_REMOTE_MESSAGING`, the `teleflock` scheme; `libteleflock_lib.so` exports `Java_dev_teleflock_android_RustBridge_onNotificationAction` / `…_onNetworkChanged` |

APK size: the four `libteleflock_lib.so` (15.8–22.4 MB, stored uncompressed for 16 KB alignment) each embed the two Linux tf-hostd builds, zstd-compressed (≈ 3 MB each; tf-client skips the Windows one on Android). Before that compression the APK was 162 MB.

Build times on 15 cores: Windows app + NSIS 7m03s cold, 3m10s warm (incl. frontend + hostd); Android 4 ABIs 7m07s–7m50s; `build-hostd.sh` from cold 6m28s.

### 10.4 Not verifiable here (no Windows box, no Android device)

Windows: tray icon animation/badge rendering, toast buttons + inline reply activation, Snap Layouts flyout on `#tf-max`, Mica, protocol activation via the installer's registration, single-instance forwarding. Android: foreground service lifetime in Doze, notification actions/RemoteInput reaching Rust with the Activity destroyed, `POST_NOTIFICATIONS` prompt, haptics, deep link from a notification tap, `ACCESS_LOCAL_NETWORK` on API 37 (platform.md §5).

## 11. Releases and self-update

Installed apps update themselves from the GitHub releases of `studioplascode/TeleFlock` (public;
the API is read anonymously). Design and IPC: `src-tauri/README.md` ("Self-update") and
`src-tauri/src/update/`.

What a release must contain (exactly what `scripts/release.sh` uploads; the `.dmg` comes from
`macos.yml`, §13):

| Asset | Used by |
|---|---|
| `TeleFlock_<ver>_x64-setup.exe` | Windows: downloaded by tauri-plugin-updater (URL from `latest.json`), run passively (`/P /UPDATE /R`), relaunches the app |
| `TeleFlock_<ver>_x64-setup.exe.sig` | minisign signature (updater key); its content is `latest.json`'s `signature` |
| `TeleFlock_<ver>_universal.apk` | Android: downloaded to the app cache, installed through the system installer |
| `TeleFlock_<ver>_universal.apk.sha256` | Android: the APK must match it before install |
| `TeleFlock_<ver>_amd64.AppImage` (+ `.sig`) | Linux AppImage: replaced in place by tauri-plugin-updater, then the app restarts |
| `TeleFlock_<ver>_amd64.deb` (+ `.sig`) | Debian/Ubuntu: installed by tauri-plugin-updater with `pkexec dpkg -i` (password prompt), then the app restarts |
| `teleflock-bin-<pkgver>-1-x86_64.pkg.tar.zst` | Arch: manual `pacman -U`, or the AUR package built from `dist-release/aur/PKGBUILD`; never self-updated |
| `TeleFlock_<ver>_universal.dmg` | macOS: manual install. Uploaded by `macos.yml`; installed apps find it and offer **Download** (`UpdateStatus.manual`), which opens it in the browser |
| `*.sha256` | every package: manual downloads (`sha256sum -c`) |
| `latest.json` | Tauri static manifest `{version, notes, pub_date, platforms}` with `windows-x86_64`, `linux-x86_64-appimage` and `linux-x86_64-deb` (no macOS entry). The plugin looks up `<os>-<arch>-<installer>` first, then `<os>-<arch>` |

An app picks the highest `vX.Y.Z[-pre]` tag among non-draft releases (pre-releases included) that
carries its platform's assets, and updates when that is newer than its own version. A release
without `latest.json` (v0.1.0) is never offered to Windows or Linux; one without the APK +
`.sha256` never to Android; one without the `.dmg` (yet) never to macOS. Debug builds never
update themselves. macOS never installs anything by itself: the `.dmg` is built in CI, which has
no updater key, and is never signed with it (§13).

When apps look: a running app checks about 8 s after launch, then about hourly (1 h + up to
10 min jitter) and when it comes back to the front if its last check is 20 min old, so a
published release reaches running apps within roughly an hour (sooner when the user brings the
app up). Failures back off (30 min doubling to 12 h). That is at most ~3 anonymous API requests
per hour and device, far below GitHub's 60 per hour and IP.

Checks before an update installs:
- Windows / Linux: `latest.json` must announce exactly the release tag's version, the
  package must carry a valid minisign signature from the key in `plugins.updater.pubkey`, and
  `plugins.updater.requireSignedVersion: true` requires the signature's trusted comment to name
  that same version (`version:<ver>`). An older signed package republished under a newer tag is
  rejected. Downloads time out after 60 s without data (15 s to connect).
- Android: the APK must match the release's `.sha256`, and the Kotlin plugin checks the archive
  with `PackageManager.getPackageArchiveInfo`: same package name, the same set of signing
  certificate SHA-256 digests as the installed app, and a higher `versionCode`. Otherwise the
  file is deleted and the update ends in `error`. Android enforces the signing key again at install.
- Automatic checks run only when `settings.autoUpdate` can be read and is on.

Which Linux copies update themselves (`Target::current` in `src-tauri/src/update/release.rs`,
unit-tested): an AppImage started by its runtime (`$APPIMAGE`), and the `.deb`'s binary when
dpkg lists it (`/var/lib/dpkg/info/tele-flock.list`). The Arch package carries that same binary
but pacman owns it, so it reports "Installed with pacman: update TeleFlock with your package
manager" in Settings → Updates (`UpdateStatus.unsupportedReason`) instead of running dpkg; so does
any other copy (e.g. an extracted AppImage).

### 11.1 Updater signing key (Windows, Linux)

- `/root/.teleflock-keys/` (mode 700, files 600, **never committed**, back it up with the keystore):
  - `updater.key`: minisign private key (tauri format, password-protected), created 2026-10-21 with
    `bun tauri signer generate --ci -p "$PW" -w /root/.teleflock-keys/updater.key`
    (`PW` = 32 random chars, as for the keystore in §6.2).
  - `updater.password`: that password (no trailing newline).
  - `updater.key.pub`: public key, key id `82D0BE3E1E2C482A`. Its content is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
- `scripts/updater-key.sh` (sourced by `build-windows.sh` and `build-linux.sh`)
  keeps the key out of the build environment. Packages are built with
  `bundle.createUpdaterArtifacts: false`. `tf_updater_key_check` stops before the build when no
  key is available, and `tf_updater_sign FILE VERSION` writes `FILE.sig` with
  `tauri signer sign --app-version VERSION`. It passes the key path and password only to that one
  process. Override the paths with `TELEFLOCK_UPDATER_KEY` / `TELEFLOCK_UPDATER_PASSWORD_FILE`, or
  export `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) yourself. `--app-version` puts
  `version:<ver>` in the signature's trusted comment, which `requireSignedVersion` requires.
- **Losing the key strands Windows and Linux installs**: they only accept packages signed by
  the key in their own `tauri.conf.json`. A new key means shipping its public key in a release that
  users install by hand once. Android does not use this key; it relies on the APK signing key
  (§6.2), which Android enforces on every update.

### 11.2 Publishing

```bash
scripts/set-version.sh 0.2.0      # tauri.conf.json, Cargo.toml (+ Cargo.lock), package.json, site footer
git commit -am "Release v0.2.0" && git push
scripts/release.sh                # build Windows + Android + Linux, verify, write latest.json, gh release create v0.2.0
# the v0.2.0 tag starts .github/workflows/macos.yml, which attaches the .dmg; check it went green:
gh run list --workflow macos.yml --limit 1
```

`scripts/release.sh` options: `--skip-build` (reuse `dist-release/`), `--skip-windows` /
`--skip-android` / `--skip-linux` (reuse those, build the rest), `--notes-file FILE` (default:
GitHub's generated notes; the file's text also goes into `latest.json`), `--prerelease`, `--draft`,
`--dry-run` (build + verify + `latest.json`, print the `gh` command). Releases are normal (not
pre-releases) by default. The repo slug is `REPO` in the script and in
`src-tauri/src/update/release.rs`.

What it enforces before publishing:
- Caller exports `SKIP_FRONTEND` / `SKIP_HOSTD` / `SKIP_ARCH` are dropped: a release always builds
  the frontend and `tf-hostd` itself and always includes the Arch package.
- The three version files agree; the tree has no changes, untracked files included
  (`git status --porcelain`); `HEAD` is pushed; the release does not exist yet; a `v<ver>` tag
  already on origin must point at `HEAD` (annotated tags peeled), then it is reused
  (`--verify-tag`), else `gh` tags `HEAD`.
- Reused packages (`--skip-*`) must come from this commit: every build the script runs writes
  `dist-release/.built-<windows|android|linux>` with the `HEAD` SHA (`<sha>-dirty` when the tree had
  changes), and a release needs all three to equal `HEAD`. `--dry-run` only warns, so packages
  built by the `build-*.sh` scripts directly (no stamp) can be dry-run but not published.
- Checksums match; every `.sig` (installer, AppImage, `.deb`) verifies against its package with
  the public key in `tauri.conf.json` and is bound to `<ver>` (`scripts/verify-updater-sig.ts`:
  minisign Ed25519 over the BLAKE2b-512 prehash, the trusted comment's global signature, and its
  `version:` field, as the plugin checks them); the APK verifies with `apksigner` and has exactly
  one signer, the release certificate `0cf2f823…097fd9` pinned as `APK_CERT_SHA256` (§6.2).

macOS: the `v<ver>` tag (created by `gh release create` or pushed beforehand) starts `macos.yml`;
its upload job waits for the release and attaches `TeleFlock_<ver>_universal.dmg` + `.sha256`
without replacing existing assets. A release created with `--draft` gets its tag when it is
published. If the run failed or never started, re-run it on the tag:
`gh workflow run macos.yml --ref v<ver>` (a run on a tag ref uploads; on a branch it only builds).

AUR (optional, after publishing): push `dist-release/aur/PKGBUILD` and `.SRCINFO` to the
`teleflock-bin` AUR repo. They download the release's `.deb` and `LICENSE` with checksums.

Android `versionCode` follows the version (`major·1000000 + minor·1000 + patch`), so every bump
installs over the previous APK.

## 12. Linux (.deb, AppImage, Arch)

`scripts/build-linux.sh` (§10.1). The app is built in an Ubuntu 22.04 container
(`packaging/linux/Dockerfile`, image `teleflock-linux-builder:rust-<v>-bun-<v>`, same Rust and Bun
as the host): a build on Debian 13 needed `GLIBC_2.39` and would not start on Ubuntu 24.04 or
Debian 12. `target/release-linux` is only ever used by that container. Packages: `.deb` (package
name `tele-flock`, depends `libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1`), AppImage
(bundles WebKitGTK; `NO_STRIP=true` because linuxdeploy's strip fails on `.relr.dyn`), and the Arch
package from `packaging/arch/PKGBUILD` (`teleflock-bin`, repackages the `.deb`, so it is also a
valid AUR `-bin` PKGBUILD; dependencies are namcap-clean except `libayatana-appindicator`, which the
tray `dlopen`s).

Observed on this box, 2026-10-21 `[observed]`, version 0.1.0:

| Artifact | Size | Verification |
|---|---|---|
| `TeleFlock_0.1.0_amd64.deb` | ≈ 20.1 MB | `dpkg-deb --info/--contents`; desktop entry `MimeType=x-scheme-handler/teleflock;`, `Exec=teleflock %u`; binary needs `GLIBC_2.34` at most |
| `TeleFlock_0.1.0_amd64.AppImage` | ≈ 98.0 MB | built with the same binary |
| `teleflock-bin-0.1.0-1-x86_64.pkg.tar.zst` | ≈ 19.6 MB | `pacman -U` in a clean `archlinux:base-devel`, `ldd` resolves everything, namcap only flags the dlopen'ed appindicator |

Container build: cargo 4m33s cold, ≈ 5 min warm for the whole script incl. Arch.

Smoke runs (Xvfb + private D-Bus session, `[observed]`):
- `.deb` binary extracted on Debian 13: main window 1440×900 renders the onboarding UI with the
  custom title bar (screenshot), webview subscribes to the core, tray icon created, `WM_CLASS`
  `teleflock` (matches `StartupWMClass`), a second instance with `teleflock://open` hands over to
  the first and exits 0 (single-instance over D-Bus). Updater: "This copy can't update itself"
  (not dpkg-installed), as designed.
- `.deb` installed with `apt install ./…deb` in a clean `ubuntu:22.04` container: all
  dependencies resolve, the app starts and renders, and the updater detects the dpkg install and
  checks GitHub (`update: 0.1.0 is up to date`).

Linux behaviour: same undecorated window and custom title bar as Windows (opaque, no Mica); tray
via libayatana-appindicator (static icon, no comet animation); no OS notifications (inbox + tray
badge; Settings explains it and hides the test button); deep links via the desktop entry (`.deb`,
Arch) or self-registration (AppImage). Not exercised: a real desktop session (GNOME/KDE tray
rendering, `pkexec` update prompt, AppImage self-replacement), aarch64 Linux (not built).

## 13. macOS (CI only, unsigned)

No Mac here and no Apple Developer Program: `.github/workflows/macos.yml` builds a universal
(`aarch64` + `x86_64`) app on GitHub's free macOS runners, ad-hoc signed (`signingIdentity: "-"`),
not notarized, packed as `TeleFlock_<ver>_universal.dmg` and attached to the release of the
pushed `v*` tag. It embeds macOS `tf-hostd` builds (Local mode on the Mac). `tauri.macos.conf.json`
keeps the native traffic lights (`titleBarStyle: Overlay`); the Dock icon reopens the hidden
window; links open with `open`; no OS notifications (as on Linux).

First launch (Gatekeeper rejects un-notarized apps downloaded from the internet): drag
TeleFlock to Applications, open it once, then System Settings → Privacy & Security → **Open
Anyway** (macOS 15+; on older versions right-click → Open), or run
`xattr -dr com.apple.quarantine /Applications/TeleFlock.app`.

Updates are manual by design: CI never holds the updater key and CI-built packages are never
signed with it, so `latest.json` has no macOS entry. The app finds the new `.dmg` in the release
and offers **Download** (`UpdateStatus.manual`, §11). Not exercised yet: the workflow itself
(first tag push), and the app on real macOS hardware.

## 14. iOS: not built

Skipped on purpose, because no free path meets "installable without paid services, with the app's
core intact":
- **Signing.** iOS installs only signed apps. Without the paid Apple Developer Program, the only
  route is a free "Personal Team" signature made in Xcode on the user's own Mac (or by AltStore /
  SideStore with the user's Apple ID). It expires after 7 days, is limited to 3 apps per device,
  and cannot be produced in CI or published as a download: every user would have to build and
  re-sign it themselves every week.
- **Core features.** TeleFlock keeps a live SSH connection to its hosts and raises notifications
  from it (on Android: a foreground service plus a Kotlin notification plugin). iOS suspends
  backgrounded apps after seconds and offers no equivalent of the foreground service. Background
  alerts would need APNs push, which needs the paid program and a push server. The native
  plugin (notifications with actions, haptics, `open_url`, device name) would also need a Swift
  port. A free iOS build would therefore be a foreground-only viewer with notifications stubbed out.
