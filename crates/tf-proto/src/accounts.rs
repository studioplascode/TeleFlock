//! Sign-ins that run on the host and are completed from the app (`auth.*`): linking an omp
//! subscription account (`accounts.*`) and MCP server OAuth (`mcp.authStart`) share one flow type,
//! so one app component drives all of them (architecture §3.14).
//!
//! A flow lives in hostd. The app long-polls it (`auth.wait`), opens its `url` in the device's
//! browser and, when `callbackPort` is set, tunnels that port of the device to the same port on the
//! host (`tunnel.open { localPort }`), so the provider's redirect to `http://localhost:<port>/…`
//! reaches the callback server on the host. Pasting the code or the address the browser landed on
//! (`auth.submit`) completes it when the tunnel can't.
//!
//! `accounts.*` lists the providers `omp login` offers and the credentials omp stores (with their
//! quota windows from `omp usage`), links a new one (`omp login <provider>` driven as an
//! [`AuthFlow`]), unlinks one and marks the account omp should prefer for new sessions.

use crate::methods::LimitWindow;
use crate::Millis;

wire_enum! {
    /// * `starting`: hostd is launching the flow (no URL yet).
    /// * `waiting`: waits on the user: open `url`, enter `userCode` there, paste, or answer `prompt`.
    /// * `done` / `failed` / `cancelled` / `expired`: final; the flow is forgotten a while later.
    pub enum AuthFlowState { Starting, Waiting, Done, Failed, Cancelled, Expired }
}

impl AuthFlowState {
    pub fn is_final(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled | Self::Expired)
    }
}

wire_enum! {
    /// What `auth.submit` accepts while the flow waits:
    /// * `none`: nothing (device-code flows finish on the provider's side).
    /// * `fallback`: the redirect normally reaches the host's callback server through the same-port
    ///   tunnel; the address the browser landed on (or the code it shows) completes the flow otherwise.
    /// * `primary`: the provider shows a code (or redirects somewhere the host can't see): paste it.
    pub enum AuthPaste { None, Fallback, Primary }
}

wire_struct! {
    /// A question the flow waits on (`auth.submit` answers it), e.g. an API key.
    pub struct AuthPrompt {
        pub message: String,
        pub placeholder: Option<String>,
        /// Mask the input (keys, tokens).
        pub secret: bool,
    }
}

wire_struct! {
    /// One sign-in running on the host.
    pub struct AuthFlow {
        pub flow_id: String,
        /// `account` (`accounts.link`) | `mcp` (`mcp.authStart`).
        pub kind: String,
        /// What is signed in to, e.g. `Anthropic (Claude Pro/Max)` or an MCP server's name.
        pub title: String,
        /// omp provider id (`account` flows) or MCP server name (`mcp` flows).
        pub subject: Option<String>,
        pub state: AuthFlowState,
        /// Bumped on every change (`auth.wait { afterRev }`).
        pub rev: u32,
        /// Open in the device's browser (authorization page, or the device-code page).
        pub url: Option<String>,
        /// Port of the loopback callback server on the host that `url` redirects to: the app listens
        /// on the same port of the device and forwards it there.
        pub callback_port: Option<u16>,
        /// `redirect_uri` of `url` (shown to explain what the browser will land on).
        pub redirect_uri: Option<String>,
        /// Device-code flows: the code to enter at `url`.
        pub user_code: Option<String>,
        /// Provider instructions shown with the URL.
        pub instructions: Option<String>,
        pub paste: AuthPaste,
        /// A question the flow waits on; absent when it doesn't wait for input.
        pub prompt: Option<AuthPrompt>,
        /// Latest progress line; the reason once `failed` / `cancelled` / `expired`.
        pub message: Option<String>,
        /// Once `done`: who signed in (`email (org)`), when the provider says.
        pub account: Option<String>,
        pub started_at: Millis,
        /// The flow is given up (`expired`) at this time unless it finishes first.
        pub expires_at: Option<Millis>,
        pub updated_at: Millis,
    }
}

wire_struct! { pub struct AuthFlowRef { pub flow_id: String } }

