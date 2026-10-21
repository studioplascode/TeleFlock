//! herdr keystroke injection, the last-resort control path (architecture §3.6, omp.md §1.2).
//!
//! Only injects when the agent is idle (or the command is safe while streaming), the
//! omp composer is the last thing on screen (no overlay/dialog), and the composer holds
//! no draft. Only canonical full forms from the builtin catalog are sent; after
//! submitting, the pane is re-read and one more `enter` is sent if autocomplete
//! swallowed the first.

use std::time::Duration;

use tf_herdr::{ReadOptions, ReadSource};
use tf_proto::model::HerdrState;
use tf_proto::ApiError;

use crate::ops::{herdr_err, Ctx};

/// Every omp TUI builtin and alias (omp 18.12 `slash-commands/builtin-*.ts`, `omp.md` §1.3).
/// Anything else would reach the model as a prompt (rule I3). Commands that open a selector,
/// panel or dashboard are included: the client opens the agent's terminal next to them, and
/// later injections refuse to run while the overlay is up (`preflight`).
pub const CATALOG: &[&str] = &[
    // modes and model
    "model", "models", "switch", "effort", "fast", "slow", "plan", "plan-review", "goal", "guided-goal", "vibe",
    "loop", "queue", "skillful", "extended-context", "computer", "prewalk", "modelpreset", "ratchet", "security",
    "settings", "setup", "providers",
    // session
    "new", "resume", "fork", "branch", "rewind", "tree", "rename", "handoff", "compact", "shake", "clear", "fresh",
    "delete", "btw", "tan", "seance", "pin", "todo", "session", "context", "tools", "jobs", "usage", "changelog",
    "hotkeys", "stats", "trace", "export", "dump", "share", "copy", "open", "agents", "hub", "extensions", "status",
    "debug", "git", "move", "wt", "worktree", "add-dir", "remove-dir", "dirs", "login", "logout", "mcp", "memory",
    "skills", "advisor", "collab", "join", "leave", "force", "pause", "live", "record", "forget-approvals",
    "marketplace", "plugins", "plugin", "reload-plugins", "retry", "restart", "exit", "quit", "q", "browser", "ssh",
    "omfg", "cleanse",
];

/// The command name of `/name args` (`parseSlashCommand` splits at the first whitespace or `:`;
/// `/skill:<name>` keeps its prefix).
pub fn command_name(command: &str) -> &str {
    let body = command.trim().trim_start_matches('/');
    if let Some(rest) = body.strip_prefix("skill:") {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        return &body[..6 + end];
    }
    body.split([' ', '\t', ':']).next().unwrap_or_default()
}

/// Validates a full slash command against the builtin catalog.
pub fn validate(command: &str) -> Result<(), ApiError> {
    let cmd = command.trim();
    if !cmd.starts_with('/') {
        return Err(ApiError::new("invalid_params", "slash commands start with `/`"));
    }
    if cmd.contains(['\n', '\r']) {
        return Err(ApiError::new("invalid_params", "slash commands are one line"));
    }
    let name = command_name(cmd);
    if name.starts_with("skill:") && name.len() > 6 {
        return Ok(());
    }
    if !CATALOG.contains(&name) {
        return Err(ApiError::new("unsupported", format!("`/{name}` is not a known omp command"))
            .with_hint("Unknown commands would be sent to the model as a prompt"));
    }
    Ok(())
}

/// What the bottom of an omp pane shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Composer {
    /// The composer box is the last element on screen (no overlay, dialog or popup).
    pub visible: bool,
    /// Draft text (empty when the editor is empty or shows its placeholder hint).
    pub text: String,
}

