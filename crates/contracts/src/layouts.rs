//! Named layout templates (agent C, Phase 05): a saved arrangement of tabs and panes and the
//! destination of each pane. A template stores no commands, no output and no secrets, and
//! restoring one never connects by itself: every pane waits for an explicit Connect.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a pane of a template connects to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum LayoutTarget {
    Ssh {
        #[serde(rename = "hostId")]
        host_id: String,
    },
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LayoutDirection {
    /// Side by side.
    Row,
    /// Stacked.
    Column,
}

/// The split tree of one tab; leaves name a pane by its index in [`LayoutTab::panes`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum LayoutNode {
    Leaf {
        pane: u32,
    },
    Split {
        dir: LayoutDirection,
        /// Share of the first child, 0.15..=0.85.
        ratio: f64,
        a: Box<LayoutNode>,
        b: Box<LayoutNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LayoutTab {
    /// The user's own tab name; `None` shows the focused pane's host.
    pub title: Option<String>,
    pub panes: Vec<LayoutTarget>,
    pub layout: LayoutNode,
    /// Index into `panes`.
    pub focused: u32,
    pub focus_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LayoutTemplateInput {
    /// `None` creates a template; `Some` replaces that template's contents.
    pub id: Option<String>,
    pub name: String,
    pub tabs: Vec<LayoutTab>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LayoutTemplateSummary {
    pub id: String,
    pub name: String,
    pub tabs: Vec<LayoutTab>,
    #[ts(type = "number")]
    pub updated_at: u64,
}

// ---------- workspace preferences (highlighting, key bindings, Option/Alt and mouse) ----------

/// Agent C's preferences, stored with the other non-secret preferences (plain JSON next to the
/// vault). Absent in files written before they existed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct WorkspacePreferences {
    pub highlight: HighlightPreferences,
    /// Replacements for default shortcuts, one per action at most.
    pub bindings: Vec<KeyBindingPreference>,
    /// macOS: the Option key sends Meta (Esc prefix) instead of composing characters.
    pub option_as_meta: bool,
    /// Right click selects the word under the pointer (the platform default on macOS).
    pub right_click_selects_word: bool,
}

/// Output highlighting: colors drawn over the screen only. The bytes received, shown as text,
/// copied or sent are never changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct HighlightPreferences {
    pub enabled: bool,
    pub ip_addresses: bool,
    pub keywords: Vec<HighlightKeyword>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HighlightKeyword {
    pub text: String,
    pub tone: HighlightTone,
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HighlightTone {
    Danger,
    Warning,
    Success,
    Info,
}

/// A user's shortcut for an application action. `key: None` leaves the action without one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KeyBindingPreference {
    pub action: String,
    pub key: Option<String>,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Cmd on macOS.
    pub meta: bool,
}

// ---------- detaching a tab into its own window (TRM-02) ----------

/// One pane of a tab being moved to a new window: its live session and what the pane shows.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetachPaneInput {
    pub session_id: String,
    pub label: String,
    pub identity: String,
    pub target: LayoutTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetachTabInput {
    pub title: Option<String>,
    /// Leaves name panes by their index in `panes`.
    pub layout: LayoutNode,
    pub panes: Vec<DetachPaneInput>,
    pub focused: u32,
}

/// What the new window receives once: the arrangement and, per pane, the single-use token that
/// lets that window (and only it) take over the session.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetachedPane {
    pub token: String,
    pub label: String,
    pub identity: String,
    pub target: LayoutTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetachedTab {
    pub title: Option<String>,
    pub layout: LayoutNode,
    pub panes: Vec<DetachedPane>,
    pub focused: u32,
}
