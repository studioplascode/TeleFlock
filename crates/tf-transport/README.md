# tf-transport

The app-side transports (architecture §5.1). There is one `Transport` per host connection:

- **SSH**: a single russh connection that multiplexes exec, spawn and `direct-tcpip` channels. Signs in with Tailscale SSH (`none`, the default) or, as the advanced setup, a private key or password (`HostProfile::auth`).
- **Local**: `tokio::process` with no shell.
- **WSL**: `wsl.exe` through the local process layer.

The owner is AppTransport. tf-client (AppCore) consumes it.

## API

```rust
use tf_transport::*;

#[async_trait] pub trait Transport: Send + Sync {
    async fn exec(&self, cmd: &Cmd) -> Result<Output, TransportError>;      // run to completion
    async fn spawn(&self, cmd: &Cmd) -> Result<Child, TransportError>;      // long-lived stdio
    async fn forward_tcp(&self, host: &str, port: u16) -> Result<BoxedStream, TransportError>;
    fn kind(&self) -> HostKind;
    async fn close(&self);
}

pub async fn connect(profile: &HostProfile, opts: &ConnectOptions, events: mpsc::Sender<TransportEvent>)
    -> Result<Arc<dyn Transport>, TransportError>;
pub async fn list_distros() -> Result<Vec<WslDistro>, TransportError>;   // `wsl.exe -l -v` + `-l --running -q`, concurrently
pub struct WslKeepalive;   // WslKeepalive::start(distro) -> Result<_, TransportError>; is_running(&mut self); drop = kill

pub struct Cmd { pub argv: Vec<String>, pub env: Vec<(String, String)>, pub cwd: Option<String>,
                 pub stdin: Option<Vec<u8>>, pub timeout: Option<Duration> }
// Cmd::new(argv).env(k, v).cwd(dir).stdin(bytes).timeout(d)
pub struct Output { pub status: ExitStatus, pub stdout: Vec<u8>, pub stderr: Vec<u8> }  // + stdout_str()/stderr_str()
pub struct ExitStatus { pub code: Option<i32>, pub signal: Option<String> }           // + success()
pub struct Child { pub stdin: Option<BoxedWrite>, pub stdout: Option<BoxedRead>, pub stderr: Option<BoxedRead>, .. }
// child.wait().await -> Result<ExitStatus, TransportError> (repeatable, cancel-safe in select!); child.kill().await (cancel-safe)
pub type BoxedRead = Box<dyn AsyncRead + Send + Unpin>;
pub type BoxedWrite = Box<dyn AsyncWrite + Send + Unpin>;
pub type BoxedStream = Box<dyn AsyncStream>;   // AsyncRead + AsyncWrite + Send + Unpin

pub enum TransportEvent { Phase(ConnPhase, Option<String>), AuthUrl(String), Latency(u32), Closed(Option<String>) }
pub struct ConnectOptions { pub known_hosts: PathBuf, pub host_key_policy: HostKeyPolicy /* tailnet_only() */,
                            pub auth_timeout: Duration /* 31 min */,
                            pub ping_interval: Duration /* 15 s */, pub ping_timeout, pub ping_max_misses /* 3 */,
                            pub resolve_timeout, pub connect_timeout, pub handshake_timeout, pub wsl_start_timeout,
                            pub secrets: HostSecrets /* password / imported key / passphrase; Debug redacts */ }
// ConnectOptions::new(known_hosts_path) fills in the defaults (no secrets).
pub fn check_private_key(text: &str, passphrase: Option<&str>) -> Result<String /* SHA256 fingerprint */, TransportError>;

pub struct HostKeyCheck { pub host: String, pub address: IpAddr, pub algorithm: String, pub fingerprint: String }
pub enum HostKeyDecision { Trust, Confirm }
impl HostKeyPolicy { fn new(impl Fn(&HostKeyCheck) -> HostKeyDecision); fn tailnet_only() -> Self; fn decide(&self, &HostKeyCheck) }
pub fn is_tailnet_ip(ip: IpAddr) -> bool;      // 100.64.0.0/10, fd7a:115c:a1e0::/48 (incl. v4-mapped)
```

Differences from the architecture sketch:

- `connect` takes `&ConnectOptions`. That is where the app-provided known_hosts path and the timeouts live.
- WSL uses `--exec` rather than `--`. See the WSL section for why.

