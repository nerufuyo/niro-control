// SPDX-License-Identifier: GPL-3.0-or-later

//! The Flow runtime without a bus: the workflow store, the scheduler, the ledger and history, and the runner that
//! turns an event into jobs and jobs into runs. Actions go through an [`Executor`] (in the daemon, Search's typed
//! action registry over D-Bus; in tests, a fake), so everything here is testable without D-Bus.
//!
//! Policy, in order, for every action step: the workflow's own allow list (default deny) -> the action must be in the
//! registry's list -> it must not ask for confirmation (Flow never confirms for anyone: such a step stops the run) ->
//! it must be available now -> its arguments must fit the registry's parameters -> only then is it run.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::{Datelike, Local, TimeZone, Timelike};
use log::{debug, info, warn};
use niro_flow::{
    AllowListPolicy, Decision, PermissionEvaluator, TriggerEvent as Event, EventKind, ExecutionHistory, Ledger, Next, Planned, Scheduler, SchedulerConfig, SkipReason,
    Stepper, Vars, Workflow, capability_for,
};
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, mpsc};

use super::files::{self, LoadProblem, Paths};

/// How often a waiting run looks at its cancel flag and deadline.
const POLL: Duration = Duration::from_millis(100);

/// One action of the registry, as `ListActions` describes it.
#[derive(Debug, Clone)]
pub struct ActionInfo {
    pub id: String,
    pub title: String,
    /// `none`, or `confirm`: the registry asks the user first.
    pub permission: String,
    pub available: bool,
    pub reason: Option<String>,
    pub params: Vec<Value>,
}

impl ActionInfo {
    pub fn from_value(v: &Value) -> Option<ActionInfo> {
        Some(ActionInfo {
            id: v["id"].as_str()?.to_owned(),
            title: v["title"].as_str().unwrap_or_default().to_owned(),
            permission: v["permission"].as_str().unwrap_or("confirm").to_owned(),
            available: v["available"].as_bool().unwrap_or(true),
            reason: v["reason"].as_str().map(str::to_owned),
            params: v["params"].as_array().cloned().unwrap_or_default(),
        })
    }

    /// Arguments checked as the registry checks them (names, required, types, enums, lengths and bounds).
    pub fn check_args(&self, args: &Map<String, Value>) -> Option<String> {
        let name_of = |p: &Value| p["name"].as_str().unwrap_or_default().to_owned();
        if let Some(key) = args.keys().find(|k| !self.params.iter().any(|p| name_of(p) == **k)) {
            return Some(format!("unknown argument \"{key}\""));
        }
        for p in &self.params {
            let name = name_of(p);
            let Some(v) = args.get(&name).filter(|v| !v.is_null()) else {
                if p["required"].as_bool().unwrap_or(false) {
                    return Some(format!("\"{name}\" is required"));
                }
                continue;
            };
            match p["type"].as_str().unwrap_or("string") {
                "string" => match v.as_str() {
                    None => return Some(format!("\"{name}\" must be text")),
                    Some(s) if s.chars().count() as u64 > p["maxLength"].as_u64().unwrap_or(2000) => return Some(format!("\"{name}\" is too long")),
                    _ => {}
                },
                "number" => match v.as_f64() {
                    None => return Some(format!("\"{name}\" must be a number")),
                    Some(n) if p["min"].as_f64().is_some_and(|m| n < m) => return Some(format!("\"{name}\" must be at least {}", p["min"])),
                    Some(n) if p["max"].as_f64().is_some_and(|m| n > m) => return Some(format!("\"{name}\" must be at most {}", p["max"])),
                    _ => {}
                },
                "boolean" if !v.is_boolean() => return Some(format!("\"{name}\" must be true or false")),
                "enum" if !v.as_str().is_some_and(|s| p["enum"].as_array().is_some_and(|e| e.iter().any(|x| x == s))) => {
                    return Some(format!("\"{name}\" must be one of the allowed values"));
                }
                _ => {}
            }
        }
        None
    }
}

/// Why an action did not do its work.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionError {
    /// The registry could not be reached or did not answer.
    Unavailable(String),
    /// The registry refused or the action failed (its code and message).
    Failed(String),
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActionError::Unavailable(s) | ActionError::Failed(s) => f.write_str(s),
        }
    }
}

