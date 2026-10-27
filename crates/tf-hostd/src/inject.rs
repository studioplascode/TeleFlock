//! herdr keystroke injection, the last-resort control path (architecture §3.6, omp.md §1.2).
//!
//! Only injects when the agent is idle (or the command is safe while streaming), omp's
//! composer sits at the bottom of the pane with no dialog, panel or popup over it, and the
//! composer holds no draft. Only canonical full forms from the builtin catalog are sent; after
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

/// What covers omp's composer when injection must not type into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overlay {
    /// A dialog, selector or panel box (ask, tool approval, `/session`, `/model`) replaces the
    /// composer or sits right on top of it.
    Dialog,
    /// The autocomplete menu hangs under the composer.
    Autocomplete,
}

/// What the bottom of an omp pane shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Composer {
    /// The composer is at the bottom of the pane and no dialog, panel or popup covers it.
    pub visible: bool,
    /// Draft text (empty when the editor is empty or shows its placeholder hint).
    pub text: String,
    /// What covers the composer, when one was recognized (always `None` while `visible`).
    pub overlay: Option<Overlay>,
}

impl Composer {
    fn hidden(overlay: Option<Overlay>) -> Self {
        Self { visible: false, text: String::new(), overlay }
    }
}

/// Rows omp may draw under the composer that the parser skips: extension status rows (the
/// bridge's `⇄ teleflock`), the status bar and widgets of the non-box shapes.
const MAX_TRAILERS: usize = 6;

/// Parses herdr's `detection` read (the bottom rows) of an omp pane.
///
/// omp draws the composer in its `composer.shape` with the box glyphs of its `symbolPreset`
/// (`╭╮╰╯─│`, `+-|` for `ascii`), whatever the locale. From the bottom up a pane shows rows
/// the parser skips (extension status rows, the status bar and widgets of the non-box
/// shapes, blank gaps), then the composer: `box` is `╭── status ──╮`, `│ … │` rows and
/// `╰─ text ─╯`; `band` a status band over `╰─ text` and indented continuation rows; `claude`
/// and `pi` put `❯ text` / ` text` rows between two rules; `rule` and `borderless` show
/// `❯ text`; `field` `▐ text ▌`; `rail` `▎ text`.
///
/// An empty editor shows a right-aligned placeholder hint instead of text. A box border at
/// the bottom (asks, approvals, selectors, panels) or right on top of the composer (an
/// approval, or an ask over a draft, keeps the composer under it) and the autocomplete menu
/// under it hide the composer. Captures of each state: `docs/research/omp-samples/composer/`.
pub fn parse_composer(screen: &str) -> Composer {
    let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
    let rows: Vec<Row> = lines.iter().map(|line| Row::classify(line)).collect();
    let mut end = rows.len();
    let mut trailers = 0;
    while let Some(i) = end.checked_sub(1) {
        match rows[i] {
            Row::Blank => {}
            Row::Other if trailers < MAX_TRAILERS => trailers += 1,
            _ => break,
        }
        end = i;
    }
    let Some(last) = end.checked_sub(1) else { return Composer::hidden(None) };
    let found = match rows[last] {
        Row::BoxLast(text) => boxed(&rows, last, text, true),
        // `tui.imeSafeCursor`: the input row loses its right border and the bottom border gets
        // a row of its own.
        Row::Border => match last.checked_sub(1).map(|i| rows[i]) {
            Some(Row::Framed { text, open: true }) => boxed(&rows, last - 1, text, false),
            _ => Found::Covered(Overlay::Dialog),
        },
        Row::Rule => ruled(&rows, &lines, last),
        Row::Band(_) | Row::Prompt(_) | Row::Field(_) | Row::Menu | Row::Indented => gutter(&rows, &lines, last),
        _ => Found::Nothing,
    };
    match found {
        Found::Composer { top, .. } if top > 0 && rows[top - 1] == Row::Border => Composer::hidden(Some(Overlay::Dialog)),
        Found::Composer { text, .. } => Composer { visible: true, text, overlay: None },
        Found::Covered(overlay) => Composer::hidden(Some(overlay)),
        Found::Nothing => Composer::hidden(None),
    }
}