wire_struct! {
    pub struct AuthWaitParams {
        pub flow_id: String,
        /// Answer once the flow's `rev` is above this; absent: at once.
        pub after_rev: Option<u32>,
        /// Longest wait in ms (default 15000, at most 20000); the current flow is returned then.
        pub wait_ms: Option<u32>,
    }
}

wire_struct! {
    pub struct AuthSubmitParams {
        pub flow_id: String,
        /// The pasted code or redirect address, or the answer to `prompt`.
        pub text: String,
    }
}

wire_struct! {
    pub struct AuthFlowList {
        /// Running flows and those that finished in the last minutes, newest first.
        pub flows: Vec<AuthFlow>,
    }
}

// ───────────────────────────── accounts ─────────────────────────────

wire_struct! {
    /// A provider `omp login` offers (`omp auth-broker list --json`, in omp's `/login` order).
    pub struct LoginProvider {
        /// omp provider id (`anthropic`, `openai-codex`, …).
        pub id: String,
        /// omp's name, e.g. `Anthropic (Claude Pro/Max)`.
        pub name: String,
    }
}

wire_enum! { pub enum CredentialKind { Oauth, ApiKey } }

wire_struct! {
    /// One credential omp stores (a linked account or an API key).
    pub struct LinkedAccount {
        /// OAuth: `LimitAccount.key` (`provider|email:…|org:…`); API key: `provider|#<credential id>`.
        pub key: String,
        /// Provider id the credential is stored under (`openai-codex-device` logins store under
        /// `openai-codex`).
        pub provider: String,
        /// omp's credential id (`accounts.unlink`); absent when only the usage report knows the
        /// account (credentials in an auth broker).
        pub credential_id: Option<i64>,
        pub kind: CredentialKind,
        /// Email, else account / project id; `API key #<id>` for keys.
        pub label: String,
        pub org: Option<String>,
        /// Plan / tier the provider reports (`pro`, `max`, `prolite`, …).
        pub plan: Option<String>,
        pub linked_at: Option<Millis>,
        /// Last time omp wrote the credential (login, token refresh).
        pub updated_at: Option<Millis>,
        /// omp stopped using it (expired refresh token, revoked access): link it again.
        pub disabled: bool,
        pub disabled_reason: Option<String>,
        /// omp prefers this account of its provider for new sessions (`auth.accountPolicies`).
        pub preferred: bool,
        /// Why it can't be the preferred account (API keys; an identity omp can't single out).
        pub prefer_blocked: Option<String>,
        /// Live omp sessions on this host routed through it.
        pub sessions: u32,
        /// Quota windows (`omp usage`), when the provider reports them.
        pub windows: Vec<LimitWindow>,
        /// When omp fetched those windows.
        pub windows_at: Option<Millis>,
        /// Why there are no windows.
        pub windows_error: Option<String>,
    }
}

wire_struct! {
    pub struct AccountsSnapshot {
        /// Everything `omp login` offers, in omp's order.
        pub providers: Vec<LoginProvider>,
        /// Linked accounts and stored keys: preferred first, then by provider and label.
        pub accounts: Vec<LinkedAccount>,
        /// omp keeps credentials in an auth broker (`auth.broker.url` / `OMP_AUTH_BROKER_URL`):
        /// linking works, unlinking and preferring happen on the broker host.
        pub broker: Option<String>,
        /// `accounts.link` flows running or just finished.
        pub flows: Vec<AuthFlow>,
        pub fetched_at: Millis,
        /// Why the lists may be incomplete (omp missing, unreadable store, `omp usage` failed).
        pub error: Option<String>,
    }
}

wire_struct! {
    pub struct AccountsListParams {
        /// Read omp's store and usage again now instead of the cached snapshot.
        pub refresh: Option<bool>,
    }
}

wire_struct! {
    pub struct AccountLinkParams {
        /// `LoginProvider.id`. A link of the same provider that is still running is returned
        /// instead of starting another.
        pub provider: String,
    }
}

wire_struct! {
    pub struct AccountUnlinkParams {
        pub provider: String,
        pub credential_id: i64,
    }
}

wire_struct! {
    pub struct AccountPreferParams {
        /// `LinkedAccount.key` of an OAuth account.
        pub key: String,
        /// `false` clears the preference (omp picks by usage again).
        pub preferred: bool,
    }
}