/// The only way Flow acts on the desktop.
pub trait Executor: Send + Sync + 'static {
    fn manifest(&self) -> impl Future<Output = Result<Vec<ActionInfo>, String>> + Send;
    fn run(&self, id: &str, args: &Map<String, Value>) -> impl Future<Output = Result<String, ActionError>> + Send;
}

/// Wall and monotonic time, replaceable in tests.
pub struct Clock {
    start: tokio::time::Instant,
    wall: Box<dyn Fn() -> i64 + Send + Sync>,
    local: fn(i64) -> (u32, u32),
}

impl Clock {
    pub fn real() -> Clock {
        fn local(ms: i64) -> (u32, u32) {
            Local
                .timestamp_millis_opt(ms)
                .single()
                .map_or((0, 0), |t| (t.hour() * 60 + t.minute(), t.date_naive().num_days_from_ce().max(0) as u32))
        }
        Clock { start: tokio::time::Instant::now(), wall: Box::new(crate::clock::now_ms), local }
    }

    /// A clock that reads `wall` and treats it as UTC (no zone, no daylight saving).
    #[cfg(test)]
    pub fn fake(wall: impl Fn() -> i64 + Send + Sync + 'static) -> Clock {
        fn utc(ms: i64) -> (u32, u32) {
            let minutes = (ms.div_euclid(60_000).rem_euclid(1440)) as u32;
            (minutes, ms.div_euclid(86_400_000) as u32)
        }
        Clock { start: tokio::time::Instant::now(), wall: Box::new(wall), local: utc }
    }

