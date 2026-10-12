//! Host inventory rules that need no I/O: effective settings through group chains, group-tree
//! checks and search. The vault service calls these with its in-memory records.

use std::collections::HashMap;

use tyrminal_contracts::limits::MAX_GROUP_DEPTH;
use tyrminal_contracts::{HostAuth, InheritedFields};

use crate::records::{GroupRecord, HostRecord, StoredAuth};

pub(crate) const DEFAULT_PORT: u16 = 22;

/// Groups by id text, as the records reference them.
pub(crate) type GroupIndex<'a> = HashMap<String, &'a GroupRecord>;

/// A host's group and its ancestors, nearest first. Writes prevent cycles, dangling parents and
/// over-deep trees; the walk is still bounded so a damaged record cannot loop.
pub(crate) fn chain<'a>(groups: &GroupIndex<'a>, start: Option<&str>) -> Vec<&'a GroupRecord> {
    let mut out = Vec::new();
    let mut next = start.map(str::to_owned);
    while let Some(id) = next {
        if out.len() >= MAX_GROUP_DEPTH {
            break;
        }
        let Some(group) = groups.get(&id) else { break };
        out.push(*group);
        next = group.parent.clone();
    }
    out
}

/// Levels from a group to its root, counting the group itself; stops counting just past the
/// limit, so a value above `MAX_GROUP_DEPTH` means "too deep".
pub(crate) fn depth(groups: &GroupIndex<'_>, id: &str) -> usize {
    let mut levels = 0;
    let mut next = Some(id.to_owned());
    while let Some(current) = next {
        levels += 1;
        if levels > MAX_GROUP_DEPTH {
            break;
        }
        next = groups.get(&current).and_then(|g| g.parent.clone());
    }
    levels
}

/// The connection settings a host actually uses: its own value, else the nearest group's, else
/// the default. Deterministic: depends only on the records, never on the order they loaded.
pub(crate) struct Effective<'a> {
    pub username: String,
    pub port: u16,
    pub auth: EffectiveAuth<'a>,
    pub inherited: InheritedFields,
}

pub(crate) enum EffectiveAuth<'a> {
    /// The host's own method.
    Own(&'a StoredAuth),
    /// The nearest group's key.
    GroupKey(String),
    /// Nothing set anywhere: ask for the password.
    Ask,
}

pub(crate) fn effective<'a>(groups: &GroupIndex<'_>, host: &'a HostRecord) -> Effective<'a> {
    let chain = chain(groups, host.group.as_deref());
    let mut inherited = InheritedFields::default();
    let username = if host.username.is_empty() {
        inherited.username = true;
        chain.iter().find_map(|g| g.username.clone()).unwrap_or_default()
    } else {
        host.username.clone()
    };
    let port = if host.port == 0 {
        inherited.port = true;
        chain.iter().find_map(|g| g.port).unwrap_or(DEFAULT_PORT)
    } else {
        host.port
    };
    let auth = match &host.auth {
        StoredAuth::Inherit => {
            inherited.auth = true;
            chain.iter().find_map(|g| g.key_id.clone()).map_or(EffectiveAuth::Ask, EffectiveAuth::GroupKey)
        }
        own => EffectiveAuth::Own(own),
    };
    Effective { username, port, auth, inherited }
}

/// Why a host is a production host (P-26): its own flag first, else any group in its chain.
pub(crate) fn production(groups: &GroupIndex<'_>, host: &HostRecord) -> Option<tyrminal_contracts::ProductionSource> {
    if host.production {
        Some(tyrminal_contracts::ProductionSource::Host)
    } else if chain(groups, host.group.as_deref()).iter().any(|g| g.production) {
        Some(tyrminal_contracts::ProductionSource::Group)
    } else {
        None
    }
}

/// What the renderer may know about effective authentication (never a secret).
pub(crate) fn auth_summary(auth: &EffectiveAuth<'_>) -> HostAuth {
    match auth {
        EffectiveAuth::Own(StoredAuth::Password { .. }) => HostAuth::StoredPassword,
        EffectiveAuth::Own(StoredAuth::Key { key_id }) => HostAuth::Key { key_id: key_id.clone() },
        EffectiveAuth::GroupKey(key_id) => HostAuth::Key { key_id: key_id.clone() },
        EffectiveAuth::Own(StoredAuth::AskPassword | StoredAuth::Inherit) | EffectiveAuth::Ask => HostAuth::AskPassword,
    }
}

