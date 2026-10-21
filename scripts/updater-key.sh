# Sourced by the scripts that sign packages for the in-app updater (build-windows.sh,
# build-linux.sh, release.sh for macOS). The key never enters the build's environment: packages
# are built with bundle.createUpdaterArtifacts=false, then signed one by one with
# tf_updater_sign, which hands the key and password to that single `tauri signer sign` process.
#
# Key: TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD) if the caller already exported them, else the files
# TELEFLOCK_UPDATER_KEY (default /root/.teleflock-keys/updater.key) and
# TELEFLOCK_UPDATER_PASSWORD_FILE (default /root/.teleflock-keys/updater.password). docs/build.md §11.1.

TF_UPDATER_KEY="${TELEFLOCK_UPDATER_KEY:-/root/.teleflock-keys/updater.key}"
TF_UPDATER_PASSWORD_FILE="${TELEFLOCK_UPDATER_PASSWORD_FILE:-/root/.teleflock-keys/updater.password}"

# Fails (exit 1) when no signing key is available. Call it before a long build.
tf_updater_key_check() {
  [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && return 0
  if [ ! -f "$TF_UPDATER_KEY" ] || [ ! -f "$TF_UPDATER_PASSWORD_FILE" ]; then
    echo "updater signing key missing ($TF_UPDATER_KEY, $TF_UPDATER_PASSWORD_FILE)." >&2
    echo "Restore it from the backup or set TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD): docs/build.md §11.1" >&2
    exit 1
  fi
}

# tf_updater_sign FILE VERSION → FILE.sig (minisign, trusted comment carries `version:VERSION`,
# which plugins.updater.requireSignedVersion checks against latest.json).
tf_updater_sign() {
  local file="$1" version="$2"
  tf_updater_key_check
  rm -f "$file.sig"
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    bun tauri signer sign --app-version "$version" "$file" >/dev/null
  else
    TAURI_SIGNING_PRIVATE_KEY_PATH="$TF_UPDATER_KEY" \
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$TF_UPDATER_PASSWORD_FILE")" \
      bun tauri signer sign --app-version "$version" "$file" >/dev/null
  fi
  [ -s "$file.sig" ] || { echo "tauri signer wrote no $file.sig" >&2; exit 1; }
}