    /// Monotonic milliseconds, for deadlines and cooldowns.
    pub fn mono_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
    pub fn wall_ms(&self) -> i64 {
        (self.wall)()
    }
    /// (minutes of the local day, a number that changes every local day) at `wall_ms`.
    pub fn local(&self, wall_ms: i64) -> (u32, u32) {
        (self.local)(wall_ms)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalKind {
    Started,
    Completed,
    Failed,
}

/// What the D-Bus object turns into `WorkflowStarted`, `WorkflowCompleted` and `WorkflowFailed`.
#[derive(Debug, Clone, PartialEq)]
pub struct FlowSignal {
    pub kind: SignalKind,
    pub workflow_id: String,
    pub run_id: String,
    pub message: String,
}

/// Something the desktop did that may start a workflow.
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    /// `id` is stable for the same stretch of use, so a re-report after a restart is not a new event.
    Focus { app: String, id: String },
    Battery { percent: u8, previous: Option<u8>, plugged: bool },
    Ac { plugged: bool },
    Network { connected: bool },
    /// The shell says the focus moved (`Notify("app-focus")`): immediate, so it replaces the late usage reports.
    FocusLive { app: String },
    Launched { app: String },
    Workspace { index: u32 },
    Monitor { count: u32, added: bool },
    Profile { name: String },
}

/// How long after the last live focus notification the late usage reports are ignored (so nothing fires twice).
const LIVE_FOCUS_WINDOW_MS: i64 = 600_000;

struct State {
    enabled: bool,
    workflows: Vec<Workflow>,
    problems: Vec<LoadProblem>,
    scheduler: Scheduler,
    history: ExecutionHistory,
    ctx: Vars,
    /// (day, minute) of the last tick.
    last_tick: Option<(u32, u32)>,
    /// History run id -> scheduler job id, for the runs in flight.
    jobs: HashMap<u64, u64>,
    manual_seq: u64,
    /// Wall time of the last `Input::FocusLive`; while recent, usage-report focus only updates the context.
    live_focus_at: Option<i64>,
}

struct Inner<E> {
    paths: Paths,
    exec: E,
    clock: Clock,
    state: Mutex<State>,
    signals: mpsc::UnboundedSender<FlowSignal>,
    wake: Notify,
}

pub struct Flow<E: Executor> {
    inner: Arc<Inner<E>>,
}

impl<E: Executor> Clone for Flow<E> {
    fn clone(&self) -> Self {
        Flow { inner: self.inner.clone() }
    }
}

/// The end of a run, for its record.
enum End {
    Done(usize),
    Failed(String),
    Stopped(&'static str),
}

fn skip_text(reason: SkipReason) -> &'static str {
    match reason {
        SkipReason::SelfTrigger => "its own action caused this event",
        SkipReason::Duplicate => "this event already ran it",
        SkipReason::AlreadyRunning => "it is already running",
        SkipReason::Cooldown => "it started a moment ago (cooldown)",
        SkipReason::TooManyRuns => "too many runs at once",
        SkipReason::LoopGuard => "it ran too often in the last minute (loop guard)",
        SkipReason::Stopped => "Flow is stopped",
    }
}

impl<E: Executor> Flow<E> {
    /// Loads the workflows, the ledger and the history; nothing runs and no timer starts here.
    pub fn new(paths: Paths, exec: E, clock: Clock, cfg: SchedulerConfig, enabled: bool) -> (Flow<E>, mpsc::UnboundedReceiver<FlowSignal>) {
        let (workflows, problems) = files::load_all(&paths);
        for p in &problems {
            warn!("flow: {}: {}", p.file, p.error);
        }
        let ledger = files::read_text(&paths.ledger).map(|t| Ledger::from_json(&t)).unwrap_or_default();
        let history = files::read_text(&paths.history).map(|t| ExecutionHistory::from_json(&t)).unwrap_or_default();
        let mut scheduler = Scheduler::with_ledger(cfg, ledger);
        if !enabled {
            scheduler.stop_all();
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let state = State { enabled, workflows, problems, scheduler, history, ctx: Vars::new(), last_tick: None, jobs: HashMap::new(), manual_seq: 0, live_focus_at: None };
        let flow = Flow { inner: Arc::new(Inner { paths, exec, clock, state: Mutex::new(state), signals: tx, wake: Notify::new() }) };
        // A history that was closed by a restart is written back so it says so.
        flow.persist_history(&flow.lock());
        (flow, rx)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn wake(&self) -> &Notify {
        &self.inner.wake
    }

    fn persist_ledger(&self, st: &State) {
        if let Err(err) = files::write_atomic(&self.inner.paths.ledger, st.scheduler.ledger_json().as_bytes()) {
            warn!("flow: could not save the ledger: {err}");
        }
    }
    fn persist_history(&self, st: &State) {
        if let Err(err) = files::write_atomic(&self.inner.paths.history, st.history.to_json().as_bytes()) {
            warn!("flow: could not save the history: {err}");
        }
    }
    fn signal(&self, kind: SignalKind, workflow_id: &str, run: u64, message: &str) {
        let _ = self.inner.signals.send(FlowSignal { kind, workflow_id: workflow_id.into(), run_id: run.to_string(), message: message.into() });
    }

    // ---- the switch

    pub fn is_enabled(&self) -> bool {
        self.lock().enabled
    }

    /// Turns Flow on or off. Off cancels every run in flight, refuses new events and disarms the timer.
    pub fn set_global_enabled(&self, on: bool) {
        {
            let mut st = self.lock();
            st.enabled = on;
            if on {
                st.scheduler.resume();
            } else {
                st.scheduler.stop_all();
                st.last_tick = None;
            }
        }
        self.inner.wake.notify_one();
        info!("flow: turned {}", if on { "on" } else { "off" });
    }

    /// Writes the switch where the next start reads it, and applies it now.
    pub fn switch(&self, on: bool) -> Result<(), String> {
        files::write_enabled(&self.inner.paths, on).map_err(|e| format!("could not save the switch: {e}"))?;
        self.set_global_enabled(on);
        Ok(())
    }

    /// Re-reads the switch and the workflow files (after another program changed them).
    pub fn reload(&self) {
        let on = files::read_enabled(&self.inner.paths);
        let (workflows, problems) = files::load_all(&self.inner.paths);
        {
            let mut st = self.lock();
            st.workflows = workflows;
            st.problems = problems;
        }
        self.set_global_enabled(on);
    }

    // ---- reading

    pub fn list_json(&self) -> String {
        let st = self.lock();
        json!({"api": 1, "flow_enabled": st.enabled, "workflows": st.workflows, "problems": st.problems}).to_string()
    }

    pub fn get_json(&self, id: &str) -> Result<String, String> {
        let st = self.lock();
        st.workflows
            .iter()
            .find(|w| w.id == id)
            .map(|w| serde_json::to_string(w).unwrap_or_default())
            .ok_or_else(|| format!("no workflow \"{id}\""))
    }

    pub fn history_json(&self, id: &str) -> String {
        let st = self.lock();
        let runs: Vec<_> = st.history.runs().filter(|r| id.is_empty() || r.workflow_id == id).collect();
        serde_json::to_string(&runs).unwrap_or_else(|_| "[]".into())
    }

    pub fn clear_history(&self) {
        let mut st = self.lock();
        st.history.clear();
        self.persist_history(&st);
    }

    pub fn templates_json(&self) -> String {
        let all: Vec<Value> = niro_flow::TEMPLATES
            .iter()
            .map(|t| json!({"id": t.id, "title": t.title, "workflow": serde_json::from_str::<Value>(t.json).unwrap_or(Value::Null)}))
            .collect();
        Value::Array(all).to_string()
    }

    /// The registry's actions, with the capability Flow files each under (null: Flow never runs it).
    pub async fn known_actions_json(&self) -> String {
        match self.inner.exec.manifest().await {
            Err(error) => json!({"ok": false, "error": error, "actions": []}).to_string(),
            Ok(list) => {
                let actions: Vec<Value> = list
                    .iter()
                    .map(|a| {
                        json!({"id": a.id, "title": a.title, "permission": a.permission, "available": a.available, "reason": a.reason,
                               "params": a.params, "capability": capability_for(&a.id).map(|c| c.label()),
                               "flow_can_run": a.permission == "none" && capability_for(&a.id).is_some()})
                    })
                    .collect();
                json!({"ok": true, "actions": actions}).to_string()
            }
        }
    }

    // ---- changing the store

    /// Problems with `wf` against the registry's list: names, arguments, and what Flow will not run unattended.
    fn registry_problems(wf: &Workflow, list: &[ActionInfo]) -> Vec<String> {
        let ids: Vec<&str> = list.iter().map(|a| a.id.as_str()).collect();
        let mut problems = niro_flow::validate(wf, &ids);
        for step in &wf.steps {
            let niro_flow::Step::Action { id, name, args, .. } = step else { continue };
            let Some(info) = list.iter().find(|a| a.id == *name) else { continue };
            if let Some(bad) = info.check_args(args) {
                problems.push(format!("step \"{id}\": {bad}"));
            }
            if info.permission != "none" {
                problems.push(format!("step \"{id}\": \"{name}\" asks for confirmation, which Flow cannot give"));
            }
            if capability_for(name).is_none() {
                problems.push(format!("step \"{id}\": Flow never runs \"{name}\""));
            }
        }
        problems
    }

    /// Validates `text` against the registry and, when it is clean, saves it. Returns (saved, problems).
    pub async fn save_json(&self, text: &str) -> (bool, Vec<String>) {
        let wf = match niro_flow::parse(text) {
            Ok(wf) => wf,
            Err(e) => return (false, vec![e]),
        };
        if !files::safe_id(&wf.id) {
            return (false, vec!["workflow id may not start with a dot, and is 1 to 64 letters, digits, dot, dash or underscore".into()]);
        }
        let list = match self.inner.exec.manifest().await {
            Ok(list) => list,
            Err(e) => return (false, vec![format!("the action names cannot be checked now: {e}")]),
        };
        let problems = Self::registry_problems(&wf, &list);
        if !problems.is_empty() {
            return (false, problems);
        }
        if let Err(e) = files::save(&self.inner.paths, &wf) {
            return (false, vec![format!("could not write the workflow: {e}")]);
        }
        {
            let mut st = self.lock();
            match st.workflows.iter_mut().find(|w| w.id == wf.id) {
                Some(slot) => *slot = wf,
                None => {
                    st.workflows.push(wf);
                    st.workflows.sort_by(|a, b| a.id.cmp(&b.id));
                }
            }
        }
        self.inner.wake.notify_one();
        (true, Vec::new())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        if !files::safe_id(id) {
            return Err("not a workflow id".into());
        }
        files::delete(&self.inner.paths, id).map_err(|e| format!("could not delete: {e}"))?;
        self.lock().workflows.retain(|w| w.id != id);
        self.inner.wake.notify_one();
        Ok(())
    }

    pub fn set_workflow_enabled(&self, id: &str, on: bool) -> Result<(), String> {
        let wf = {
            let st = self.lock();
            let mut wf = st.workflows.iter().find(|w| w.id == id).cloned().ok_or_else(|| format!("no workflow \"{id}\""))?;
            wf.enabled = on;
            wf
        };
        files::save(&self.inner.paths, &wf).map_err(|e| format!("could not write the workflow: {e}"))?;
        if let Some(slot) = self.lock().workflows.iter_mut().find(|w| w.id == id) {
            slot.enabled = on;
        }
        self.inner.wake.notify_one();
        Ok(())
    }

    // ---- dry run

    /// What a run would do now, with each action's capability, whether the allow list lets it through and whether the
    /// registry would ask first. Nothing is run.
    pub async fn dry_run_json(&self, id: &str, vars_json: &str) -> Result<String, String> {
        let (wf, mut vars, enabled) = {
            let st = self.lock();
            let wf = st.workflows.iter().find(|w| w.id == id).cloned().ok_or_else(|| format!("no workflow \"{id}\""))?;
            (wf, st.ctx.clone(), st.enabled)
        };
        if !vars_json.trim().is_empty() {
            match serde_json::from_str::<Value>(vars_json) {
                Ok(Value::Object(map)) => vars.extend(map),
                _ => return Err("the variables must be a JSON object".into()),
            }
        }
        let (minutes, _) = self.inner.clock.local(self.inner.clock.wall_ms());
        let (list, registry) = match self.inner.exec.manifest().await {
            Ok(list) => (Some(list), json!("ok")),
            Err(e) => (None, json!(format!("unreachable: {e}"))),
        };
        let problems = match &list {
            Some(list) => Self::registry_problems(&wf, list),
            None => files::structural_problems(&wf),
        };
        let mut policy = AllowListPolicy::for_workflow(&wf);
        let steps: Vec<Value> = niro_flow::plan(&wf, &vars, minutes)
            .into_iter()
            .map(|p| match p {
                Planned::Wait { step, seconds } => json!({"kind": "wait", "step": step, "seconds": seconds}),
                Planned::Branch { step, taken } => json!({"kind": "branch", "step": step, "taken": taken}),
                Planned::Action { step, name, args } => {
                    let cap = capability_for(&name);
                    let verdict = match cap {
                        None => json!("denied: Flow never runs this action"),
                        Some(c) => match policy.evaluate(&wf.id, c, &name) {
                            Decision::Allow => json!("allowed"),
                            Decision::Deny(why) => json!(format!("denied: {why}")),
                            Decision::Ask => json!("denied: would ask"),
                        },
                    };
                    let info = list.as_ref().and_then(|l| l.iter().find(|a| a.id == name));
                    json!({"kind": "action", "step": step, "action": name, "args": args, "capability": cap.map(|c| c.label()),
                           "permission": verdict, "needs_confirmation": info.map(|a| a.permission != "none"),
                           "available": info.map(|a| a.available)})
                }
            })
            .collect();
        Ok(json!({"ok": problems.is_empty(), "problems": problems, "registry": registry, "flow_enabled": enabled, "workflow": wf.id, "steps": steps}).to_string())
    }

    // ---- starting runs

    /// Starts what `event` matches among `candidates`; returns the new run ids and why others were skipped.
    fn start_runs(&self, candidates: &[Workflow], event: &Event, extra: Vars) -> (Vec<u64>, Vec<(String, SkipReason)>) {
        let mut st = self.lock();
        if !st.enabled {
            return (Vec::new(), Vec::new());
        }
        let jobs = st.scheduler.on_event(candidates, event, self.inner.clock.mono_ms());
        let skips: Vec<(String, SkipReason)> = st.scheduler.take_skips().into_iter().map(|s| (s.workflow_id, s.reason)).collect();
        if !jobs.is_empty() || !skips.is_empty() {
            // Before any run starts: a crash after this point replays the event as already handled.
            self.persist_ledger(&st);
        }
        let wall = self.inner.clock.wall_ms().max(0) as u64;
        let mut started = Vec::new();
        for job in jobs {
            let Some(wf) = candidates.iter().find(|w| w.id == job.workflow_id).cloned() else { continue };
            let run = st.history.start(&wf.id, &event.id, wall);
            st.jobs.insert(run, job.id);
            let mut vars = st.ctx.clone();
            vars.extend(extra.clone());
            self.signal(SignalKind::Started, &wf.id, run, &format!("started by {}", event.id));
            let this = self.clone();
            tokio::spawn(async move { this.run_job(wf, job.id, run, vars).await });
            started.push(run);
        }
        if !started.is_empty() {
            self.persist_history(&st);
        }
        for (wf, why) in &skips {
            debug!("flow: {wf} not run for {}: {}", event.id, skip_text(*why));
        }
        (started, skips)
    }

    fn dispatch(&self, event: Event, extra: Vars) {
        let candidates = self.lock().workflows.clone();
        let _ = self.start_runs(&candidates, &event, extra);
    }

    /// Runs a workflow now, whatever its trigger, as the person asked. Needs Flow to be on, not the workflow.
    pub fn run_now(&self, id: &str) -> Result<String, String> {
        let (candidate, event) = {
            let mut st = self.lock();
            if !st.enabled {
                return Err("Niro Flow is turned off".into());
            }
            let wf = st.workflows.iter().find(|w| w.id == id).cloned().ok_or_else(|| format!("no workflow \"{id}\""))?;
            st.manual_seq += 1;
            let event = Event::new(format!("manual-{}-{}", self.inner.clock.wall_ms(), st.manual_seq), EventKind::Manual { workflow: wf.id.clone() });
            let mut manual = wf;
            manual.trigger = niro_flow::Trigger::Manual;
            manual.enabled = true;
            (manual, event)
        };
        let (runs, skips) = self.start_runs(std::slice::from_ref(&candidate), &event, Vars::new());
        match (runs.first(), skips.first()) {
            (Some(run), _) => Ok(run.to_string()),
            (None, Some((_, why))) => Err(format!("not started: {}", skip_text(*why))),
            (None, None) => Err("not started".into()),
        }
    }

    pub fn cancel(&self, run_id: &str) -> Result<(), String> {
        let run: u64 = run_id.parse().map_err(|_| "not a run id".to_owned())?;
        let mut st = self.lock();
        let job = *st.jobs.get(&run).ok_or_else(|| format!("run {run} is not running"))?;
        if st.scheduler.cancel(job) { Ok(()) } else { Err(format!("run {run} is not running")) }
    }

    // ---- event sources

    /// Feeds one thing the desktop did. The context variables (`battery`, `ac`, `network`, `app`) are kept even while
    /// Flow is off, so a condition can read them at once on turning it on; no workflow starts while it is off.
    pub fn feed(&self, input: Input) {
        let wall = self.inner.clock.wall_ms();
        let (event, extra) = {
            let mut st = self.lock();
            let mut extra = Vars::new();
            let event = match input {
                Input::Focus { app, id } => {
                    let live = st.live_focus_at.is_some_and(|at| wall - at < LIVE_FOCUS_WINDOW_MS);
                    if live {
                        // The live source already fired for this focus.
                        st.ctx.insert("app".into(), json!(app));
                        return;
                    }
                    st.ctx.insert("app".into(), json!(app));
                    extra.insert("app".into(), json!(app));
                    Event::new(id, EventKind::AppFocused { app })
                }
                Input::FocusLive { app } => {
                    st.live_focus_at = Some(wall);
                    let same = st.ctx.get("app").and_then(Value::as_str).is_some_and(|cur| cur.eq_ignore_ascii_case(&app));
                    st.ctx.insert("app".into(), json!(app));
                    if same {
                        return; // another window of the same app is not a new focus
                    }
                    extra.insert("app".into(), json!(app));
                    Event::new(format!("focus-live-{app}-{wall}"), EventKind::AppFocused { app })
                }
                Input::Launched { app } => {
                    extra.insert("app".into(), json!(app));
                    Event::new(format!("launched-{app}-{wall}"), EventKind::AppLaunched { app })
                }
                Input::Workspace { index } => {
                    st.ctx.insert("workspace".into(), json!(index));
                    Event::new(format!("workspace-{index}-{wall}"), EventKind::WorkspaceChanged)
                }
                Input::Monitor { count, added } => {
                    st.ctx.insert("monitors".into(), json!(count));
                    if !added {
                        return; // only a connection starts a workflow
                    }
                    Event::new(format!("monitor-{count}-{wall}"), EventKind::MonitorConnected)
                }
                Input::Profile { name } => {
                    st.ctx.insert("profile".into(), json!(name));
                    Event::new(format!("profile-{name}-{wall}"), EventKind::ProfileChanged)
                }
                Input::Battery { percent, previous, plugged } => {
                    st.ctx.insert("battery".into(), json!(percent));
                    st.ctx.insert("ac".into(), json!(plugged));
                    Event::new(format!("battery-{percent}-{wall}"), EventKind::Battery { percent, previous })
                }
                Input::Ac { plugged } => {
                    st.ctx.insert("ac".into(), json!(plugged));
                    Event::new(format!("ac-{plugged}-{wall}"), EventKind::AcChanged)
                }
                Input::Network { connected } => {
                    st.ctx.insert("network".into(), json!(connected));
                    Event::new(format!("network-{connected}-{wall}"), EventKind::NetworkChanged)
                }
            };
            if !st.enabled {
                return;
            }
            (event, extra)
        };
        self.dispatch(event, extra);
    }

    /// The next wall-clock minute boundary, but only while Flow is on and an enabled workflow has a schedule: otherwise
    /// no timer is armed at all.
    pub fn next_tick_deadline(&self) -> Option<i64> {
        let st = self.lock();
        let wanted = st.enabled && st.workflows.iter().any(|w| w.enabled && matches!(w.trigger, niro_flow::Trigger::Schedule { .. }));
        wanted.then(|| (self.inner.clock.wall_ms().div_euclid(60_000) + 1) * 60_000)
    }

    /// One schedule tick for the current minute. A tick that lands after a long gap (suspend) still catches the
    /// schedules in between, because it carries the previous tick's minute.
    pub fn tick(&self) {
        let (minutes, day) = self.inner.clock.local(self.inner.clock.wall_ms());
        let previous = {
            let mut st = self.lock();
            if !st.enabled {
                return;
            }
            let last = st.last_tick.replace((day, minutes));
            match last {
                Some((d, m)) if d == day && m == minutes => return,
                Some((d, m)) if d == day => Some(m),
                // Across midnight the earlier minute is later in the day than this one, so the window wraps.
                Some((_, m)) if m > minutes => Some(m),
                // A whole day or more went by (a long suspend): only the minute itself can match.
                _ => None,
            }
        };
        self.dispatch(Event::new(format!("tick-{day}-{minutes}"), EventKind::Tick { minutes_of_day: minutes, previous, day }), Vars::new());
    }

    // ---- the runner

    fn guard(&self, job: u64) -> Result<(), &'static str> {
        match self.lock().scheduler.check(job, self.inner.clock.mono_ms()) {
            Ok(()) => Ok(()),
            Err(niro_flow::StopReason::TimedOut) => Err("timed out"),
            Err(_) => Err("cancelled"),
        }
    }

    /// Awaits `fut`, giving up the moment the run is cancelled or past its deadline.
    async fn guarded<T>(&self, job: u64, fut: impl Future<Output = T>) -> Result<T, &'static str> {
        tokio::pin!(fut);
        loop {
            tokio::select! {
                out = &mut fut => return Ok(out),
                () = tokio::time::sleep(POLL) => self.guard(job)?,
            }
        }
    }