## Semantics

**Commands**

- *SSH and WSL* run commands in the user's login shell, so `PATH` includes `~/.local/bin`. The command is built as:
  ```
  exec sh -c 'exec "${SHELL:-/bin/sh}" -lc "$1"' sh '<cd DIR && >exec <env K=V…> argv…'
  ```
  - Every word is POSIX-quoted, and the quoting also parses correctly in fish.
  - Every level `exec`s the next, so the command is the only process on the channel.
  - `cwd` may be `~` or `~/…`.
- *Local* runs argv directly, with no shell. On Windows it uses `CREATE_NO_WINDOW`.

**Running commands**

- `exec` writes `cmd.stdin` and then sends EOF. Without `cmd.stdin`, it sends EOF immediately.
- On `cmd.timeout`, `exec` kills the command and returns `TransportError::Timeout`. The connection stays usable.
- `spawn` ignores `cmd.stdin` and `cmd.timeout`:
  - Shutting down or dropping `Child::stdin` sends EOF.
  - Dropping the `Child` kills the command. `kill()` sends SIGKILL; if the host ignores it, the channel is closed after 2 s.
  - stdout and stderr are buffered without bound, so that a slow reader can't stall the shared SSH session. **Drain both, or drop the one you don't need.**

**Connection lifecycle**

- `Closed` is emitted once per established connection:
  - `Closed(None)` means the app called `close()` or dropped the transport.
  - `Closed(Some(reason))` means the connection was lost: the remote disconnected, the network failed, or the keepalive timed out. Reconnect in this case.
- Operations after the close fail with `TransportError::Closed(..)`, carrying the same `None`/`Some` meaning.
- A connection that never got established emits no `Closed`; `connect` returns the error instead.
- Cancel a pending `connect` by dropping the future. Use this, for example, when the user gives up on a check-mode approval.

**Errors**

`TransportError` provides `code()` (`transport.*`), `hint()` and `retryable()`, and implements `From<TransportError> for tf_proto::ApiError`.

## SSH specifics (russh 0.64.1, `ring` backend)

**Connecting**

- The dial target is the MagicDNS name or the 100.x IP. IPv4 is preferred.
- Error mapping:

  | Failure | Error | Hint |
  |---|---|---|
  | Name doesn't resolve | `Resolve` | Use the 100.x IP; MagicDNS may be off. |
  | Connection refused | `Connect` | `tailscale set --ssh` |
  | Host unreachable | `Connect` | Is Tailscale connected? |

**Host keys**

