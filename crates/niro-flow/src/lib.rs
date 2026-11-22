//! Niro Flow core (vNext S4): the workflow schema, its validator, a dry-run planner and an executor that calls
//! typed registry actions through a callback. No I/O, no shell, no threads: the daemon owns scheduling and D-Bus.
//!
//! A workflow is a graph of steps linked by `next` / `then` / `else`. It must be acyclic, so a workflow cannot loop;
//! the total delay on any path and the number of steps are capped. An action is only a registry action name plus
//! scalar arguments: there is no "run this command" step.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

pub mod history;
pub mod permissions;
pub mod scheduler;
pub mod templates;
pub mod triggers;

pub use history::{ExecutionHistory, RunRecord, RunStatus, StepRecord};
pub use permissions::{AllowListPolicy, CAPABILITIES, Capability, Decision, PermissionEvaluator, StaticPolicy, capability_for, run_checked};
pub use scheduler::{Job, Scheduler, SchedulerConfig, SkipReason, Skipped, StopReason};
pub use templates::{TEMPLATES, TEMPLATE_ACTIONS, Template, template};
pub use triggers::{Event as TriggerEvent, EventKind, matching};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_STEPS: usize = 64;
pub const MAX_PATH_DELAY_SECS: u64 = 3600;
const MAX_EXPR_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Workflow {
    pub version: u32,
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
    /// This workflow's own allow list, the only thing that lets a run act: capability labels (`"settings"`,
    /// `"window"`, ...) or exact action ids (`"profile.apply"`). Empty means every action is denied.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Trigger {
    Manual,
    AppFocused { app: String },
    AppLaunched { app: String },
    WorkspaceChanged,
    MonitorConnected,
    BatteryBelow { percent: u8 },
    AcChanged,
    Schedule { at: String },
    NetworkChanged,
    ProfileChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    Action { id: String, name: String, #[serde(default)] args: Map<String, Value>, next: Option<String> },
    Condition { id: String, expr: Expr, then: Option<String>, r#else: Option<String> },
    Delay { id: String, seconds: u64, next: Option<String> },
    Set { id: String, var: String, value: Value, next: Option<String> },
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Action { id, .. } | Step::Condition { id, .. } | Step::Delay { id, .. } | Step::Set { id, .. } => id,
        }
    }
    fn nexts(&self) -> Vec<&str> {
        match self {
            Step::Action { next, .. } | Step::Delay { next, .. } | Step::Set { next, .. } => next.as_deref().into_iter().collect(),
            Step::Condition { then, r#else, .. } => then.as_deref().into_iter().chain(r#else.as_deref()).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Expr {
    And { of: Vec<Expr> },
    Or { of: Vec<Expr> },
    Not { of: Box<Expr> },
    Eq { var: String, value: Value },
    Cmp { var: String, cmp: Ordering, value: f64 },
    /// Minutes of the day, "HH:MM"; may cross midnight.
    TimeRange { from: String, to: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Ordering {
    Lt,
    Le,
    Gt,
    Ge,
}

pub fn parse(text: &str) -> Result<Workflow, String> {
    serde_json::from_str(text).map_err(|e| format!("not a valid workflow: {e}"))
}

pub(crate) fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (s.len() == 5 && h < 24 && m < 60).then_some(h * 60 + m)
}

fn id_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn expr_problems(e: &Expr, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_EXPR_DEPTH {
        out.push("a condition is nested too deeply".into());
        return;
    }
    match e {
        Expr::And { of } | Expr::Or { of } => {
            if of.is_empty() {
                out.push("and/or needs at least one condition".into());
            }
            of.iter().for_each(|x| expr_problems(x, depth + 1, out));
        }
        Expr::Not { of } => expr_problems(of, depth + 1, out),
        Expr::Eq { var, .. } | Expr::Cmp { var, .. } if !id_ok(var) => out.push(format!("variable name \"{var}\" is not valid")),
        Expr::Cmp { value, .. } if !value.is_finite() => out.push("comparison value must be a number".into()),
        Expr::TimeRange { from, to } if parse_hhmm(from).is_none() || parse_hhmm(to).is_none() => {
            out.push("time range needs HH:MM".into())
        }
        _ => {}
    }
}

/// Everything wrong with `wf`, in words; empty means it may be saved and run. `known_actions` are the registry's action names.
pub fn validate(wf: &Workflow, known_actions: &[&str]) -> Vec<String> {
    let mut p = Vec::new();
    if wf.version != SCHEMA_VERSION {
        p.push(format!("version {} is not supported (expected {SCHEMA_VERSION})", wf.version));
    }
    if !id_ok(&wf.id) {
        p.push("workflow id must be 1 to 64 letters, digits, dot, dash or underscore".into());
    }
    match &wf.trigger {
        Trigger::BatteryBelow { percent } if !(1..=100).contains(percent) => p.push("battery percent must be 1 to 100".into()),
        Trigger::Schedule { at } if parse_hhmm(at).is_none() => p.push("schedule needs HH:MM".into()),
        Trigger::AppFocused { app } | Trigger::AppLaunched { app } if app.trim().is_empty() => p.push("trigger app is empty".into()),
        _ => {}
    }
    if wf.allow.len() > 32 {
        p.push("the allow list has more than 32 entries".into());
    }
    for entry in &wf.allow {
        if !permissions::allow_entry_ok(entry) {
            p.push(format!("allow entry \"{entry}\" is neither a capability nor an action id"));
        }
    }
    if wf.steps.is_empty() {
        p.push("a workflow needs at least one step".into());
    }
    if wf.steps.len() > MAX_STEPS {
        p.push(format!("more than {MAX_STEPS} steps"));
        return p;
    }
    let ids: HashSet<&str> = wf.steps.iter().map(Step::id).collect();
    if ids.len() != wf.steps.len() {
        p.push("step ids must be unique".into());
    }
    for s in &wf.steps {
        if !id_ok(s.id()) {
            p.push(format!("step id \"{}\" is not valid", s.id()));
        }
        for n in s.nexts() {
            if !ids.contains(n) {
                p.push(format!("step \"{}\" points at \"{n}\", which does not exist", s.id()));
            }
        }
        match s {
            Step::Action { name, args, id, .. } => {
                if !known_actions.contains(&name.as_str()) {
                    p.push(format!("step \"{id}\": \"{name}\" is not a registered action"));
                }
                if args.len() > 16 || args.values().any(|v| v.is_object() || v.is_array() || v.to_string().len() > 1024) {
                    p.push(format!("step \"{id}\": arguments must be a few plain values"));
                }
            }
            Step::Condition { expr, .. } => expr_problems(expr, 0, &mut p),
            Step::Delay { seconds, id, .. } if *seconds == 0 || *seconds > MAX_PATH_DELAY_SECS => {
                p.push(format!("step \"{id}\": delay must be 1 to {MAX_PATH_DELAY_SECS} seconds"))
            }
            Step::Set { var, id, value, .. } if !id_ok(var) || value.is_object() || value.is_array() => {
                p.push(format!("step \"{id}\": set needs a variable name and a plain value"))
            }
            _ => {}
        }
    }
    if p.iter().any(|m| m.contains("does not exist") || m.contains("unique")) {
        return p;
    }
    // Acyclic (no loops) and reachable from the first step; the longest delay on any path is capped.
    let by_id: HashMap<&str, &Step> = wf.steps.iter().map(|s| (s.id(), s)).collect();
    let mut state: HashMap<&str, u8> = HashMap::new(); // 1 = on the stack, 2 = done
    let mut worst: HashMap<&str, u64> = HashMap::new();
    fn walk<'a>(id: &'a str, by: &HashMap<&'a str, &'a Step>, st: &mut HashMap<&'a str, u8>, worst: &mut HashMap<&'a str, u64>, p: &mut Vec<String>) -> u64 {
        match st.get(id) {
            Some(1) => {
                p.push(format!("step \"{id}\" leads back to itself: a workflow may not loop"));
                return 0;
            }
            Some(2) => return worst[id],
            _ => {}
        }
        st.insert(id, 1);
        let s = by[id];
        let own = if let Step::Delay { seconds, .. } = s { *seconds } else { 0 };
        let below = s.nexts().into_iter().map(|n| walk(n, by, st, worst, p)).max().unwrap_or(0);
        st.insert(id, 2);
        worst.insert(id, own + below);
        own + below
    }
    if let Some(first) = wf.steps.first() {
        let total = walk(first.id(), &by_id, &mut state, &mut worst, &mut p);
        if total > MAX_PATH_DELAY_SECS {
            p.push(format!("delays on one path add up to {total} s (limit {MAX_PATH_DELAY_SECS})"));
        }
        for s in &wf.steps {
            if !state.contains_key(s.id()) {
                p.push(format!("step \"{}\" can never be reached", s.id()));
            }
        }
    }
    p
}

/// Variables a run starts with (trigger data, the active profile, ...) and are changed by `set` steps.
pub type Vars = HashMap<String, Value>;

pub fn eval(e: &Expr, vars: &Vars, minutes_of_day: u32) -> bool {
    match e {
        Expr::And { of } => of.iter().all(|x| eval(x, vars, minutes_of_day)),
        Expr::Or { of } => of.iter().any(|x| eval(x, vars, minutes_of_day)),
        Expr::Not { of } => !eval(of, vars, minutes_of_day),
        Expr::Eq { var, value } => vars.get(var).is_some_and(|v| v == value),
        Expr::Cmp { var, cmp, value } => vars.get(var).and_then(Value::as_f64).is_some_and(|v| match cmp {
            Ordering::Lt => v < *value,
            Ordering::Le => v <= *value,
            Ordering::Gt => v > *value,
            Ordering::Ge => v >= *value,
        }),
        Expr::TimeRange { from, to } => match (parse_hhmm(from), parse_hhmm(to)) {
            (Some(f), Some(t)) if f <= t => minutes_of_day >= f && minutes_of_day < t,
            (Some(f), Some(t)) => minutes_of_day >= f || minutes_of_day < t,
            _ => false,
        },
    }
}

/// Argument names that look like secrets are never shown or logged.
pub fn redact(args: &Map<String, Value>) -> Map<String, Value> {
    const HINTS: [&str; 6] = ["token", "password", "passphrase", "secret", "key", "credential"];
    args.iter()
        .map(|(k, v)| {
            let lower = k.to_lowercase();
            (k.clone(), if HINTS.iter().any(|h| lower.contains(h)) { Value::String("***".into()) } else { v.clone() })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Planned {
    Action { step: String, name: String, args: Map<String, Value> },
    Wait { step: String, seconds: u64 },
    Branch { step: String, taken: bool },
}

/// What a run would do, without doing it. Arguments are already redacted.
pub fn plan(wf: &Workflow, vars: &Vars, minutes_of_day: u32) -> Vec<Planned> {
    let mut out = Vec::new();
    walk_steps(wf, vars.clone(), minutes_of_day, |ev| {
        out.push(match ev {
            Event::Action { step, name, args } => Planned::Action { step: step.into(), name: name.into(), args: redact(args) },
            Event::Wait { step, seconds } => Planned::Wait { step: step.into(), seconds },
            Event::Branch { step, taken } => Planned::Branch { step: step.into(), taken },
        });
        Ok(())
    });
    out
}

enum Event<'a> {
    Action { step: &'a str, name: &'a str, args: &'a Map<String, Value> },
    Wait { step: &'a str, seconds: u64 },
    Branch { step: &'a str, taken: bool },
}

/// What the next step of a walk asks the caller to do. `Set` steps and the choice of branch are handled inside.
#[derive(Debug, Clone, PartialEq)]
pub enum Next {
    Action { step: String, name: String, args: Map<String, Value> },
    Wait { step: String, seconds: u64 },
    Branch { step: String, taken: bool },
    Done,
    /// The walk cannot go on (unknown step, step budget spent).
    Stuck(String),
}

/// Walks a workflow one step at a time, so a caller that awaits (the daemon) can run actions and sleeps itself while
/// the order, the branches and the variables stay this crate's. `run` and `plan` are built on it.
pub struct Stepper<'a> {
    by_id: HashMap<&'a str, &'a Step>,
    cur: Option<&'a str>,
    vars: Vars,
    minutes: u32,
    budget: usize,
}

impl<'a> Stepper<'a> {
    pub fn new(wf: &'a Workflow, vars: &Vars, minutes: u32) -> Stepper<'a> {
        Stepper {
            by_id: wf.steps.iter().map(|s| (s.id(), s)).collect(),
            cur: wf.steps.first().map(Step::id),
            vars: vars.clone(),
            minutes,
            budget: MAX_STEPS * 2,
        }
    }

    /// The step to do now; the walk has already moved past it.
    pub fn next_step(&mut self) -> Next {
        loop {
            let Some(id) = self.cur else { return Next::Done };
            if self.budget == 0 {
                self.cur = None;
                return Next::Stuck("step budget exhausted".into());
            }
            self.budget -= 1;
            let Some(step) = self.by_id.get(id).copied() else {
                self.cur = None;
                return Next::Stuck(format!("unknown step {id}"));
            };
            match step {
                Step::Action { id, name, args, next } => {
                    self.cur = next.as_deref();
                    return Next::Action { step: id.clone(), name: name.clone(), args: args.clone() };
                }
                Step::Delay { id, seconds, next } => {
                    self.cur = next.as_deref();
                    return Next::Wait { step: id.clone(), seconds: *seconds };
                }
                Step::Set { var, value, next, .. } => {
                    self.vars.insert(var.clone(), value.clone());
                    self.cur = next.as_deref();
                }
                Step::Condition { id, expr, then, r#else } => {
                    let taken = eval(expr, &self.vars, self.minutes);
                    self.cur = if taken { then.as_deref() } else { r#else.as_deref() };
                    return Next::Branch { step: id.clone(), taken };
                }
            }
        }
    }
}

/// Returns the error that stopped the walk, if any. A defensive step budget backs up the validator's acyclic check.
fn walk_steps(wf: &Workflow, vars: Vars, minutes: u32, mut on: impl FnMut(Event<'_>) -> Result<(), String>) -> Option<String> {
    let mut stepper = Stepper::new(wf, &vars, minutes);
    loop {
        match stepper.next_step() {
            Next::Done => return None,
            Next::Stuck(why) => return Some(why),
            Next::Action { step, name, args } => {
                if let Err(e) = on(Event::Action { step: &step, name: &name, args: &args }) {
                    return Some(format!("step \"{step}\": {e}"));
                }
            }
            Next::Wait { step, seconds } => {
                if let Err(e) = on(Event::Wait { step: &step, seconds }) {
                    return Some(format!("step \"{step}\": {e}"));
                }
            }
            Next::Branch { step, taken } => {
                let _ = on(Event::Branch { step: &step, taken });
            }
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Report {
    pub done: Vec<String>,
    pub error: Option<String>,
}

/// Runs the workflow: `act(name, args)` performs a registry action (the caller checks permission there), `wait(seconds)` sleeps.
/// Stops at the first error and says which step failed. Nothing runs twice from here: see `Ledger` for restarts.
pub fn run(wf: &Workflow, vars: &Vars, minutes: u32, mut act: impl FnMut(&str, &Map<String, Value>) -> Result<(), String>, mut wait: impl FnMut(u64)) -> Report {
    let mut done = Vec::new();
    let error = walk_steps(wf, vars.clone(), minutes, |ev| match ev {
        Event::Action { step, name, args } => act(name, args).map(|_| done.push(step.to_string())),
        Event::Wait { step, seconds } => {
            wait(seconds);
            done.push(step.to_string());
            Ok(())
        }
        Event::Branch { step, .. } => {
            done.push(step.to_string());
            Ok(())
        }
    });
    Report { done, error }
}

/// Remembers which (workflow, event) pairs already ran, so a daemon restart that replays an event does not run it twice.
/// Bounded, oldest first out; `to_json` / `from_json` carry it across restarts.
#[derive(Debug, Default)]
pub struct Ledger {
    order: VecDeque<String>,
    seen: HashSet<String>,
}

const LEDGER_MAX: usize = 1000;

impl Ledger {
    /// True the first time `key` is claimed.
    pub fn claim(&mut self, key: &str) -> bool {
        if !self.seen.insert(key.to_string()) {
            return false;
        }
        self.order.push_back(key.to_string());
        while self.order.len() > LEDGER_MAX {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.order).unwrap_or_else(|_| "[]".into())
    }
    pub fn from_json(text: &str) -> Ledger {
        let mut l = Ledger::default();
        for k in serde_json::from_str::<Vec<String>>(text).unwrap_or_default() {
            l.claim(&k);
        }
        l
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ACTIONS: [&str; 4] = ["profile.apply", "dnd.set", "notify", "layout.apply"];

    fn wf(v: Value) -> Workflow {
        serde_json::from_value(v).unwrap()
    }

    fn good() -> Workflow {
        wf(json!({"version":1,"id":"coding","trigger":{"type":"app_focused","app":"code"},"steps":[
            {"kind":"condition","id":"c","expr":{"op":"time_range","from":"08:00","to":"18:00"},"then":"a","else":"n"},
            {"kind":"action","id":"a","name":"profile.apply","args":{"name":"Deep Work"},"next":"d"},
            {"kind":"delay","id":"d","seconds":5,"next":"x"},
            {"kind":"action","id":"x","name":"dnd.set","args":{"on":true,"api_token":"hunter2"},"next":null},
            {"kind":"action","id":"n","name":"notify","args":{"text":"after hours"},"next":null}]}))
    }

    #[test]
    fn a_good_workflow_validates() {
        assert_eq!(validate(&good(), &ACTIONS), Vec::<String>::new());
    }

    #[test]
    fn invalid_workflows_are_refused_with_reasons() {
        let mut w = good();
        w.version = 9;
        assert!(validate(&w, &ACTIONS)[0].contains("version 9"));
        assert!(validate(&good(), &["notify"]).iter().any(|m| m.contains("not a registered action")));
        let looped = wf(json!({"version":1,"id":"l","trigger":{"type":"manual"},"steps":[
            {"kind":"action","id":"a","name":"notify","args":{},"next":"b"},
            {"kind":"action","id":"b","name":"notify","args":{},"next":"a"}]}));
        assert!(validate(&looped, &ACTIONS).iter().any(|m| m.contains("may not loop")));
        let dangling = wf(json!({"version":1,"id":"l","trigger":{"type":"manual"},"steps":[{"kind":"action","id":"a","name":"notify","args":{},"next":"zz"}]}));
        assert!(validate(&dangling, &ACTIONS).iter().any(|m| m.contains("does not exist")));
        let slow = wf(json!({"version":1,"id":"l","trigger":{"type":"manual"},"steps":[
            {"kind":"delay","id":"a","seconds":3000,"next":"b"},{"kind":"delay","id":"b","seconds":1000,"next":null}]}));
        assert!(validate(&slow, &ACTIONS).iter().any(|m| m.contains("add up")));
        let orphan = wf(json!({"version":1,"id":"l","trigger":{"type":"manual"},"steps":[
            {"kind":"action","id":"a","name":"notify","args":{},"next":null},{"kind":"action","id":"b","name":"notify","args":{},"next":null}]}));
        assert!(validate(&orphan, &ACTIONS).iter().any(|m| m.contains("never be reached")));
        let nested = wf(json!({"version":1,"id":"l","trigger":{"type":"manual"},"steps":[
            {"kind":"action","id":"a","name":"notify","args":{"x":{"y":1}},"next":null}]}));
        assert!(validate(&nested, &ACTIONS).iter().any(|m| m.contains("plain values")));
    }

    #[test]
    fn a_shell_step_cannot_even_be_parsed() {
        assert!(parse(r#"{"version":1,"id":"x","trigger":{"type":"manual"},"steps":[{"kind":"shell","id":"a","cmd":"rm -rf /"}]}"#).is_err());
        assert!(parse("garbage").is_err());
    }

    #[test]
    fn conditions_and_or_not_compare_and_time() {
        let mut v = Vars::new();
        v.insert("battery".into(), json!(15));
        v.insert("profile".into(), json!("gaming"));
        let e = Expr::And { of: vec![
            Expr::Cmp { var: "battery".into(), cmp: Ordering::Lt, value: 20.0 },
            Expr::Not { of: Box::new(Expr::Eq { var: "profile".into(), value: json!("meeting") }) },
        ]};
        assert!(eval(&e, &v, 0));
        assert!(!eval(&Expr::Cmp { var: "missing".into(), cmp: Ordering::Lt, value: 1.0 }, &v, 0));
        let night = Expr::TimeRange { from: "22:00".into(), to: "06:00".into() };
        assert!(eval(&night, &v, 23 * 60) && eval(&night, &v, 5 * 60) && !eval(&night, &v, 12 * 60));
    }

    #[test]
    fn dry_run_follows_the_branch_and_hides_secrets() {
        let p = plan(&good(), &Vars::new(), 9 * 60);
        assert_eq!(p.len(), 4);
        assert!(matches!(&p[0], Planned::Branch { taken: true, .. }));
        assert!(matches!(&p[2], Planned::Wait { seconds: 5, .. }));
        let Planned::Action { args, .. } = &p[3] else { panic!() };
        assert_eq!(args["api_token"], json!("***"));
        assert_eq!(args["on"], json!(true));
        let p = plan(&good(), &Vars::new(), 20 * 60);
        assert!(matches!(&p[1], Planned::Action { name, .. } if name == "notify"));
    }

    #[test]
    fn run_executes_in_order_and_stops_at_the_first_error() {
        let mut seen = Vec::new();
        let mut waited = 0;
        let r = run(&good(), &Vars::new(), 9 * 60, |n, _| { seen.push(n.to_string()); Ok(()) }, |s| waited += s);
        assert_eq!(seen, ["profile.apply", "dnd.set"]);
        assert_eq!(waited, 5);
        assert_eq!(r.error, None);
        let r = run(&good(), &Vars::new(), 9 * 60, |n, _| if n == "dnd.set" { Err("denied".into()) } else { Ok(()) }, |_| {});
        assert_eq!(r.error.as_deref(), Some("step \"x\": denied"));
        assert_eq!(r.done, ["c", "a", "d"]);
    }

    #[test]
    fn the_stepper_walks_in_order_and_follows_branches_and_sets() {
        let g = good();
        let mut st = Stepper::new(&g, &Vars::new(), 9 * 60);
        assert_eq!(st.next_step(), Next::Branch { step: "c".into(), taken: true });
        assert!(matches!(st.next_step(), Next::Action { name, .. } if name == "profile.apply"));
        assert_eq!(st.next_step(), Next::Wait { step: "d".into(), seconds: 5 });
        assert!(matches!(st.next_step(), Next::Action { name, .. } if name == "dnd.set"));
        assert_eq!(st.next_step(), Next::Done);
        assert_eq!(st.next_step(), Next::Done);
        let w = wf(json!({"version":1,"id":"s","trigger":{"type":"manual"},"steps":[
            {"kind":"set","id":"s","var":"mode","value":"focus","next":"c"},
            {"kind":"condition","id":"c","expr":{"op":"eq","var":"mode","value":"focus"},"then":"a","else":null},
            {"kind":"action","id":"a","name":"notify","args":{},"next":null}]}));
        let mut st = Stepper::new(&w, &Vars::new(), 0);
        assert_eq!(st.next_step(), Next::Branch { step: "c".into(), taken: true });
        assert!(matches!(st.next_step(), Next::Action { .. }));
    }

    #[test]
    fn the_allow_list_is_checked_and_absent_means_nothing_is_allowed() {
        assert!(good().allow.is_empty());
        let mut w = good();
        w.allow = vec!["settings".into(), "profile.apply".into()];
        assert_eq!(validate(&w, &ACTIONS), Vec::<String>::new());
        w.allow = vec!["rm -rf /".into()];
        assert!(validate(&w, &ACTIONS).iter().any(|m| m.contains("allow entry")));
        assert!(!serde_json::to_string(&good()).unwrap().contains("allow"), "an empty list is not written");
    }

    #[test]
    fn set_steps_feed_later_conditions() {
        let w = wf(json!({"version":1,"id":"s","trigger":{"type":"manual"},"steps":[
            {"kind":"set","id":"s","var":"mode","value":"focus","next":"c"},
            {"kind":"condition","id":"c","expr":{"op":"eq","var":"mode","value":"focus"},"then":"a","else":null},
            {"kind":"action","id":"a","name":"notify","args":{},"next":null}]}));
        assert_eq!(validate(&w, &ACTIONS), Vec::<String>::new());
        assert!(plan(&w, &Vars::new(), 0).iter().any(|p| matches!(p, Planned::Action { .. })));
    }

    #[test]
    fn the_ledger_refuses_a_replayed_event_and_survives_a_restart() {
        let mut l = Ledger::default();
        assert!(l.claim("coding|evt-1"));
        assert!(!l.claim("coding|evt-1"));
        let mut again = Ledger::from_json(&l.to_json());
        assert!(!again.claim("coding|evt-1"));
        assert!(again.claim("coding|evt-2"));
        for i in 0..1100 {
            again.claim(&format!("k{i}"));
        }
        assert!(again.order.len() <= 1000);
        assert!(Ledger::from_json("junk").claim("a"));
    }
}