/// Why a group placement is refused, if it is.
pub(crate) enum TreeError {
    /// The parent does not exist.
    MissingParent,
    /// The group would become its own ancestor.
    Cycle,
    TooDeep,
}

/// Checks that giving group `id` (None: a new group) the parent `parent` keeps the tree valid,
/// including the depth of `id`'s existing descendants.
pub(crate) fn check_placement(
    groups: &GroupIndex<'_>,
    id: Option<&str>,
    parent: Option<&str>,
) -> Result<(), TreeError> {
    let Some(parent) = parent else { return Ok(()) };
    if !groups.contains_key(parent) {
        return Err(TreeError::MissingParent);
    }
    // Walk up from the new parent: meeting `id` means a cycle.
    let mut depth_above = 0usize;
    let mut next = Some(parent.to_owned());
    while let Some(current) = next {
        if Some(current.as_str()) == id {
            return Err(TreeError::Cycle);
        }
        depth_above += 1;
        if depth_above > MAX_GROUP_DEPTH {
            return Err(TreeError::TooDeep);
        }
        next = groups.get(&current).and_then(|g| g.parent.clone());
    }
    let below = id.map_or(0, |id| subtree_height(groups, id, 0));
    if depth_above + 1 + below > MAX_GROUP_DEPTH {
        return Err(TreeError::TooDeep);
    }
    Ok(())
}

/// Levels of descendants under `id` (0 for a leaf).
fn subtree_height(groups: &GroupIndex<'_>, id: &str, guard: usize) -> usize {
    if guard > MAX_GROUP_DEPTH {
        return guard;
    }
    groups
        .iter()
        .filter(|(_, g)| g.parent.as_deref() == Some(id))
        .map(|(child, _)| 1 + subtree_height(groups, child, guard + 1))
        .max()
        .unwrap_or(0)
}

/// `Parent/Child` names of a group, for display and search.
pub(crate) fn group_path(groups: &GroupIndex<'_>, id: Option<&str>) -> String {
    let mut names: Vec<&str> = chain(groups, id).iter().map(|g| g.name.as_str()).collect();
    names.reverse();
    names.join("/")
}

/// One parsed search query: every term must match.
pub(crate) struct Query {
    terms: Vec<Term>,
}

enum Term {
    /// Matches label, address, user name, a tag or the group path (case-insensitive substring).
    Any(String),
    /// `tag:name`: a tag equal to name (case-insensitive).
    Tag(String),
    /// `group:name`: the group path contains name.
    Group(String),
}