    async fn run_job(self, wf: Workflow, job: u64, run: u64, vars: Vars) {
        let end = self.walk(&wf, job, run, vars).await;
        let wall = self.inner.clock.wall_ms().max(0) as u64;
        let (kind, message) = {
            let mut st = self.lock();
            st.scheduler.finish(job);
            st.jobs.remove(&run);
            let out = match end {
                End::Done(n) => {
                    st.history.finish(run, wall);
                    (SignalKind::Completed, format!("{n} steps done"))
                }
                End::Failed(why) => {
                    st.history.fail(run, wall, &why);
                    (SignalKind::Failed, why)
                }
                End::Stopped(why) => {
                    st.history.cancelled(run, wall, why);
                    (SignalKind::Failed, why.to_owned())
                }
            };
            self.persist_history(&st);
            out
        };
        self.signal(kind, &wf.id, run, &message);
    }

    async fn walk(&self, wf: &Workflow, job: u64, run: u64, vars: Vars) -> End {
        let (minutes, _) = self.inner.clock.local(self.inner.clock.wall_ms());
        let list = match self.guarded(job, self.inner.exec.manifest()).await {
            Err(stopped) => return End::Stopped(stopped),
            Ok(Err(e)) => return End::Failed(format!("the action registry is not reachable: {e}")),
            Ok(Ok(list)) => list,
        };
        let mut policy = AllowListPolicy::for_workflow(wf);
        let mut stepper = Stepper::new(wf, &vars, minutes);
        let mut done = 0;
        loop {
            if let Err(stopped) = self.guard(job) {
                return End::Stopped(stopped);
            }
            match stepper.next_step() {
                Next::Done => return End::Done(done),
                Next::Stuck(why) => return End::Failed(why),
                Next::Branch { .. } => done += 1,
                Next::Wait { seconds, .. } => match self.guarded(job, tokio::time::sleep(Duration::from_secs(seconds))).await {
                    Ok(()) => done += 1,
                    Err(stopped) => return End::Stopped(stopped),
                },
                Next::Action { step, name, args } => {
                    let outcome = self.action(wf, &mut policy, &list, job, &name, &args).await;
                    let failure = outcome.as_ref().err().map(|e| e.to_string());
                    {
                        let mut st = self.lock();
                        st.history.record_step(run, &step, &name, &args, failure.as_deref());
                    }
                    match outcome {
                        Ok(()) => done += 1,
                        Err(Stop::Ended(why)) => return End::Stopped(why),
                        Err(Stop::Error(why)) => return End::Failed(format!("step \"{step}\": {why}")),
                    }
                }
            }
        }
    }