- Stored in OpenSSH format (`[host]:port` when the port isn't 22).
- A key seen for the first time goes to `ConnectOptions::host_key_policy` with the resolved peer address. The default `tailnet_only()` trusts tailnet addresses silently (Tailscale authenticates the node) and asks for confirmation everywhere else.
- `Trust`: the key is pinned and the transport emits `Phase(Connecting, "Trusted new host key SHA256:…")`.
- `Confirm`: nothing is pinned and the connect fails with `HostKeyUnconfirmed { host, address, algorithm, fingerprint }` (`transport.hostKeyUnconfirmed`, not retryable). Connect again with a policy that trusts that fingerprint once the user has confirmed it.
- A different key fails with `HostKeyMismatch { host, expected, actual, known_hosts }`, whatever the policy says. The pin is never overwritten.

**Authentication** (`ssh/auth.rs`, by `HostProfile::auth`; absent = `tailscale`)

- Host key checks run in the handshake, before any auth request, for every method.
- `tailscale`: `none` only.
  - A banner containing an `https://` URL (Tailscale check mode) produces `Phase(AuthRequired, banner)` and then `AuthUrl(url)`. The connect keeps waiting, up to `auth_timeout`.
  - If the server ends auth, the error is `AuthDenied { banner }`.
  - If the server offers other methods instead, the error is `NotTailscaleSsh { methods }`: you reached a regular sshd.
- `password` / `key` need `profile.user`. The credential is loaded first (`CredentialMissing` when nothing is saved): the password from `opts.secrets`, or the key from `profile.key_path` (`~/` expanded, read on a blocking thread) else `opts.secrets.private_key`, decrypted with `opts.secrets.passphrase` only when it is encrypted. OpenSSH, PEM (PKCS#1, PKCS#8, SEC1) and PuTTY keys; pasted text may carry indentation, CRLF and blank lines. Errors: `KeyPassphraseNeeded`, `KeyPassphraseWrong`, `KeyUnreadable { detail }` (missing file, a `.pub` file, unsupported format or legacy cipher).
- Then `none` (a host that needs no credentials, e.g. Tailscale SSH, signs in right there) and the configured credential, once. Nothing else is ever tried: no agent, no default key files, no other saved secret.
  - Password: `password` if offered, else answered at a `keyboard-interactive` password prompt (a second password prompt = rejected; other prompts = `AuthIncomplete`).
  - Key: RSA signs with the best `rsa-sha2-*` the host lists.
  - Errors (none retryable, so a wrong password is never retried on its own): `PasswordRejected { user }`, `KeyRejected { user, fingerprint }`, `AuthMethodNotAllowed { method, offered }`, `AuthIncomplete { method, user, needs }` (partial success), `SignInClosed { method, user, banner }`.

**Liveness**

- russh's `keepalive_interval` and `inactivity_timeout` are off: in 0.64.1, setting `keepalive_interval` busy-loops while auth is pending.
- After auth, our own `send_ping` task emits `Latency(ms)`.
- The link is declared lost after `ping_max_misses` unanswered pings in a row.

**Port forwarding**

`forward_tcp` opens `direct-tcpip`:

| Host response | Error |
|---|---|
| Policy refusal | `ForwardDenied` |
| Target unreachable | `ForwardFailed` |

## WSL specifics

- Commands run as `wsl.exe -d <distro> --exec sh -c <login wrapper> sh <cmd>`, with `WSL_UTF8=1` set.
  - `--exec` avoids an extra Windows-side shell layer.
  - The login wrapper provides PATH, env and cwd in the same way as SSH.
- When wsl.exe's own stderr is UTF-16, it is re-encoded to UTF-8.
- `connect` warms the distro up by running `wsl.exe -d <distro> --exec true` directly (no login shell: its profile files can take seconds), and fails with `Wsl(msg)` if the distro is missing.
- `forward_tcp` maps localhost-like hosts to `127.0.0.1`, since WSL2 forwards localhost.
- `WslKeepalive::start(distro)` runs `wsl.exe -d <distro> --exec sleep 2147483647` (no shell; 68 years instead of `sleep infinity`, which old busybox lacks) and kills it on drop. WSL stops a distro `instanceIdleTimeout` (default 15 s) after its last `wsl.exe` client exits, taking everything running in it along; tf-client holds one per wanted WSL host across reconnects. Agents that must outlive the app need `[general] instanceIdleTimeout=-1` in `%UserProfile%\.wslconfig`.
- `list_distros` and `parse_distros`:
  - Decode the UTF-16LE output of `wsl.exe -l -v`.
  - Read the columns from the right, because the headers may be localized.
  - Take `running` from `wsl.exe -l --running -q` (both run at once).

## Verification

- Tests: `cargo test -p tf-transport`.
  - The SSH tests use an in-process russh server that simulates Tailscale and a regular sshd:
    - `none` auth
    - check-mode banner, then a delayed accept
    - deny
    - an OpenSSH-like refusal
    - password (also over `keyboard-interactive`) and public keys (`AuthMode::Sshd`), logging every auth request so tests prove which credentials were sent
    - `sh -c` exec, and a direct-tcpip proxy
  - Key fixtures in `tests/fixtures/user_*`: ed25519 (plain and passphrase `correct horse`), encrypted PKCS#8 ECDSA, RSA PEM.
  - A TCP proxy cuts or freezes links to test disconnects and keepalive.
- Probe a real host:
  ```
  cargo run -p tf-transport --example probe -- ssh <100.x IP> --user <u> -- herdr --version
  ```
  Add `--forward 127.0.0.1:<port>` to exercise a tunnel. For a regular sshd: `--key <file>` (passphrase in `$TF_PROBE_PASSPHRASE`) or `--password` (`$TF_PROBE_PASSWORD`), and `--trust SHA256:…` to pin a non-tailnet host key.
- Cross checks:
  - `cargo xwin check --target x86_64-pc-windows-msvc -p tf-transport`
  - `cargo check --target aarch64-linux-android -p tf-transport`, with NDK `CC_`/`AR_` set as in `docs/build.md`.