impl Query {
    pub(crate) fn parse(text: &str) -> Self {
        let terms = text
            .split_whitespace()
            .map(|word| {
                let lower = word.to_lowercase();
                if let Some(tag) = lower.strip_prefix("tag:") {
                    Term::Tag(tag.to_owned())
                } else if let Some(group) = lower.strip_prefix("group:") {
                    Term::Group(group.to_owned())
                } else {
                    Term::Any(lower)
                }
            })
            .collect();
        Self { terms }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// `fields` are label, address, user name; `group_path` is already lower-case.
    pub(crate) fn matches(&self, fields: [&str; 3], tags: &[String], group_path: &str) -> bool {
        self.terms.iter().all(|term| match term {
            Term::Tag(t) => tags.iter().any(|tag| tag.to_lowercase() == *t),
            Term::Group(g) => group_path.contains(g.as_str()),
            Term::Any(word) => {
                fields.iter().any(|f| f.to_lowercase().contains(word.as_str()))
                    || tags.iter().any(|tag| tag.to_lowercase().contains(word.as_str()))
                    || group_path.contains(word.as_str())
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(name: &str, parent: Option<&str>) -> GroupRecord {
        GroupRecord {
            name: name.into(),
            parent: parent.map(Into::into),
            username: None,
            port: None,
            key_id: None,
            production: false,
        }
    }

    #[test]
    fn placement_refuses_cycles_missing_parents_and_depth() {
        let a = group("a", None);
        let b = group("b", Some("A"));
        let c = group("c", Some("B"));
        let groups: GroupIndex<'_> = [("A".to_owned(), &a), ("B".to_owned(), &b), ("C".to_owned(), &c)].into();
        assert!(check_placement(&groups, Some("A"), Some("C")).is_err_and(|e| matches!(e, TreeError::Cycle)));
        assert!(check_placement(&groups, Some("A"), Some("A")).is_err_and(|e| matches!(e, TreeError::Cycle)));
        assert!(check_placement(&groups, None, Some("Z")).is_err_and(|e| matches!(e, TreeError::MissingParent)));
        assert!(check_placement(&groups, Some("C"), Some("A")).is_ok());
        assert!(check_placement(&groups, None, None).is_ok());

        // A chain exactly MAX_GROUP_DEPTH long is allowed; one more level is not.
        let records: Vec<GroupRecord> =
            (0..MAX_GROUP_DEPTH).map(|i| group("g", (i > 0).then(|| format!("{}", i - 1)).as_deref())).collect();
        let deep: GroupIndex<'_> = records.iter().enumerate().map(|(i, g)| (i.to_string(), g)).collect();
        assert!(check_placement(&deep, None, Some(&(MAX_GROUP_DEPTH - 1).to_string())).is_err());
        assert!(check_placement(&deep, None, Some(&(MAX_GROUP_DEPTH - 2).to_string())).is_ok());
        // Moving the root under another tree must account for the root's own descendants.
        let other = group("other", None);
        let mut with_other = deep.clone();
        with_other.insert("O".into(), &other);
        assert!(check_placement(&with_other, Some("0"), Some("O")).is_err_and(|e| matches!(e, TreeError::TooDeep)));
    }

    #[test]
    fn production_comes_from_the_host_or_any_group_above_it() {
        use tyrminal_contracts::ProductionSource;
        let mut top = group("top", None);
        let mid = group("mid", Some("T"));
        let leaf = group("leaf", Some("M"));
        let host = |group: Option<&str>, own: bool| HostRecord {
            label: "h".into(),
            address: "192.0.2.1".into(),
            port: 0,
            username: String::new(),
            auth: StoredAuth::AskPassword,
            group: group.map(Into::into),
            tags: Vec::new(),
            last_connected_at: None,
            protocol: tyrminal_contracts::HostProtocol::Ssh,
            terminal: tyrminal_contracts::HostTerminal::default(),
            forward_agent: false,
            production: own,
            connection: crate::records::StoredConnection::default(),
        };
        {
            let groups: GroupIndex<'_> =
                [("T".to_owned(), &top), ("M".to_owned(), &mid), ("L".to_owned(), &leaf)].into();
            assert_eq!(production(&groups, &host(Some("L"), false)), None);
            assert_eq!(production(&groups, &host(Some("L"), true)), Some(ProductionSource::Host));
            assert_eq!(production(&groups, &host(None, false)), None);
        }
        top.production = true;
        let groups: GroupIndex<'_> = [("T".to_owned(), &top), ("M".to_owned(), &mid), ("L".to_owned(), &leaf)].into();
        assert_eq!(production(&groups, &host(Some("L"), false)), Some(ProductionSource::Group));
        assert_eq!(production(&groups, &host(Some("L"), true)), Some(ProductionSource::Host));
        assert_eq!(production(&groups, &host(None, false)), None);
    }

    #[test]
    fn query_terms_all_have_to_match() {
        let q = Query::parse("db TAG:prod group:eu");
        let tags = vec!["Prod".to_owned(), "linux".to_owned()];
        assert!(q.matches(["db-1", "10.0.0.1", "admin"], &tags, "europe/eu-west"));
        assert!(!q.matches(["web-1", "10.0.0.1", "admin"], &tags, "europe/eu-west"));
        assert!(!q.matches(["db-1", "10.0.0.1", "admin"], &["staging".into()], "europe/eu-west"));
        assert!(Query::parse("   ").is_empty());
        // A bare word also matches tags and the group path.
        assert!(Query::parse("linux").matches(["x", "y", "z"], &tags, ""));
        assert!(Query::parse("west").matches(["x", "y", "z"], &[], "europe/eu-west"));
    }
}