    /// One action step, through the policy and the registry's own rules.
    async fn action(&self, wf: &Workflow, policy: &mut AllowListPolicy, list: &[ActionInfo], job: u64, name: &str, args: &Map<String, Value>) -> Result<(), Stop> {
        let deny = |why: String| Err(Stop::Error(why));
        let Some(cap) = capability_for(name) else {
            return deny(format!("permission denied: \"{name}\" is not an action Flow runs"));
        };
        match policy.evaluate(&wf.id, cap, name) {
            Decision::Allow => {}
            Decision::Deny(why) => return deny(format!("permission denied: {} ({why})", cap.label())),
            Decision::Ask => return deny(format!("permission denied: {} (would ask)", cap.label())),
        }
        let Some(info) = list.iter().find(|a| a.id == name) else {
            return deny(format!("\"{name}\" is not a registered action"));
        };
        if info.permission != "none" {
            return deny(format!("needs confirmation: \"{name}\" asks the user first, and Flow never confirms for them"));
        }
        if !info.available {
            return deny(format!("\"{name}\" is not available now ({})", info.reason.as_deref().unwrap_or("no reason given")));
        }
        if let Some(bad) = info.check_args(args) {
            return deny(format!("invalid arguments for \"{name}\": {bad}"));
        }
        match self.guarded(job, self.inner.exec.run(name, args)).await {
            Err(why) => Err(Stop::Ended(why)),
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => deny(e.to_string()),
        }
    }

    /// Runs in flight.
    #[cfg(test)]
    pub fn running(&self) -> usize {
        self.lock().jobs.len()
    }

    #[cfg(test)]
    pub fn run_status(&self, run: u64) -> Option<niro_flow::RunStatus> {
        self.lock().history.get(run).map(|r| r.status)
    }
}

enum Stop {
    Error(String),
    Ended(&'static str),
}

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Stop::Error(s) => f.write_str(s),
            Stop::Ended(s) => f.write_str(s),
        }
    }
}
