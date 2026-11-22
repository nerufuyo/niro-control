//! Permission gate for workflow actions. An action name maps to one capability by prefix; the caller's evaluator
//! decides allow, deny or ask before each action runs. An action with no capability is denied.

use crate::{Report, Vars, Workflow, run};
use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Capability {
    Launch,
    Window,
    Clipboard,
    Notifications,
    Network,
    /// Profiles, do-not-disturb and similar desktop settings.
    Settings,
}

impl Capability {
    pub fn label(self) -> &'static str {
        match self {
            Capability::Launch => "launch",
            Capability::Window => "window",
            Capability::Clipboard => "clipboard",
            Capability::Notifications => "notifications",
            Capability::Network => "network",
            Capability::Settings => "settings",
        }
    }
}

/// Every capability, for allow lists.
pub const CAPABILITIES: [Capability; 6] = [
    Capability::Launch,
    Capability::Window,
    Capability::Clipboard,
    Capability::Notifications,
    Capability::Network,
    Capability::Settings,
];

/// The capability an action needs, or `None` for an unknown action (which must be denied).
/// The names are those of Search's real action registry (`app.launch`, `profile.apply`, `system.dnd.toggle`, ...);
/// the older prefixes stay for hosts that name theirs that way. Power, session, process and file actions
/// (`system.shutdown`, `process.kill`, `file.open`, `ha.call`, ...) deliberately have no capability: Flow never runs them.
pub fn capability_for(action: &str) -> Option<Capability> {
    const TABLE: [(&str, Capability); 11] = [
        ("app.", Capability::Launch),
        ("window.", Capability::Window),
        ("layout.", Capability::Window),
        ("clipboard.", Capability::Clipboard),
        ("net.", Capability::Network),
        ("url.", Capability::Network),
        ("profile.", Capability::Settings),
        ("dnd.", Capability::Settings),
        ("system.dnd.", Capability::Settings),
        ("system.network.", Capability::Network),
        ("system.vpn.", Capability::Network),
    ];
    const EXACT: [(&str, Capability); 7] = [
        ("system.wifi.toggle", Capability::Network),
        ("system.bluetooth.toggle", Capability::Network),
        ("system.nightlight.toggle", Capability::Settings),
        ("system.presentation.toggle", Capability::Settings),
        ("system.mute.toggle", Capability::Settings),
        ("system.zoom.toggle", Capability::Settings),
        ("system.spotlight.toggle", Capability::Settings),
    ];
    if action == "notify" || action.starts_with("notify.") {
        return Some(Capability::Notifications);
    }
    if let Some((_, c)) = EXACT.iter().find(|(a, _)| *a == action) {
        return Some(*c);
    }
    TABLE.iter().find(|(p, _)| action.starts_with(p) && action.len() > p.len()).map(|(_, c)| *c)
}

