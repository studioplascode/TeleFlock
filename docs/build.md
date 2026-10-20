# Building TeleFlock (Linux host → Windows NSIS + Android APK)

Status as of 2026-10-20 on `aron-dev` (Debian 13 trixie, x86_64). Both targets were proven with a throwaway
Tauri 2 + React TS app at `.research/tauri-hello/`. Evidence tags: `[observed]` = run on this box,
`[source]` = docs/code (linked), `[inferred]` = not verified.

## 0. TL;DR from a fresh shell

The real app is built with three scripts (§10). Each builds the frontend, then `tf-hostd` for every
deploy target (embedded into the app), then the package, and copies it to `dist-release/`:

```bash
scripts/build-windows.sh     # -> dist-release/TeleFlock_<version>_x64-setup.exe
scripts/build-android.sh     # -> dist-release/TeleFlock_<version>_universal.apk (signed)
scripts/build-hostd.sh       # only tf-hostd -> target/hostd-dist/<triple>/tf-hostd[.exe]
```

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

On the hello app this finished in 34 s `[observed]`. The Linux deps from §3 are enough for `cargo check`/`cargo build` of the desktop crate on Linux, which other agents use for fast iteration. TeleFlock does not ship a Linux bundle.

## 8. CI drafts (`.github/workflows/`)

Both workflows assume this layout:
- `package.json` and `bun.lock` at the repo root, built with bun.
- `src-tauri/` at the repo root.
- Cargo workspace root at `/root/TeleFlock/Cargo.toml`, so `target/` is at the repo root (rust-cache `workspaces: '. -> target'`).

| Workflow | Runner | Produces | Notes |
|---|---|---|---|
| `windows.yml` | `windows-latest` | `target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe` → artifact `teleflock-windows-nsis` | `bun tauri build --target x86_64-pc-windows-msvc --bundles nsis`; native MSVC, no xwin. Authenticode signing is not wired up yet (`bundle.windows.signCommand`). |
| `android.yml` | `ubuntu-latest` | `src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk` → artifact `teleflock-android-apk` | Temurin 17, `sdkmanager` installs `ndk;29.0.14206865`, `platforms;android-37.0`, `build-tools;37.0.0`; runs `tauri android init --ci` only if `gen/android` is missing; signs via `TELEFLOCK_KEYSTORE_PROPERTIES` (Gradle) or falls back to zipalign + apksigner. |

Android secrets, from the local keystore:
- `ANDROID_KEY_BASE64`: `base64 -w0 /root/.teleflock-keys/teleflock-release.jks`
- `ANDROID_KEY_PASSWORD`: the `password=` value in `keystore.properties`
- `ANDROID_KEY_ALIAS`: `teleflock`

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
