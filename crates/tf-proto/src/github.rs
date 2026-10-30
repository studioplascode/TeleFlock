//! The GitHub CLI's sign-in and git's commit identity on a host (`gh.authStatus`,
//! `gh.authStart`, `git.identity`, `git.setIdentity`; architecture §3.12 and §3.14).
//!
//! Pull request status, checks and merges on the board run `gh` on the host, and commits need
//! git's `user.name` / `user.email`. `gh.authStart` runs `gh auth login --web` there as a sign-in
//! flow ([`AuthFlow`](crate::AuthFlow), `kind: "gh"`): its one-time code and
//! `https://github.com/login/device` are completed in the device's browser, from any device.

use crate::AuthFlow;

wire_struct! {
    /// One account `gh auth status --json hosts` lists.
    pub struct GhAccount {
        /// `github.com`, or a GitHub Enterprise host.
        pub host: String,
        pub login: String,
        /// The account gh uses for its host.
        pub active: bool,
        /// The token works (gh's `state: success`).
        pub ok: bool,
        /// Why it doesn't (gh's `error`).
        pub error: Option<String>,
        /// Where gh keeps the token: `keyring`, a `hosts.yml` path, `GH_TOKEN`, …
        pub token_source: Option<String>,
        /// The token's scopes as gh lists them (`gist, read:org, repo`).
        pub scopes: Option<String>,
        /// `https` or `ssh`.
        pub git_protocol: Option<String>,
    }
}

wire_struct! {
    pub struct GhAuthStatus {
        /// gh is installed (otherwise Host setup offers `install-gh`).
        pub installed: bool,
        pub version: Option<String>,
        /// Active accounts first.
        #[serde(default)]
        pub accounts: Vec<GhAccount>,
        /// git uses gh's sign-in for HTTPS to GitHub (`gh auth setup-git`).
        #[serde(default)]
        pub git_credential_helper: bool,
        /// Sign-ins running on the host (`gh.authStart`), newest first.
        #[serde(default)]
        pub flows: Vec<AuthFlow>,
    }
}

wire_struct! {
    pub struct GhAuthStartParams {
        /// Default `github.com`.
        pub hostname: Option<String>,
        /// Afterwards let git push and pull over HTTPS with this sign-in (`gh auth setup-git`,
        /// which adds gh as git's credential helper for the host). Default true.
        pub setup_git: Option<bool>,
    }
}

wire_struct! {
    /// git's commit identity for the host user (`git config --global user.name` / `user.email`).
    pub struct GitIdentity {
        pub name: Option<String>,
        pub email: Option<String>,
        /// The file `git config --global` reads and writes (absent: git is not installed).
        pub file: Option<String>,
        /// From the signed-in GitHub account: its name (else its login) …
        pub suggested_name: Option<String>,
        /// … and its no-reply address (`<id>+<login>@users.noreply.github.com`).
        pub suggested_email: Option<String>,
    }
}

wire_struct! {
    pub struct GitIdentityParams {
        pub name: String,
        pub email: String,
    }
}
