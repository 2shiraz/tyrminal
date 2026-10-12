//! Named layout templates (agent C, Phase 05).
//!
//! A template is an arrangement of tabs and split panes and the destination of each pane. It is
//! deliberately not a session snapshot: it stores no commands, no working directories, no output
//! and no credentials, and restoring one never connects anywhere by itself (the renderer shows
//! every restored pane disconnected until the user chooses Connect). Saved layouts are therefore
//! never remote-process persistence.
//!
//! Everything the renderer sends is validated here: the split tree must name each pane of its tab
//! exactly once, ratios are bounded, the pane total respects `MAX_LAYOUT_PANES`, names and titles
//! are display-safe, and every SSH destination must be a host that exists in the vault.

use serde::{Deserialize, Serialize};
use tyrminal_contracts::limits::{MAX_LAYOUT_PANES, MAX_TAB_TITLE_LEN};
use tyrminal_contracts::{
    IpcError, LayoutDirection, LayoutNode, LayoutTab, LayoutTarget, LayoutTemplateSummary, WorkspacePreferences,
};
use tyrminal_vault::Id;

use crate::error::{invalid, not_found};
use crate::validate;

pub(crate) const MIN_RATIO: f64 = 0.15;
pub(crate) const MAX_RATIO: f64 = 0.85;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum StoredTarget {
    Ssh { host_id: String },
    Local,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum StoredNode {
    Leaf { pane: u32 },
    Split { dir: StoredDirection, ratio: f64, a: Box<StoredNode>, b: Box<StoredNode> },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StoredDirection {
    Row,
    Column,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct StoredTab {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub panes: Vec<StoredTarget>,
    pub layout: StoredNode,
    pub focused: u32,
    #[serde(default)]
    pub focus_mode: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub(crate) struct LayoutRecord {
    pub name: String,
    pub tabs: Vec<StoredTab>,
    pub updated_at: u64,
}

impl LayoutRecord {
    /// Byte length of the record's strings plus a bound for its structure, for `records::encode`.
    pub(crate) fn content_len(&self) -> usize {
        self.name.len()
            + self
                .tabs
                .iter()
                .map(|t| t.title.as_ref().map_or(0, String::len) + 128 * (t.panes.len() * 2 + 1))
                .sum::<usize>()
    }
}

/// A custom tab title: display-safe, at most `MAX_TAB_TITLE_LEN` characters; blank means none.
fn title(value: Option<&str>) -> Result<Option<String>, IpcError> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
    if value.chars().count() > MAX_TAB_TITLE_LEN {
        return Err(invalid("A tab name is too long (80 characters at most)."));
    }
    // Same display rules as every other stored name (no controls, no bidi overrides).
    validate::label(value).map(Some)
}

/// Checks a split tree: every leaf names a pane of the tab, each exactly once, and every ratio is
/// a finite share within the bounds the renderer allows when dragging.
fn node(value: &LayoutNode, panes: usize, seen: &mut [bool], depth: usize) -> Result<StoredNode, IpcError> {
    // Each split adds a leaf, so a valid tree is never deeper than its pane count.
    if depth > MAX_LAYOUT_PANES {
        return Err(invalid("The layout is nested too deeply."));
    }
    match value {
        LayoutNode::Leaf { pane } => {
            let index = usize::try_from(*pane).map_err(|_| invalid("The layout names a pane that does not exist."))?;
            let slot = seen
                .get_mut(index)
                .filter(|_| index < panes)
                .ok_or_else(|| invalid("The layout names a pane that does not exist."))?;
            if *slot {
                return Err(invalid("The layout shows the same pane twice."));
            }
            *slot = true;
            Ok(StoredNode::Leaf { pane: *pane })
        }
        LayoutNode::Split { dir, ratio, a, b } => {
            if !ratio.is_finite() || !(MIN_RATIO..=MAX_RATIO).contains(ratio) {
                return Err(invalid("A pane divider is out of range."));
            }
            let dir = match dir {
                LayoutDirection::Row => StoredDirection::Row,
                LayoutDirection::Column => StoredDirection::Column,
            };
            let a = node(a, panes, seen, depth + 1)?;
            let b = node(b, panes, seen, depth + 1)?;
            Ok(StoredNode::Split { dir, ratio: *ratio, a: Box::new(a), b: Box::new(b) })
        }
    }
}

/// Validates the tabs of a template. `host_exists` answers whether an SSH destination is a host
/// in the vault; a template can never point at something the user has not saved.
pub(crate) fn validate_tabs(tabs: &[LayoutTab], host_exists: impl Fn(&Id) -> bool) -> Result<Vec<StoredTab>, IpcError> {
    if tabs.is_empty() {
        return Err(invalid("A layout needs at least one tab."));
    }
    let total: usize = tabs.iter().map(|t| t.panes.len()).sum();
    if total > MAX_LAYOUT_PANES || tabs.len() > MAX_LAYOUT_PANES {
        return Err(invalid("A layout holds at most 16 panes."));
    }
    let mut out = Vec::with_capacity(tabs.len());
    for tab in tabs {
        if tab.panes.is_empty() {
            return Err(invalid("Every tab of a layout needs a pane."));
        }
        let mut panes = Vec::with_capacity(tab.panes.len());
        for target in &tab.panes {
            panes.push(match target {
                LayoutTarget::Local => StoredTarget::Local,
                LayoutTarget::Ssh { host_id } => {
                    let id = validate::id(host_id)?;
                    if !host_exists(&id) {
                        return Err(not_found("A host in this layout no longer exists."));
                    }
                    StoredTarget::Ssh { host_id: validate::id_text(&id) }
                }
            });
        }
        let mut seen = vec![false; tab.panes.len()];
        let layout = node(&tab.layout, tab.panes.len(), &mut seen, 0)?;
        if seen.iter().any(|s| !s) {
            return Err(invalid("The layout leaves a pane out."));
        }
        if usize::try_from(tab.focused).map_or(true, |f| f >= tab.panes.len()) {
            return Err(invalid("The focused pane does not exist."));
        }
        out.push(StoredTab {
            title: title(tab.title.as_deref())?,
            panes,
            layout,
            focused: tab.focused,
            focus_mode: tab.focus_mode,
        });
    }
    Ok(out)
}

fn to_node(value: &StoredNode) -> LayoutNode {
    match value {
        StoredNode::Leaf { pane } => LayoutNode::Leaf { pane: *pane },
        StoredNode::Split { dir, ratio, a, b } => LayoutNode::Split {
            dir: match dir {
                StoredDirection::Row => LayoutDirection::Row,
                StoredDirection::Column => LayoutDirection::Column,
            },
            ratio: *ratio,
            a: Box::new(to_node(a)),
            b: Box::new(to_node(b)),
        },
    }
}

pub(crate) fn summary(id: &Id, record: &LayoutRecord) -> LayoutTemplateSummary {
    LayoutTemplateSummary {
        id: validate::id_text(id),
        name: record.name.clone(),
        tabs: record
            .tabs
            .iter()
            .map(|t| LayoutTab {
                title: t.title.clone(),
                panes: t
                    .panes
                    .iter()
                    .map(|p| match p {
                        StoredTarget::Local => LayoutTarget::Local,
                        StoredTarget::Ssh { host_id } => LayoutTarget::Ssh { host_id: host_id.clone() },
                    })
                    .collect(),
                layout: to_node(&t.layout),
                focused: t.focused,
                focus_mode: t.focus_mode,
            })
            .collect(),
        updated_at: record.updated_at,
    }
}

// ---------- detaching a tab into its own window ----------

/// Validates a request to move a tab into a new window: the same tree rules as a template, a
/// well-formed session id per pane (ownership is checked by the handoff itself) and display-safe
/// texts, since the new window shows them.
pub fn validate_detach(tab: &tyrminal_contracts::DetachTabInput) -> Result<(), IpcError> {
    let shape = LayoutTab {
        title: tab.title.clone(),
        panes: tab.panes.iter().map(|p| p.target.clone()).collect(),
        layout: tab.layout.clone(),
        focused: tab.focused,
        focus_mode: false,
    };
    // Destinations are for display and reconnecting only; the sessions already exist.
    validate_tabs(std::slice::from_ref(&shape), |_| true)?;
    for pane in &tab.panes {
        validate::id(&pane.session_id)?;
        validate::label(&pane.label)?;
        if !pane.identity.is_empty() {
            validate::label(&pane.identity)?;
        }
    }
    Ok(())
}

// ---------- workspace preferences ----------

pub(crate) const MAX_HIGHLIGHT_KEYWORDS: usize = 32;
pub(crate) const MAX_KEYWORD_LEN: usize = 64;
pub(crate) const MAX_BINDINGS: usize = 64;

/// Key names a binding may use: single printable characters and the named keys the shortcut
/// layer understands. Anything else is refused rather than stored.
fn key_ok(key: &str) -> bool {
    const NAMED: &[&str] = &[
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Tab",
        "Enter",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "F1",
        "F2",
        "F3",
        "F4",
        "F5",
        "F6",
        "F7",
        "F8",
        "F9",
        "F10",
        "F11",
        "F12",
    ];
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => c.is_ascii_graphic() && !c.is_ascii_uppercase(),
        _ => NAMED.contains(&key),
    }
}

/// Validates workspace preferences. Bindings must keep the terminal's own keys: a binding needs a
/// modifier other than Shift, and outside macOS a plain Ctrl+key (interrupt, kill line, ...) is
/// never taken by the application.
pub(crate) fn sanitize_workspace(mut prefs: WorkspacePreferences) -> Result<WorkspacePreferences, IpcError> {
    let h = &mut prefs.highlight;
    if h.keywords.len() > MAX_HIGHLIGHT_KEYWORDS {
        return Err(invalid("At most 32 highlight words can be set."));
    }
    // terminal input: highlight patterns
    if h.keywords.iter().filter(|k| k.pattern).count() > tyrminal_contracts::limits::MAX_HIGHLIGHT_PATTERNS {
        return Err(invalid("At most 8 highlight patterns can be set."));
    }
    for keyword in &mut h.keywords {
        if keyword.pattern {
            crate::highlight::check_pattern(&keyword.text)?;
            continue;
        }
        let text = keyword.text.trim();
        if text.is_empty() || text.chars().count() > MAX_KEYWORD_LEN {
            return Err(invalid("A highlight word must be 1 to 64 characters."));
        }
        keyword.text = validate::label(text)?;
    }
    if prefs.bindings.len() > MAX_BINDINGS {
        return Err(invalid("Too many shortcuts are set."));
    }
    let mut seen = std::collections::BTreeSet::new();
    for binding in &prefs.bindings {
        let action_ok = !binding.action.is_empty()
            && binding.action.len() <= 32
            && binding.action.bytes().all(|b| b.is_ascii_alphanumeric());
        if !action_ok || !seen.insert(binding.action.clone()) {
            return Err(invalid("A shortcut names an unknown or repeated action."));
        }
        if let Some(key) = &binding.key {
            if !key_ok(key) {
                return Err(invalid("A shortcut uses a key that cannot be bound."));
            }
            if !(binding.ctrl || binding.alt || binding.meta) {
                return Err(invalid("A shortcut needs Ctrl, Alt or Cmd, so typing is never taken from the terminal."));
            }
            if binding.ctrl && !binding.alt && !binding.shift && !binding.meta {
                return Err(invalid(
                    "Ctrl with a single key belongs to the terminal (for example Ctrl+C). Add Shift or Alt.",
                ));
            }
        }
    }
    Ok(prefs)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const HOST: &str = "0123456789abcdef0123456789abcdef";

    fn leaf(pane: u32) -> LayoutNode {
        LayoutNode::Leaf { pane }
    }
    fn split(ratio: f64, a: LayoutNode, b: LayoutNode) -> LayoutNode {
        LayoutNode::Split { dir: LayoutDirection::Row, ratio, a: Box::new(a), b: Box::new(b) }
    }
    fn ssh() -> LayoutTarget {
        LayoutTarget::Ssh { host_id: HOST.into() }
    }
    fn tab(panes: Vec<LayoutTarget>, layout: LayoutNode) -> LayoutTab {
        LayoutTab { title: None, panes, layout, focused: 0, focus_mode: false }
    }
    fn known(_: &Id) -> bool {
        true
    }
    fn message(result: Result<Vec<StoredTab>, IpcError>) -> String {
        result.expect_err("expected a refusal").message
    }

    #[test]
    fn a_valid_two_tab_template_round_trips() {
        let tabs = vec![
            tab(vec![ssh(), LayoutTarget::Local], split(0.5, leaf(1), leaf(0))),
            tab(vec![LayoutTarget::Local], leaf(0)),
        ];
        let stored = validate_tabs(&tabs, known).unwrap();
        let record = LayoutRecord { name: "Ops".into(), tabs: stored, updated_at: 1 };
        let back = summary(&[0; 16], &record);
        assert_eq!(back.tabs, tabs);
    }

    #[test]
    fn a_tree_must_name_each_pane_exactly_once() {
        // Missing pane 1.
        assert!(message(validate_tabs(&[tab(vec![ssh(), ssh()], leaf(0))], known)).contains("leaves a pane out"));
        // Pane 0 twice.
        assert!(
            message(validate_tabs(&[tab(vec![ssh(), ssh()], split(0.5, leaf(0), leaf(0)))], known))
                .contains("same pane twice")
        );
        // Out of range.
        assert!(message(validate_tabs(&[tab(vec![ssh()], leaf(7))], known)).contains("does not exist"));
        assert!(message(validate_tabs(&[tab(vec![ssh()], leaf(u32::MAX))], known)).contains("does not exist"));
    }

    #[test]
    fn ratios_must_be_finite_and_within_drag_bounds() {
        for ratio in [f64::NAN, f64::INFINITY, -0.5, 0.0, 0.1, 0.9, 1.0, 2.0] {
            let tabs = [tab(vec![ssh(), ssh()], split(ratio, leaf(0), leaf(1)))];
            assert!(message(validate_tabs(&tabs, known)).contains("out of range"), "{ratio}");
        }
        for ratio in [MIN_RATIO, 0.5, MAX_RATIO] {
            assert!(validate_tabs(&[tab(vec![ssh(), ssh()], split(ratio, leaf(0), leaf(1)))], known).is_ok());
        }
    }

    #[test]
    fn at_most_sixteen_panes_in_all_tabs() {
        let row = |n: u32| (1..n).fold(leaf(0), |acc, i| split(0.5, acc, leaf(i)));
        let sixteen = vec![tab(vec![LayoutTarget::Local; 8], row(8)), tab(vec![LayoutTarget::Local; 8], row(8))];
        assert!(validate_tabs(&sixteen, known).is_ok());
        let seventeen = vec![tab(vec![LayoutTarget::Local; 8], row(8)), tab(vec![LayoutTarget::Local; 9], row(9))];
        assert!(message(validate_tabs(&seventeen, known)).contains("at most 16"));
        // Many empty tabs are refused too, not just many panes.
        let empties: Vec<_> = (0..20).map(|_| tab(Vec::new(), leaf(0))).collect();
        assert!(validate_tabs(&empties, known).is_err());
        assert!(message(validate_tabs(&[], known)).contains("at least one tab"));
        assert!(message(validate_tabs(&[tab(Vec::new(), leaf(0))], known)).contains("needs a pane"));
    }

    #[test]
    fn a_deep_tree_is_refused_without_unbounded_recursion() {
        // A chain deeper than any valid tree (leaves repeat, but depth is checked first).
        let mut deep = leaf(0);
        for _ in 0..1_000 {
            deep = split(0.5, deep, leaf(0));
        }
        assert!(message(validate_tabs(&[tab(vec![ssh()], deep)], known)).contains("too deeply"));
    }

    #[test]
    fn destinations_must_be_saved_hosts_with_valid_ids() {
        let unknown = |_: &Id| false;
        let refused = validate_tabs(&[tab(vec![ssh()], leaf(0))], unknown).unwrap_err();
        assert_eq!(refused.code, tyrminal_contracts::ErrorCode::NotFound);
        for bad in ["", "not-an-id", "0123456789ABCDEF0123456789ABCDEF", "../../etc/passwd"] {
            let tabs = [tab(vec![LayoutTarget::Ssh { host_id: bad.into() }], leaf(0))];
            assert!(validate_tabs(&tabs, known).is_err(), "{bad}");
        }
    }

    #[test]
    fn titles_are_display_safe_and_bounded() {
        let titled = |title: &str| LayoutTab { title: Some(title.into()), ..tab(vec![ssh()], leaf(0)) };
        assert_eq!(validate_tabs(&[titled("  prod  ")], known).unwrap()[0].title.as_deref(), Some("prod"));
        assert_eq!(validate_tabs(&[titled("   ")], known).unwrap()[0].title, None);
        for bad in ["a\u{1b}[31mred", "evil\u{202e}gnp", "line\nbreak", &"x".repeat(81)] {
            assert!(validate_tabs(&[titled(bad)], known).is_err(), "{bad:?}");
        }
        assert!(validate_tabs(&[titled(&"é".repeat(80))], known).is_ok());
    }

    #[test]
    fn the_focused_pane_must_exist() {
        let t = LayoutTab { focused: 2, ..tab(vec![ssh(), ssh()], split(0.5, leaf(0), leaf(1))) };
        assert!(message(validate_tabs(&[t], known)).contains("focused pane"));
    }

    fn binding(
        action: &str,
        key: Option<&str>,
        ctrl: bool,
        alt: bool,
        shift: bool,
        meta: bool,
    ) -> tyrminal_contracts::KeyBindingPreference {
        tyrminal_contracts::KeyBindingPreference {
            action: action.into(),
            key: key.map(Into::into),
            ctrl,
            alt,
            shift,
            meta,
        }
    }

    #[test]
    fn workspace_bindings_never_take_terminal_keys() {
        let with = |b| WorkspacePreferences { bindings: vec![b], ..Default::default() };
        // Accepted: Ctrl+Shift, Alt, Cmd, and an action left without a shortcut.
        for ok in [
            binding("palette", Some("p"), true, false, true, false),
            binding("splitRight", Some("ArrowRight"), false, true, false, false),
            binding("find", Some("f"), false, false, false, true),
            binding("lock", None, false, false, false, false),
        ] {
            assert!(sanitize_workspace(with(ok.clone())).is_ok(), "{ok:?}");
        }
        // Refused: plain keys, Shift alone, Ctrl+letter (interrupt, EOF, ...), unknown keys and actions.
        for bad in [
            binding("palette", Some("p"), false, false, false, false),
            binding("palette", Some("p"), false, false, true, false),
            binding("palette", Some("c"), true, false, false, false),
            binding("palette", Some("d"), true, false, false, false),
            binding("palette", Some("Escape"), true, true, false, false),
            binding("palette", Some("P"), true, false, true, false),
            binding("palette", Some("\u{1b}"), true, true, false, false),
            binding("pal ette", Some("p"), true, false, true, false),
            binding("", Some("p"), true, false, true, false),
        ] {
            assert!(sanitize_workspace(with(bad.clone())).is_err(), "{bad:?}");
        }
        let twice = WorkspacePreferences {
            bindings: vec![
                binding("find", Some("f"), false, true, false, false),
                binding("find", Some("g"), false, true, false, false),
            ],
            ..Default::default()
        };
        assert!(sanitize_workspace(twice).is_err());
    }

    #[test]
    fn highlight_words_are_bounded_and_display_safe() {
        use tyrminal_contracts::{HighlightKeyword, HighlightTone};
        let word = |text: &str| HighlightKeyword {
            text: text.into(),
            tone: HighlightTone::Danger,
            case_sensitive: false,
            pattern: false,
        };
        let with = |words: Vec<HighlightKeyword>| {
            let mut p = WorkspacePreferences::default();
            p.highlight.keywords = words;
            p
        };
        assert_eq!(sanitize_workspace(with(vec![word("  error ")])).unwrap().highlight.keywords[0].text, "error");
        for bad in ["", "   ", "a\u{1b}[31m", "x\u{202e}y", &"w".repeat(65)] {
            assert!(sanitize_workspace(with(vec![word(bad)])).is_err(), "{bad:?}");
        }
        assert!(sanitize_workspace(with((0..33).map(|i| word(&format!("w{i}"))).collect())).is_err());
    }

    #[test]
    fn highlight_patterns_are_checked_and_kept_verbatim() {
        use tyrminal_contracts::{HighlightKeyword, HighlightTone};
        let pattern = |text: &str| HighlightKeyword {
            text: text.into(),
            tone: HighlightTone::Info,
            case_sensitive: true,
            pattern: true,
        };
        let with = |words: Vec<HighlightKeyword>| {
            let mut p = WorkspacePreferences::default();
            p.highlight.keywords = words;
            p
        };
        // Not trimmed: spaces are part of a pattern.
        assert_eq!(sanitize_workspace(with(vec![pattern(" id=\\d+")])).unwrap().highlight.keywords[0].text, " id=\\d+");
        assert!(sanitize_workspace(with(vec![pattern("(a+)+$")])).is_err());
        assert!(sanitize_workspace(with((0..8).map(|i| pattern(&format!("p{i}"))).collect())).is_ok());
        assert!(sanitize_workspace(with((0..9).map(|i| pattern(&format!("p{i}"))).collect())).is_err());
        // A plain word with pattern syntax is literal text and stays allowed.
        let mut literal = pattern("(a+)+$");
        literal.pattern = false;
        assert!(sanitize_workspace(with(vec![literal])).is_ok());
    }

    #[test]
    fn preferences_sanitize_applies_the_workspace_rules() {
        use tyrminal_contracts::Preferences;
        let bad = WorkspacePreferences {
            bindings: vec![binding("find", Some("c"), true, false, false, false)],
            ..Default::default()
        };
        assert!(crate::preferences::sanitize(Preferences { workspace: Some(bad), ..Preferences::default() }).is_err());
        // Files written before workspace preferences existed still load.
        let old: Preferences = serde_json::from_str(r#"{"theme":"dark","reduceMotion":false}"#).unwrap();
        assert_eq!(old.workspace, None);
        assert!(crate::preferences::sanitize(old).is_ok());
    }

    #[test]
    fn a_detach_request_is_validated_like_a_template() {
        use tyrminal_contracts::{DetachPaneInput, DetachTabInput};
        let pane = |session: &str, label: &str| DetachPaneInput {
            session_id: session.into(),
            label: label.into(),
            identity: "deploy@web port 22".into(),
            target: LayoutTarget::Local,
        };
        let ok = DetachTabInput {
            title: None,
            layout: split(0.5, leaf(0), leaf(1)),
            panes: vec![pane(HOST, "a"), pane(HOST, "b")],
            focused: 1,
        };
        assert!(validate_detach(&ok).is_ok());
        let bad_session = DetachTabInput { panes: vec![pane("../x", "a"), pane(HOST, "b")], ..ok.clone() };
        assert!(validate_detach(&bad_session).is_err());
        let bad_label = DetachTabInput { panes: vec![pane(HOST, "a\u{1b}]0;x"), pane(HOST, "b")], ..ok.clone() };
        assert!(validate_detach(&bad_label).is_err());
        let bad_tree = DetachTabInput { layout: leaf(0), ..ok };
        assert!(validate_detach(&bad_tree).is_err());
    }
}