/// Whether an allow-list entry is a capability label or looks like an action id.
pub fn allow_entry_ok(entry: &str) -> bool {
    CAPABILITIES.iter().any(|c| c.label() == entry)
        || (!entry.is_empty()
            && entry.len() <= 64
            && entry.split('.').count() >= 2
            && entry.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny(String),
    /// The caller must put the question to the user.
    Ask,
}

pub trait PermissionEvaluator {
    fn evaluate(&mut self, workflow_id: &str, capability: Capability, action: &str) -> Decision;
}

/// The daemon's default policy: deny everything except what the workflow's own `allow` list names (a capability
/// label or an exact action id). It never asks, because nobody is at the desk when a trigger fires.
#[derive(Debug, Default)]
pub struct AllowListPolicy {
    allow: HashMap<String, Vec<String>>,
}

impl AllowListPolicy {
    pub fn for_workflow(wf: &Workflow) -> AllowListPolicy {
        AllowListPolicy { allow: HashMap::from([(wf.id.clone(), wf.allow.clone())]) }
    }
}

impl PermissionEvaluator for AllowListPolicy {
    fn evaluate(&mut self, workflow_id: &str, capability: Capability, action: &str) -> Decision {
        let listed = self.allow.get(workflow_id).is_some_and(|l| l.iter().any(|e| e == action || e == capability.label()));
        if listed { Decision::Allow } else { Decision::Deny("not in this workflow's allow list".into()) }
    }
}

/// A fixed policy: per-capability decisions, `Ask` for anything not listed.
#[derive(Debug, Default)]
pub struct StaticPolicy {
    rules: HashMap<Capability, Decision>,
}

impl StaticPolicy {
    pub fn with(mut self, capability: Capability, decision: Decision) -> StaticPolicy {
        self.rules.insert(capability, decision);
        self
    }
}

impl PermissionEvaluator for StaticPolicy {
    fn evaluate(&mut self, _: &str, capability: Capability, _: &str) -> Decision {
        self.rules.get(&capability).cloned().unwrap_or(Decision::Ask)
    }
}

/// `run()` with a permission check before every action. `ask(action, capability)` answers an `Ask` decision.
/// A refusal is the step's error, so the run stops there and `Report.error` says what was refused and why;
/// `act` is never called for it. Wait steps and branches need no permission.
pub fn run_checked(
    wf: &Workflow,
    vars: &Vars,
    minutes: u32,
    evaluator: &mut dyn PermissionEvaluator,
    mut ask: impl FnMut(&str, Capability) -> bool,
    mut act: impl FnMut(&str, &Map<String, Value>) -> Result<(), String>,
    wait: impl FnMut(u64),
) -> Report {
    run(
        wf,
        vars,
        minutes,
        |name, args| {
            let Some(cap) = capability_for(name) else {
                return Err(format!("permission denied: \"{name}\" has no known capability"));
            };
            match evaluator.evaluate(&wf.id, cap, name) {
                Decision::Allow => {}
                Decision::Deny(why) => return Err(format!("permission denied: {} ({why})", cap.label())),
                Decision::Ask if ask(name, cap) => {}
                Decision::Ask => return Err(format!("permission denied: {} (not allowed by the user)", cap.label())),
            }
            act(name, args)
        },
        wait,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wf() -> Workflow {
        serde_json::from_value(json!({"version":1,"id":"w","trigger":{"type":"manual"},"steps":[
            {"kind":"action","id":"a","name":"notify","args":{},"next":"b"},
            {"kind":"action","id":"b","name":"clipboard.clear","args":{},"next":"c"},
            {"kind":"action","id":"c","name":"layout.apply","args":{},"next":null}]}))
        .unwrap()
    }

    #[test]
    fn prefixes_map_to_capabilities_and_unknown_is_none() {
        use Capability::*;
        for (a, c) in [("app.launch", Launch), ("window.move", Window), ("layout.apply", Window), ("clipboard.clear", Clipboard),
            ("notify", Notifications), ("net.get", Network), ("url.open", Network), ("profile.apply", Settings), ("dnd.set", Settings)] {
            assert_eq!(capability_for(a), Some(c), "{a}");
        }
        for (a, c) in [("system.dnd.toggle", Settings), ("system.vpn.toggle", Network), ("system.nightlight.toggle", Settings),
            ("layout.restore", Window), ("window.activate", Window), ("clipboard.copy", Clipboard), ("system.network.speed", Network)] {
            assert_eq!(capability_for(a), Some(c), "{a}");
        }
        for a in ["system.shutdown", "system.logout", "system.lock", "process.kill", "file.open", "ha.call", "system.clean.trash", "system.dnd.", "todo.add"] {
            assert_eq!(capability_for(a), None, "{a}");
        }
        for a in ["shell.run", "notifyx", "app.", "", "apps.launch"] {
            assert_eq!(capability_for(a), None, "{a}");
        }
    }

    #[test]
    fn the_allow_list_policy_denies_by_default_and_allows_only_what_is_listed() {
        let mut w = wf();
        let mut none = AllowListPolicy::for_workflow(&w);
        assert!(matches!(none.evaluate("w", Capability::Settings, "profile.apply"), Decision::Deny(_)));
        w.allow = vec!["settings".into(), "layout.restore".into()];
        let mut p = AllowListPolicy::for_workflow(&w);
        assert_eq!(p.evaluate("w", Capability::Settings, "profile.apply"), Decision::Allow);
        assert_eq!(p.evaluate("w", Capability::Window, "layout.restore"), Decision::Allow);
        assert!(matches!(p.evaluate("w", Capability::Window, "window.activate"), Decision::Deny(_)));
        assert!(matches!(p.evaluate("other", Capability::Settings, "profile.apply"), Decision::Deny(_)));
        assert!(allow_entry_ok("settings") && allow_entry_ok("profile.apply") && !allow_entry_ok("rm -rf") && !allow_entry_ok(""));
    }

    #[test]
    fn allowed_actions_run_and_asks_go_to_the_callback() {
        let mut policy = StaticPolicy::default().with(Capability::Notifications, Decision::Allow).with(Capability::Window, Decision::Allow);
        let (mut asked, mut ran) = (Vec::new(), Vec::new());
        let r = run_checked(&wf(), &Vars::new(), 0, &mut policy, |n, _| { asked.push(n.to_string()); true }, |n, _| { ran.push(n.to_string()); Ok(()) }, |_| {});
        assert_eq!(r.error, None);
        assert_eq!(asked, ["clipboard.clear"]);
        assert_eq!(ran, ["notify", "clipboard.clear", "layout.apply"]);
    }

    #[test]
    fn a_denied_action_never_runs_and_is_the_step_error() {
        let mut policy = StaticPolicy::default().with(Capability::Notifications, Decision::Allow).with(Capability::Clipboard, Decision::Deny("blocked".into()));
        let mut ran = Vec::new();
        let r = run_checked(&wf(), &Vars::new(), 0, &mut policy, |_, _| true, |n, _| { ran.push(n.to_string()); Ok(()) }, |_| {});
        assert_eq!(ran, ["notify"]);
        assert_eq!(r.error.as_deref(), Some("step \"b\": permission denied: clipboard (blocked)"));
        assert_eq!(r.done, ["a"]);
    }

    #[test]
    fn declining_an_ask_stops_the_run() {
        let mut policy = StaticPolicy::default();
        let mut ran = 0;
        let r = run_checked(&wf(), &Vars::new(), 0, &mut policy, |_, _| false, |_, _| { ran += 1; Ok(()) }, |_| {});
        assert_eq!(ran, 0);
        assert!(r.error.unwrap().contains("not allowed by the user"));
    }

    #[test]
    fn an_unknown_action_is_denied_even_when_everything_else_is_allowed() {
        let w: Workflow = serde_json::from_value(json!({"version":1,"id":"w","trigger":{"type":"manual"},"steps":[
            {"kind":"action","id":"a","name":"shell.run","args":{},"next":null}]}))
        .unwrap();
        let mut policy = StaticPolicy::default().with(Capability::Launch, Decision::Allow);
        let mut ran = 0;
        let r = run_checked(&w, &Vars::new(), 0, &mut policy, |_, _| true, |_, _| { ran += 1; Ok(()) }, |_| {});
        assert_eq!(ran, 0);
        assert!(r.error.unwrap().contains("no known capability"));
    }

    #[test]
    fn a_denial_can_be_recorded_in_the_history() {
        use crate::history::{ExecutionHistory, RunStatus};
        let mut policy = StaticPolicy::default().with(Capability::Notifications, Decision::Deny("off".into()));
        let mut h = ExecutionHistory::default();
        let id = h.start("w", "e1", 0);
        let r = run_checked(&wf(), &Vars::new(), 0, &mut policy, |_, _| true, |_, _| Ok(()), |_| {});
        h.fail(id, 1, r.error.as_deref().unwrap());
        assert_eq!(h.get(id).unwrap().status, RunStatus::Error);
        assert!(h.get(id).unwrap().error.as_deref().unwrap().contains("permission denied"));
    }
}
