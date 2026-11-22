//! Trigger matching: which enabled workflows does an event start? Pure; the scheduler adds cooldown, dedup and loop guards.

use crate::{Trigger, Workflow, parse_hhmm};

/// What happened. `Battery.previous` is the reading before this one; a battery trigger fires only on the downward
/// crossing, so without a previous reading nothing fires (a first reading is not a crossing).
/// `Tick.previous` is the minute of the previous tick (so a skipped tick cannot skip a schedule) and `day` is any
/// number that changes every calendar day (for example days since the epoch).
#[derive(Debug, Clone, PartialEq)]
pub enum EventKind {
    AppFocused { app: String },
    AppLaunched { app: String },
    WorkspaceChanged,
    MonitorConnected,
    Battery { percent: u8, previous: Option<u8> },
    AcChanged,
    Tick { minutes_of_day: u32, previous: Option<u32>, day: u32 },
    NetworkChanged,
    ProfileChanged,
    Manual { workflow: String },
}

/// An event with a stable id (the source gives the same id when it replays) and, when a workflow's own action
/// caused it, the id of that workflow.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub id: String,
    pub kind: EventKind,
    pub origin: Option<String>,
}

impl Event {
    pub fn new(id: impl Into<String>, kind: EventKind) -> Event {
        Event { id: id.into(), kind, origin: None }
    }
    /// Tags the event as produced by `workflow_id`'s own action.
    pub fn from_workflow(mut self, workflow_id: impl Into<String>) -> Event {
        self.origin = Some(workflow_id.into());
        self
    }
}

fn norm(app: &str) -> String {
    let a = app.trim().to_lowercase();
    a.strip_suffix(".desktop").map(str::to_string).unwrap_or(a)
}

fn same_app(a: &str, b: &str) -> bool {
    !a.trim().is_empty() && norm(a) == norm(b)
}

/// True when `at` lies in the minutes after `previous` up to and including `now`, across midnight if the clock wrapped.
fn crossed(at: u32, previous: Option<u32>, now: u32) -> bool {
    match previous {
        None => at == now,
        Some(p) if p < now => p < at && at <= now,
        Some(p) if p > now => at > p || at <= now,
        Some(_) => false,
    }
}

fn fires(trigger: &Trigger, kind: &EventKind) -> bool {
    match (trigger, kind) {
        (Trigger::AppFocused { app }, EventKind::AppFocused { app: got }) => same_app(app, got),
        (Trigger::AppLaunched { app }, EventKind::AppLaunched { app: got }) => same_app(app, got),
        (Trigger::WorkspaceChanged, EventKind::WorkspaceChanged)
        | (Trigger::MonitorConnected, EventKind::MonitorConnected)
        | (Trigger::AcChanged, EventKind::AcChanged)
        | (Trigger::NetworkChanged, EventKind::NetworkChanged)
        | (Trigger::ProfileChanged, EventKind::ProfileChanged) => true,
        (Trigger::BatteryBelow { percent: limit }, EventKind::Battery { percent, previous }) => {
            percent < limit && previous.is_some_and(|p| p >= *limit)
        }
        (Trigger::Schedule { at }, EventKind::Tick { minutes_of_day, previous, .. }) => {
            parse_hhmm(at).is_some_and(|a| crossed(a, *previous, *minutes_of_day))
        }
        _ => false,
    }
}