/// Parses herdr's `detection` read of an omp pane.
///
/// The composer is the last box on screen: a status line `╭── … ╮`, optional `│ … │`
/// continuation lines, and the input line `╰─ <text> ─╯`. An empty editor shows a
/// right-aligned placeholder hint instead of text. Dialogs (ask, approvals) and
/// panels draw their own boxes whose bottom border is `╰───…╯`.
pub fn parse_composer(screen: &str) -> Composer {
    let lines: Vec<&str> = screen.lines().map(|l| l.trim_end()).filter(|l| !l.trim().is_empty()).collect();
    let hidden = Composer { visible: false, text: String::new() };
    let Some(last) = lines.last() else { return hidden };
    let last = last.trim_start();
    let Some(inner) = last.strip_prefix("╰─").and_then(|r| r.strip_suffix("─╯")) else { return hidden };
    if inner.starts_with('─') {
        return hidden;
    }
    // Walk up over continuation lines to the status line.
    let mut extra: Vec<String> = Vec::new();
    let mut found_top = false;
    for l in lines.iter().rev().skip(1) {
        let t = l.trim_start();
        if t.starts_with("╭──") && t.ends_with('╮') {
            found_top = true;
            break;
        }
        if let Some(mid) = t.strip_prefix('│').and_then(|r| r.strip_suffix('│')) {
            extra.push(mid.trim().to_string());
            continue;
        }
        break;
    }
    if !found_top {
        return hidden;
    }
    // Draft text starts right after `╰─ `; the placeholder hint is right-aligned.
    let draft = if inner.starts_with(' ') && !inner.starts_with("  ") { inner.trim().to_string() } else { String::new() };
    extra.reverse();
    let text = if extra.is_empty() {
        draft
    } else {
        let mut all = extra;
        all.push(draft);
        all.join("\n").trim().to_string()
    };
    Composer { visible: true, text }
}

/// Whether the command may be injected while the agent is streaming.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum When {
    IdleOnly,
    AlsoStreaming,
}

async fn read_composer(ctx: &Ctx, pane_id: &str) -> Result<Composer, ApiError> {
    let read = ctx
        .herdr
        .pane_read(pane_id, ReadOptions::new(ReadSource::Detection).lines(12))
        .await
        .map_err(herdr_err)?;
    Ok(parse_composer(&read.text))
}