/// Rule glyphs of the rounded/square, heavy, double and ascii box sets.
const RULE: &[char] = &['─', '━', '═', '-'];
const SIDE: &[char] = &['│', '┃', '║', '|'];
const TOP_LEFT: &[char] = &['╭', '┌', '┏', '╔'];
const BOTTOM_LEFT: &[char] = &['╰', '└', '┗', '╚'];
const BOTTOM_RIGHT: &[char] = &['╯', '┘', '┛', '╝'];
/// Corners and tees that end a border row (`+` is every ascii corner and tee).
const BORDER_END: &[char] =
    &['╭', '╮', '╰', '╯', '┌', '┐', '└', '┘', '┏', '┓', '┗', '┛', '╔', '╗', '╚', '╝', '├', '┤', '┣', '┫', '╠', '╣', '+'];
/// The selected autocomplete item's cursor in the `nerd` and `ascii` presets (`unicode` uses
/// `❯`, the prompt gutter of several shapes).
const MENU_CURSOR: &[char] = &['\u{f054}', '>'];
/// The software cursor (`showHardwareCursor: false`) of the `unicode`/`nerd` and `ascii` presets.
const SOFT_CURSOR: &[char] = &['▏', '|'];

/// One row of the pane, as far as the composer parser cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row<'a> {
    Blank,
    /// A box edge of rule glyphs only: `╰────╯`, `├────┤`, `+----+`.
    Border,
    /// `╭── status ──╮` (`+-- status --+`): the box composer's top border.
    BoxTop,
    /// `╰─ text ─╯` (`+- text -+`): the box composer's input row merged into its bottom
    /// border; holds the text between the rules.
    BoxLast(&'a str),
    /// `│ text │`; `open` when the right border is missing (`tui.imeSafeCursor` input row).
    Framed { text: &'a str, open: bool },
    /// `────` across the pane, possibly carrying a status chip (`claude`, `pi`, `rule`).
    Rule,
    /// `╰─ text`: the `band` shape's first input row; holds the text after `╰─`.
    Band(&'a str),
    /// `❯ text`: the first input row of `claude`, `rule` and `borderless`, or the selected
    /// autocomplete item in the `unicode` preset; holds the text after `❯`.
    Prompt(&'a str),
    /// `▐ text ▌` (`field`) or `▎ text` (`rail`); holds the text between the caps.
    Field(&'a str),
    /// The selected autocomplete item in the `nerd` and `ascii` presets.
    Menu,
    /// Two or more leading spaces: continuation rows and unselected autocomplete items.
    Indented,
    /// Anything else: status rows, the status bar, widgets, transcript text.
    Other,
}

impl<'a> Row<'a> {
    fn classify(line: &'a str) -> Self {
        let chrome = line.trim_start();
        let Some(first) = chrome.chars().next() else { return Row::Blank };
        let rest = &chrome[first.len_utf8()..];
        if is_border(chrome) {
            return Row::Border;
        }
        if (TOP_LEFT.contains(&first) && rest.starts_with(RULE)) || (first == '+' && rest.starts_with("--")) {
            return Row::BoxTop;
        }
        if (BOTTOM_LEFT.contains(&first) || first == '+')
            && let Some(text) = merged_bottom(rest)
        {
            return Row::BoxLast(text);
        }
        if let Some(text) = chrome.strip_prefix("╰─") {
            return Row::Band(text);
        }
        if SIDE.contains(&first) {
            return match rest.strip_suffix(SIDE).or_else(|| rest.strip_suffix('█')) {
                Some(text) => Row::Framed { text, open: false },
                None => Row::Framed { text: rest, open: true },
            };
        }
        // Gutters and indentation count from the pane's left edge.
        if is_rule(line) {
            return Row::Rule;
        }
        if let Some(text) = line.strip_prefix('❯') {
            return Row::Prompt(text);
        }
        if let Some(text) = line.strip_prefix(['▐', '▎']) {
            return Row::Field(text.strip_suffix(['▌', '█']).unwrap_or(text));
        }
        let mut chars = line.chars();
        if chars.next().is_some_and(|c| MENU_CURSOR.contains(&c)) && chars.next() == Some(' ') {
            return Row::Menu;
        }
        if line.starts_with("  ") {
            Row::Indented
        } else {
            Row::Other
        }
    }
}

/// A box edge of rule glyphs only (`╰────╯`, `├────┤`, `+----+`).
fn is_border(chrome: &str) -> bool {
    let mut chars = chrome.chars();
    let (Some(first), Some(last)) = (chars.next(), chars.next_back()) else { return false };
    let middle = chars.as_str();
    BORDER_END.contains(&first) && BORDER_END.contains(&last) && !middle.is_empty() && middle.chars().all(|c| RULE.contains(&c))
}

/// The text of the box composer's merged bottom row (`╰─ text ─╯`), given the row after its corner.
fn merged_bottom(rest: &str) -> Option<&str> {
    let body = rest.strip_prefix(RULE)?;
    let body = body.strip_suffix(BOTTOM_RIGHT).or_else(|| body.strip_suffix('+'))?;
    Some(body.strip_suffix(RULE).unwrap_or(body))
}

/// A rule across the pane, possibly carrying a status chip (`──── chip ─`).
fn is_rule(line: &str) -> bool {
    let mut chars = line.chars();
    chars.next().is_some_and(|c| RULE.contains(&c)) && chars.next().is_some_and(|c| RULE.contains(&c)) && line.ends_with(RULE)
}

/// Whether a row ends in the autocomplete menu's scrollbar column (` █` thumb, ` │` track).
fn is_scrollbar(line: &str) -> bool {
    let mut tail = line.chars().rev();
    matches!(tail.next(), Some('█' | '│')) && tail.next() == Some(' ')
}

/// What the bottom of the pane was recognized as.
enum Found {
    /// A composer; `top` is its first row (top border, status band, rule or first input row).
    Composer { top: usize, text: String },
    Covered(Overlay),
    Nothing,
}

/// The `box` composer: `╭── status ──╮`, `│ … │` rows, then the lowest input row at `last`,
/// merged into the bottom border unless `tui.imeSafeCursor` split them. A read that starts
/// inside a tall draft has no top border.
fn boxed(rows: &[Row], last: usize, text: &str, merged: bool) -> Found {
    let mut first = last;
    while let Some(Row::Framed { open: false, .. }) = first.checked_sub(1).map(|i| rows[i]) {
        first -= 1;
    }
    let top = match first.checked_sub(1) {
        // Until the status line attaches, the top border is a plain border.
        Some(i) if matches!(rows[i], Row::BoxTop | Row::Border) => i,
        Some(_) => return Found::Nothing,
        None => 0,
    };
    let inputs: Vec<&str> = rows[first..last]
        .iter()
        .map(|row| match row {
            Row::Framed { text, .. } => *text,
            _ => "",
        })
        .chain([text])
        .collect();
    Found::Composer { top, text: draft(&inputs, merged) }
}

/// `claude` and `pi`: input rows between two rules (`claude`'s top rule carries a status
/// chip); `bottom` is the lower rule.
fn ruled(rows: &[Row], lines: &[&str], bottom: usize) -> Found {
    let input = |row: &Row| matches!(row, Row::Prompt(_) | Row::Indented | Row::Other | Row::Blank);
    let Some(top) = (0..bottom).rev().find(|&i| !input(&rows[i])) else { return Found::Nothing };
    if rows[top] != Row::Rule || top + 1 == bottom {
        return Found::Nothing;
    }
    let inputs: Vec<&str> = (top + 1..bottom)
        .map(|i| match rows[i] {
            Row::Prompt(text) => text,
            _ => lines[i],
        })
        .collect();
    Found::Composer { top, text: draft(&inputs, true) }
}

/// Shapes whose input rows start with a gutter: `band` (`╰─`) and `claude`/`rule`/`borderless`
/// (`❯`) indent their continuation rows under the first one; `field` and `rail` rows each
/// carry their caps. The autocomplete menu hangs under the input the same way, its selected
/// item marked by the preset's cursor. `last` is the lowest of these rows.
fn gutter(rows: &[Row], lines: &[&str], last: usize) -> Found {
    if let Row::Field(_) = rows[last] {
        let first = (0..=last).rev().take_while(|&i| matches!(rows[i], Row::Field(_))).last().unwrap_or(last);
        let inputs: Vec<&str> = rows[first..=last]
            .iter()
            .map(|row| match row {
                Row::Field(text) => *text,
                _ => "",
            })
            .collect();
        return Found::Composer { top: first, text: draft(&inputs, true) };
    }
    let Some(first) = (0..=last).rev().find(|&i| rows[i] != Row::Indented) else { return Found::Nothing };
    let text = |head: &str| {
        let inputs: Vec<&str> = std::iter::once(head).chain(lines[first + 1..=last].iter().copied()).collect();
        draft(&inputs, true)
    };
    match rows[first] {
        Row::Band(head) => {
            // The status band (or the blank row reserved for it) sits right on top.
            let top = first.checked_sub(1).filter(|&i| rows[i] != Row::Border).unwrap_or(first);
            Found::Composer { top, text: text(head) }
        }
        Row::Prompt(head) if !is_menu(rows, lines, first, last) => {
            // `claude` and `rule` draw a rule on top.
            let top = first.checked_sub(1).filter(|&i| rows[i] == Row::Rule).unwrap_or(first);
            Found::Composer { top, text: text(head) }
        }
        Row::Prompt(_) | Row::Menu | Row::BoxLast(_) | Row::Field(_) => Found::Covered(Overlay::Autocomplete),
        _ => Found::Nothing,
    }
}

/// Whether a `❯` row is the autocomplete menu's selected item (`unicode` preset) rather than a
/// prompt: the menu hangs right under the input row (under `claude`'s bottom rule), lists
/// items indented above a lower selection, and draws a scrollbar when it overflows.
fn is_menu(rows: &[Row], lines: &[&str], first: usize, last: usize) -> bool {
    let above = |n: usize| first.checked_sub(n).map(|i| rows[i]);
    matches!(above(1), Some(Row::BoxLast(_) | Row::Band(_) | Row::Prompt(_) | Row::Field(_) | Row::Indented))
        || (above(1) == Some(Row::Rule) && matches!(above(2), Some(Row::Prompt(_) | Row::Indented)))
        || lines[first..=last].iter().any(|line| is_scrollbar(line))
}

/// The draft in the composer's input rows, each given after its gutter or left border. A lone
/// row (`hint`) may show the placeholder instead: right-aligned at least two cells away from
/// the cursor, which with `showHardwareCursor: false` is drawn as `▏` (`|` in ascii).
fn draft(inputs: &[&str], hint: bool) -> String {
    if let ([row], true) = (inputs, hint) {
        let row = row.strip_prefix(' ').unwrap_or(row);
        let row = match row.strip_prefix(SOFT_CURSOR) {
            Some(rest) if rest.is_empty() || rest.starts_with("  ") => rest,
            _ => row,
        };
        if row.starts_with("  ") {
            return String::new();
        }
    }
    let rows: Vec<&str> = inputs
        .iter()
        .map(|row| {
            let row = row.trim();
            row.strip_suffix(SOFT_CURSOR).unwrap_or(row).trim_end()
        })
        .collect();
    rows.join("\n").trim().to_string()
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
        let (message, hint) = match composer.overlay {
            Some(Overlay::Dialog) => ("a dialog or panel is open in the omp TUI", "Answer or close it in the terminal, then retry"),
            Some(Overlay::Autocomplete) => ("omp's autocomplete menu is open", "Finish or clear the draft in the terminal, then retry"),
            None => ("omp's composer isn't visible at the bottom of the pane", "Check the agent's terminal, then retry"),
        };
        return Err(ApiError::new("busy", message).with_hint(hint).retryable());
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

    /// A theme that squares the corners.
    const SQUARE: &str = "┌── GPT-6 Luna ─3%──────272K───┐\n└─ hello square                ─┘\n";

    /// A draft taller than the read: its top border is above the rows herdr returns.
    const TALL: &str = "│  line 9                    │\n│  line 10                   │\n╰─ line 11                   ─╯\n⇄ teleflock\n";

    /// Before the status line attaches, the top border carries nothing.
    const BARE_TOP: &str = "╭──────────────────────────────╮\n╰─                            ─╯\n";

    fn visible(text: &str) -> Composer {
        Composer { visible: true, text: text.into(), overlay: None }
    }

    #[test]
    fn composer_states() {
        assert_eq!(parse_composer(IDLE), visible(""));
        assert_eq!(parse_composer(DRAFT), visible("hello draft"));
        assert_eq!(parse_composer(ASK), Composer::hidden(Some(Overlay::Dialog)));
        assert_eq!(parse_composer(SQUARE), visible("hello square"));
        assert_eq!(parse_composer(TALL), visible("line 9\nline 10\nline 11"));
        assert_eq!(parse_composer(BARE_TOP), visible(""));
        assert_eq!(parse_composer(""), Composer::hidden(None));
        assert_eq!(parse_composer("$ ls\nfoo\n"), Composer::hidden(None));
        // Only a few status rows fit under the composer; more is something else.
        let crowded = format!("{BARE_TOP}{}", "status\n".repeat(MAX_TRAILERS + 1));
        assert_eq!(parse_composer(&crowded), Composer::hidden(None));
    }

    /// `Ok(draft)`: the composer is visible holding `draft`; `Err(overlay)`: it is not.
    type Expected = Result<&'static str, Option<Overlay>>;
    const DIALOG: Expected = Err(Some(Overlay::Dialog));
    const MENU: Expected = Err(Some(Overlay::Autocomplete));

    /// `herdr pane read --source detection --lines 12` captures of omp 18.13.1, named
    /// `<composer.shape>-<symbolPreset>-<cols>x<rows>-<state>` (`status-row`: an extension
    /// status row such as the bridge's `⇄ teleflock` under the composer). Drafts keep the dim
    /// word-completion ghost omp paints after the cursor (`label`, `drafts`, `belly`): a plain
    /// read cannot tell it from typed text.
    const CAPTURES: &[(&str, Expected)] = &[
        ("band-ascii-120x40-draft-multiline", Ok("band ascii draft\nsecond line")),
        ("band-ascii-120x40-idle", Ok("")),
        ("band-ascii-swcursor-120x40-status-row-draft", Ok("band-ascii-swcursor draft")),
        ("band-ascii-swcursor-120x40-status-row-idle", Ok("")),
        ("band-nerd-120x40-status-row-draft", Ok("band-nerd draft")),
        ("band-nerd-120x40-status-row-idle", Ok("")),
        ("band-unicode-120x40-draft-multiline", Ok("hello band draft\nsecond band lines")),
        ("band-unicode-120x40-draft-oneline", Ok("hello band draft")),
        ("band-unicode-120x40-idle", Ok("")),
        ("band-unicode-120x40-nolocale-draft-nonascii", Ok("ascii only und wörld ✓")),
        ("band-unicode-120x40-nolocale-idle", Ok("")),
        ("band-unicode-120x40-session-panel", DIALOG),
        ("band-unicode-120x40-slash-co-popup", MENU),
        ("band-unicode-120x40-status-row-after-user-bash", Ok("")),
        ("band-unicode-120x40-status-row-approval", DIALOG),
        ("band-unicode-120x40-status-row-ask", DIALOG),
        ("band-unicode-120x40-status-row-ask-note-input", DIALOG),
        ("band-unicode-120x40-status-row-ask-over-draft", DIALOG),
        ("band-unicode-120x40-status-row-idle", Ok("")),
        ("band-unicode-120x40-status-row-slash-co-popup", MENU),
        ("band-unicode-120x40-status-row-user-bash-running", Ok("")),
        ("band-unicode-39x24-status-row-draft-wrapped", Ok("a band draft that wraps in a narrow\npane for sure")),
        ("band-unicode-39x24-status-row-idle", Ok("")),
        ("borderless-ascii-120x40-status-row-draft", Ok("borderless ascii draft")),
        ("borderless-ascii-120x40-status-row-idle", Ok("")),
        ("borderless-unicode-120x40-status-row-approval", DIALOG),
        ("borderless-unicode-120x40-status-row-approval-over-draft", DIALOG),
        ("borderless-unicode-120x40-status-row-draft-multiline", Ok("borderless draft\nsecond line")),
        ("borderless-unicode-120x40-status-row-idle", Ok("")),
        ("borderless-unicode-120x40-status-row-slash-co-popup", MENU),
        ("box-ascii-120x40-session-panel", DIALOG),
        ("box-ascii-120x40-status-row-approval", DIALOG),
        ("box-ascii-120x40-status-row-approval-over-draft", DIALOG),
        ("box-ascii-120x40-status-row-draft-multiline", Ok("ascii draft\nsecond ascii lines")),
        ("box-ascii-120x40-status-row-hook-selector", DIALOG),
        ("box-ascii-120x40-status-row-idle", Ok("")),
        ("box-ascii-120x40-status-row-slash-co-popup", MENU),
        ("box-ascii-120x40-status-row-widget-below", Ok("")),
        ("box-nerd-120x24-longstatus-status-row-idle", Ok("")),
        ("box-nerd-120x40-approval", DIALOG),
        ("box-nerd-120x40-ask-dialog", DIALOG),
        // Alt+H hides the ask: only its hint row is left at the bottom.
        ("box-nerd-120x40-ask-hidden", Err(None)),
        ("box-nerd-120x40-ask-over-draft", DIALOG),
        ("box-nerd-120x40-draft-multiline", Ok("hello draft from the lab\nsecond line of the drafts")),
        ("box-nerd-120x40-draft-oneline", Ok("hello draft from the label")),
        ("box-nerd-120x40-idle-after-turn", Ok("")),
        ("box-nerd-120x40-idle-collab", Ok("")),
        ("box-nerd-120x40-idle-nocollab", Ok("")),
        ("box-nerd-120x40-idle-retry-hint", Ok("")),
        ("box-nerd-120x40-model-selector", DIALOG),
        ("box-nerd-120x40-nolocale-idle", Ok("")),
        ("box-nerd-120x40-session-panel", DIALOG),
        ("box-nerd-120x40-slash-co-popup", MENU),
        ("box-nerd-120x40-slash-popup", MENU),
        ("box-nerd-120x40-status-row-approval", DIALOG),
        ("box-nerd-120x40-status-row-draft", Ok("draft with a status row")),
        ("box-nerd-120x40-status-row-idle", Ok("")),
        ("box-nerd-120x40-status-row-slash-co-popup", MENU),
        ("box-nerd-120x40-status-row-streaming", Ok("")),
        ("box-nerd-120x40-streaming", Ok("")),
        ("box-nerd-120x40-streaming-draft", Ok("please also mention the color of the belly")),
        ("box-nerd-120x40-streaming-followup-queued", Ok("")),
        ("box-nerd-120x40-streaming-start", Ok("")),
        ("box-nerd-120x40-streaming-steer-queued", Ok("")),
        ("box-nerd-39x24-status-row-draft", Ok("short drafts")),
        ("box-nerd-39x24-status-row-idle", Ok("")),
        ("box-nerd-39x24-status-row-streaming", Ok("")),
        ("box-nerd-57x38-plain-omp-idle", Ok("")),
        ("box-nerd-59x24-draft-wrapped", Ok("a draft in a narrow pane that is long enough to wrap\nonto a second row of the editors")),
        ("box-nerd-59x24-idle", Ok("")),
        ("box-nerd-59x24-longstatus-idle", Ok("")),
        ("box-nerd-59x24-streaming", Ok("")),
        ("box-unicode-imesafe-120x40-status-row-draft", Ok("box-unicode-imesafe draft")),
        ("box-unicode-imesafe-120x40-status-row-idle", Ok("")),
        ("box-unicode-swcursor-120x40-status-row-draft", Ok("box-unicode-swcursor draft")),
        ("box-unicode-swcursor-120x40-status-row-idle", Ok("")),
        ("claude-nerd-120x40-status-row-draft", Ok("claude nerd draft")),
        ("claude-nerd-120x40-status-row-idle", Ok("")),
        ("claude-unicode-120x40-status-row-draft-multiline", Ok("claude draft\nsecond line")),
        ("claude-unicode-120x40-status-row-idle", Ok("")),
        ("claude-unicode-120x40-status-row-slash-co-popup", MENU),
        ("field-unicode-120x40-status-row-draft-multiline", Ok("field draft\nsecond line")),
        ("field-unicode-120x40-status-row-idle", Ok("")),
        ("field-unicode-120x40-status-row-slash-co-popup", MENU),
        ("pi-ascii-120x40-status-row-draft", Ok("pi ascii draft")),
        ("pi-ascii-120x40-status-row-idle", Ok("")),
        ("pi-unicode-120x40-status-row-draft-multiline", Ok("pi draft\nsecond line")),
        ("pi-unicode-120x40-status-row-idle", Ok("")),
        ("rail-nerd-120x40-status-row-draft", Ok("rail nerd draft")),
        ("rail-nerd-120x40-status-row-idle", Ok("")),
        ("rail-unicode-120x40-status-row-draft-multiline", Ok("rail draft\nsecond line")),
        ("rail-unicode-120x40-status-row-idle", Ok("")),
        ("rule-unicode-120x40-status-row-draft-multiline", Ok("rule draft\nsecond line")),
        ("rule-unicode-120x40-status-row-idle", Ok("")),
    ];

    #[test]
    fn composer_captures() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/research/omp-samples/composer");
        let mut files: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.unwrap().file_name().to_str()?.strip_suffix(".txt").map(str::to_string))
            .collect();
        files.sort();
        let mut listed: Vec<&str> = CAPTURES.iter().map(|(name, _)| *name).collect();
        listed.sort_unstable();
        assert_eq!(files, listed, "every capture has an expectation");
        let failures: Vec<String> = CAPTURES
            .iter()
            .filter_map(|&(name, expected)| {
                let screen = std::fs::read_to_string(format!("{dir}/{name}.txt")).unwrap();
                let want = match expected {
                    Ok(text) => visible(text),
                    Err(overlay) => Composer::hidden(overlay),
                };
                let got = parse_composer(&screen);
                (got != want).then(|| format!("{name}: got {got:?}, want {want:?}"))
            })
            .collect();
        assert!(failures.is_empty(), "{}", failures.join("\n"));
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