/// The enabled workflows `event` starts, in input order. `Manual` events match only the named, enabled, manual workflow.
pub fn matching<'a>(workflows: &'a [Workflow], event: &Event) -> Vec<&'a Workflow> {
    workflows
        .iter()
        .filter(|w| w.enabled)
        .filter(|w| match &event.kind {
            EventKind::Manual { workflow } => matches!(w.trigger, Trigger::Manual) && &w.id == workflow,
            kind => fires(&w.trigger, kind),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wf(id: &str, trigger: serde_json::Value, enabled: bool) -> Workflow {
        serde_json::from_value(json!({"version":1,"id":id,"enabled":enabled,"trigger":trigger,
            "steps":[{"kind":"action","id":"a","name":"notify","args":{},"next":null}]}))
        .unwrap()
    }
    fn ids(v: Vec<&Workflow>) -> Vec<&str> {
        v.into_iter().map(|w| w.id.as_str()).collect()
    }
    fn ev(kind: EventKind) -> Event {
        Event::new("e1", kind)
    }

    #[test]
    fn app_names_match_case_insensitively_and_disabled_workflows_never_fire() {
        let ws = vec![
            wf("a", json!({"type":"app_focused","app":"Code"}), true),
            wf("b", json!({"type":"app_focused","app":"code"}), false),
            wf("c", json!({"type":"app_launched","app":"code"}), true),
            wf("d", json!({"type":"app_focused","app":"firefox"}), true),
        ];
        assert_eq!(ids(matching(&ws, &ev(EventKind::AppFocused { app: "CODE".into() }))), ["a"]);
        assert_eq!(ids(matching(&ws, &ev(EventKind::AppFocused { app: "code.desktop".into() }))), ["a"]);
        assert_eq!(ids(matching(&ws, &ev(EventKind::AppLaunched { app: "code".into() }))), ["c"]);
        assert!(matching(&ws, &ev(EventKind::AppFocused { app: "".into() })).is_empty());
    }

    #[test]
    fn simple_events_match_their_trigger_only() {
        let ws = vec![
            wf("ws", json!({"type":"workspace_changed"}), true),
            wf("mon", json!({"type":"monitor_connected"}), true),
            wf("ac", json!({"type":"ac_changed"}), true),
            wf("net", json!({"type":"network_changed"}), true),
            wf("prof", json!({"type":"profile_changed"}), true),
        ];
        assert_eq!(ids(matching(&ws, &ev(EventKind::WorkspaceChanged))), ["ws"]);
        assert_eq!(ids(matching(&ws, &ev(EventKind::MonitorConnected))), ["mon"]);
        assert_eq!(ids(matching(&ws, &ev(EventKind::AcChanged))), ["ac"]);
        assert_eq!(ids(matching(&ws, &ev(EventKind::NetworkChanged))), ["net"]);
        assert_eq!(ids(matching(&ws, &ev(EventKind::ProfileChanged))), ["prof"]);
    }

    #[test]
    fn battery_fires_only_on_the_downward_crossing() {
        let ws = vec![wf("low", json!({"type":"battery_below","percent":20}), true)];
        let b = |percent, previous| ev(EventKind::Battery { percent, previous });
        assert_eq!(ids(matching(&ws, &b(19, Some(20)))), ["low"]);
        assert!(matching(&ws, &b(18, Some(19))).is_empty(), "already below: no repeat");
        assert!(matching(&ws, &b(25, Some(30))).is_empty());
        assert!(matching(&ws, &b(25, Some(10))).is_empty(), "charging upward is not a crossing");
        assert!(matching(&ws, &b(10, None)).is_empty(), "no previous reading");
        assert!(matching(&ws, &b(20, Some(21))).is_empty(), "equal is not below");
    }

    #[test]
    fn a_schedule_fires_at_its_minute_and_survives_a_skipped_tick() {
        let ws = vec![wf("s", json!({"type":"schedule","at":"09:00"}), true)];
        let t = |m, p| ev(EventKind::Tick { minutes_of_day: m, previous: p, day: 1 });
        assert_eq!(ids(matching(&ws, &t(540, Some(539)))), ["s"]);
        assert!(matching(&ws, &t(540, Some(540))).is_empty(), "duplicate tick");
        assert!(matching(&ws, &t(541, Some(540))).is_empty());
        assert_eq!(ids(matching(&ws, &t(542, Some(538)))), ["s"], "a missed tick still fires");
        assert_eq!(ids(matching(&ws, &t(540, None))), ["s"]);
        assert!(matching(&ws, &t(539, None)).is_empty());
        let midnight = vec![wf("m", json!({"type":"schedule","at":"00:00"}), true)];
        assert_eq!(ids(matching(&midnight, &t(0, Some(1439)))), ["m"]);
        assert_eq!(ids(matching(&midnight, &t(1, Some(1438)))), ["m"], "across the wrap");
    }

    #[test]
    fn manual_runs_only_the_named_enabled_manual_workflow() {
        let ws = vec![
            wf("m1", json!({"type":"manual"}), true),
            wf("m2", json!({"type":"manual"}), true),
            wf("off", json!({"type":"manual"}), false),
            wf("auto", json!({"type":"workspace_changed"}), true),
        ];
        assert_eq!(ids(matching(&ws, &ev(EventKind::Manual { workflow: "m2".into() }))), ["m2"]);
        assert!(matching(&ws, &ev(EventKind::Manual { workflow: "off".into() })).is_empty());
        assert!(matching(&ws, &ev(EventKind::Manual { workflow: "auto".into() })).is_empty());
    }
}
