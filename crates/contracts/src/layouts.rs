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