/// Checks the §3.6 preconditions for an agent.
async fn preflight(ctx: &Ctx, agent_id: &str, when: When) -> Result<String, ApiError> {
    let agent = ctx.state.agent(agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{agent_id}`")))?;
    match agent.state {
        HerdrState::Blocked => {
            return Err(ApiError::new("agent_blocked", "the agent shows a dialog")
                .with_hint("Answer it first (or open the terminal)"));
        }
        HerdrState::Working if when == When::IdleOnly => {
            return Err(ApiError::new("busy", "the agent is working; this control needs it idle")
                .with_hint("Try again when the turn ends, or install the TeleFlock bridge for live control")
                .retryable());
        }
        _ => {}
    }
    let composer = read_composer(ctx, &agent.pane_id).await?;
    if !composer.visible {
        return Err(ApiError::new("busy", "an overlay or dialog is open in the omp TUI")
            .with_hint("Close it in the terminal, then retry")
            .retryable());
    }
    if !composer.text.is_empty() {
        return Err(ApiError::new("busy", "the omp composer holds an unsent draft")
            .with_hint("Send or clear the draft in the terminal first"));
    }
    Ok(agent.pane_id)
}

/// Injects one canonical slash command (§3.6).
pub async fn slash(ctx: &Ctx, agent_id: &str, command: &str, when: When) -> Result<(), ApiError> {
    validate(command)?;
    let pane = preflight(ctx, agent_id, when).await?;
    submit(ctx, &pane, command.trim()).await
}

/// Submits text through herdr (`agent prompt`: bracketed paste, then Enter) and makes
/// sure it left the composer.
pub async fn submit(ctx: &Ctx, pane_id: &str, text: &str) -> Result<(), ApiError> {
    ctx.herdr.agent_prompt(pane_id, text, None).await.map_err(herdr_err)?;
    tokio::time::sleep(Duration::from_millis(450)).await;
    let after = read_composer(ctx, pane_id).await?;
    if after.visible && !after.text.is_empty() && first_word(&after.text) == first_word(text) {
        // Autocomplete swallowed the Enter (rule I2): one more.
        ctx.herdr.agent_send_keys(pane_id, &["enter"]).await.map_err(herdr_err)?;
        tokio::time::sleep(Duration::from_millis(350)).await;
        let again = read_composer(ctx, pane_id).await?;
        if again.visible && !again.text.is_empty() && first_word(&again.text) == first_word(text) {
            return Err(ApiError::new("omp_error", format!("omp did not accept `{}`", crate::util::clip(text, 60)))
                .with_hint("The text is still in the composer; check the terminal"));
        }
    }
    Ok(())
}

/// Queues a follow-up while streaming (rule I6: paste the text, then `ctrl+q`).
pub async fn follow_up(ctx: &Ctx, agent_id: &str, text: &str) -> Result<(), ApiError> {
    let pane = preflight(ctx, agent_id, When::AlsoStreaming).await?;
    ctx.herdr.pane_send_text(&pane, text).await.map_err(herdr_err)?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    ctx.herdr.agent_send_keys(&pane, &["ctrl+q"]).await.map_err(herdr_err)?;
    Ok(())
}

/// Reads recent pane text (used to pick up command output such as export paths).
pub async fn recent_text(ctx: &Ctx, pane_id: &str, lines: u32) -> Result<String, ApiError> {
    ctx.herdr
        .pane_read(pane_id, ReadOptions::new(ReadSource::Recent).lines(lines))
        .await
        .map(|r| r.text)
        .map_err(herdr_err)
}

fn first_word(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDLE: &str = "\
───────────────────────────────────────\n\
 Update Available\n\
\n\
╭── \u{f0d57} GPT-6 Luna \u{e0b1} tf-lab-core-work ─3%──────272K───╮\n\
╰─                                       \u{f0636} \u{f0312} to change thinking effort ─╯\n";

    const DRAFT: &str = "\
╭── \u{f0d57} GPT-6 Luna ─3%──────272K───╮\n\
╰─ hello draft                                   ─╯\n\n";

    const ASK: &str = "\
╭── \u{f0d57} GPT-6 Luna ─3%──────272K───╮\n\
╰─                                                ─╯\n\
╭─ Ask ──────────────────────────────╮\n\
│ Proceed?                           │\n\
│   Yes                              │\n\
╰────────────────────────────────────╯\n";

    #[test]
    fn composer_states() {
        assert_eq!(parse_composer(IDLE), Composer { visible: true, text: String::new() });
        assert_eq!(parse_composer(DRAFT), Composer { visible: true, text: "hello draft".into() });
        assert!(!parse_composer(ASK).visible);
        assert!(!parse_composer("").visible);
        assert!(!parse_composer("$ ls\nfoo\n").visible);
    }

    #[test]
    fn catalog_validation() {
        assert!(validate("/switch openai-codex/gpt-6-luna:low").is_ok());
        assert!(validate("/effort high").is_ok());
        assert!(validate("/compact").is_ok());
        assert!(validate("/skill:review now").is_ok());
        assert_eq!(validate("/skill:").unwrap_err().code, "unsupported");
        assert_eq!(validate("/thinking medium").unwrap_err().code, "unsupported");
        // Selector/panel commands are allowed bare: the client shows the terminal beside them.
        assert!(validate("/switch").is_ok());
        assert!(validate("/tree").is_ok());
        assert!(validate("/rewind").is_ok());
        assert_eq!(validate("switch x").unwrap_err().code, "invalid_params");
        assert_eq!(validate("/queue a\nb").unwrap_err().code, "invalid_params");
        assert_eq!(validate("/plan:on").map(|_| ()), Ok(()));
    }

    #[test]
    fn command_names() {
        assert_eq!(command_name("/jobs kill all"), "jobs");
        assert_eq!(command_name(" /force:bash ls"), "force");
        assert_eq!(command_name("/skill:review now"), "skill:review");
        assert_eq!(command_name("/deploy"), "deploy");
    }
}
