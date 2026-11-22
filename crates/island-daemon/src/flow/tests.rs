// SPDX-License-Identifier: GPL-3.0-or-later

//! Flow's runtime against a fake action registry: no bus, no desktop.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use niro_flow::{RunStatus, SchedulerConfig};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

use super::engine::{ActionError, ActionInfo, Clock, Executor, Flow, FlowSignal, Input, SignalKind};
use super::files::{self, Paths};
use super::system_inputs;
use crate::system::{Battery, Network, SystemState};

#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<(String, Map<String, Value>)>>,
    /// How long each action takes.
    delay: Mutex<Duration>,
    fail: Mutex<Option<String>>,
    down: AtomicBool,
    started: AtomicUsize,
}

fn info(id: &str, permission: &str, params: Value) -> ActionInfo {
    ActionInfo::from_value(&json!({"id": id, "title": id, "permission": permission, "available": true, "reason": null, "params": params})).unwrap()
}

impl Executor for Arc<Fake> {
    async fn manifest(&self) -> Result<Vec<ActionInfo>, String> {
        if self.down.load(Ordering::SeqCst) {
            return Err("the action registry is not reachable".into());
        }
        Ok(vec![
            info("profile.apply", "none", json!([{"name": "id", "type": "string", "required": true, "maxLength": 60}])),
            info("layout.restore", "none", json!([{"name": "name", "type": "string", "required": true}])),
            info("system.dnd.toggle", "none", json!([])),
            info("system.clean.trash", "confirm", json!([])),
            info("system.shutdown", "none", json!([])),
        ])
    }

    async fn run(&self, id: &str, args: &Map<String, Value>) -> Result<String, ActionError> {
        self.started.fetch_add(1, Ordering::SeqCst);
        let delay = *self.delay.lock().unwrap();
        tokio::time::sleep(delay).await;
        self.calls.lock().unwrap().push((id.to_owned(), args.clone()));
        match self.fail.lock().unwrap().clone() {
            Some(e) => Err(ActionError::Failed(e)),
            None => Ok("done".into()),
        }
    }
}

struct Rig {
    flow: Flow<Arc<Fake>>,
    fake: Arc<Fake>,
    rx: UnboundedReceiver<FlowSignal>,
    wall: Arc<AtomicI64>,
    paths: Paths,
}

fn root(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("niro-flow-rt-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn cfg() -> SchedulerConfig {
    SchedulerConfig { cooldown_ms: 0, ..SchedulerConfig::default() }
}

fn rig_at(paths: Paths, fake: Arc<Fake>, wall: Arc<AtomicI64>, enabled: bool, cfg: SchedulerConfig) -> Rig {
    let w = wall.clone();
    let (flow, rx) = Flow::new(paths.clone(), fake.clone(), Clock::fake(move || w.load(Ordering::SeqCst)), cfg, enabled);
    Rig { flow, fake, rx, wall, paths }
}

fn rig(name: &str, enabled: bool) -> Rig {
    // 2026-01-05 09:00 UTC, in milliseconds.
    rig_at(Paths::under(&root(name)), Arc::new(Fake::default()), Arc::new(AtomicI64::new(1_767_603_600_000)), enabled, cfg())
}

fn workflow(id: &str, trigger: Value, allow: &[&str], steps: Value) -> String {
    json!({"version": 1, "id": id, "enabled": true, "allow": allow, "trigger": trigger, "steps": steps}).to_string()
}

fn coding(id: &str, allow: &[&str]) -> String {
    workflow(
        id,
        json!({"type": "app_focused", "app": "code"}),
        allow,
        json!([{"kind": "action", "id": "p", "name": "profile.apply", "args": {"id": "deep-work"}, "next": null}]),
    )
}

async fn finished(rig: &Rig, run: u64) -> RunStatus {
    for _ in 0..2000 {
        match rig.flow.run_status(run) {
            Some(RunStatus::Running) => tokio::time::sleep(Duration::from_millis(50)).await,
            Some(status) => return status,
            None => panic!("no such run"),
        }
    }
    panic!("run {run} never finished");
}

fn signals(rig: &mut Rig) -> Vec<(SignalKind, String)> {
    let mut out = Vec::new();
    while let Ok(s) = rig.rx.try_recv() {
        out.push((s.kind, s.message));
    }
    out
}

fn history(rig: &Rig) -> Vec<Value> {
    serde_json::from_str(&rig.flow.history_json("")).unwrap()
}

#[tokio::test(start_paused = true)]
async fn saving_checks_the_registry_and_survives_a_restart() {
    let rig = rig("save", true);
    let (ok, problems) = rig.flow.save_json(&coding("coding", &["settings"])).await;
    assert!((ok, problems.len()) == (true, 0), "{problems:?}");
    // A name the registry lacks, a confirm action, bad arguments, an action Flow has no capability for.
    let unknown = workflow("u", json!({"type": "manual"}), &[], json!([{"kind": "action", "id": "a", "name": "nope.nothing", "args": {}, "next": null}]));
    assert!(rig.flow.save_json(&unknown).await.1[0].contains("not a registered action"));
    let confirm = workflow("c", json!({"type": "manual"}), &["settings"], json!([{"kind": "action", "id": "a", "name": "system.clean.trash", "args": {}, "next": null}]));
    assert!(rig.flow.save_json(&confirm).await.1.iter().any(|p| p.contains("asks for confirmation")));
    let bad_args = workflow("b", json!({"type": "manual"}), &["settings"], json!([{"kind": "action", "id": "a", "name": "profile.apply", "args": {"name": "x"}, "next": null}]));
    let problems = rig.flow.save_json(&bad_args).await.1;
    assert!(problems.iter().any(|p| p.contains("unknown argument")), "{problems:?}");
    let power = workflow("p", json!({"type": "manual"}), &["settings"], json!([{"kind": "action", "id": "a", "name": "system.shutdown", "args": {}, "next": null}]));
    assert!(rig.flow.save_json(&power).await.1.iter().any(|p| p.contains("never runs")));
    assert!(!rig.flow.save_json("not json").await.0);
    let escape = workflow(".hidden", json!({"type": "manual"}), &[], json!([{"kind": "action", "id": "a", "name": "system.dnd.toggle", "args": {}, "next": null}]));
    assert!(!rig.flow.save_json(&escape).await.0);
    // Only the good one was written.
    assert_eq!(files::load_all(&rig.paths).0.len(), 1);

    let again = rig_at(rig.paths.clone(), Arc::new(Fake::default()), rig.wall.clone(), true, cfg());
    let list: Value = serde_json::from_str(&again.flow.list_json()).unwrap();
    assert_eq!(list["workflows"][0]["id"], "coding");
    assert_eq!(list["workflows"][0]["allow"], json!(["settings"]));
    assert!(again.flow.get_json("coding").is_ok() && again.flow.get_json("zzz").is_err());
    again.flow.set_workflow_enabled("coding", false).unwrap();
    assert!(!files::load_all(&again.paths).0[0].enabled);
    again.flow.delete("coding").unwrap();
    assert!(files::load_all(&again.paths).0.is_empty());
    assert!(again.flow.delete("../x").is_err());
}

#[tokio::test(start_paused = true)]
async fn the_registry_being_down_saves_nothing_and_stops_a_run() {
    let rig = rig("down", true);
    rig.fake.down.store(true, Ordering::SeqCst);
    let (ok, problems) = rig.flow.save_json(&coding("coding", &["settings"])).await;
    assert!(!ok && problems[0].contains("cannot be checked"));
    let known: Value = serde_json::from_str(&rig.flow.known_actions_json().await).unwrap();
    assert_eq!(known["ok"], false);

    rig.fake.down.store(false, Ordering::SeqCst);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    rig.fake.down.store(true, Ordering::SeqCst);
    let run = rig.flow.run_now("coding").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Error);
    assert!(history(&rig)[0]["error"].as_str().unwrap().contains("not reachable"));
}

#[tokio::test(start_paused = true)]
async fn a_focus_event_becomes_a_job_and_a_run_through_the_registry() {
    let mut rig = rig("focus", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    rig.flow.feed(Input::Focus { app: "Code.desktop".into(), id: "focus-1".into() });
    assert_eq!(rig.flow.running(), 1);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(rig.fake.calls.lock().unwrap().as_slice(), [("profile.apply".to_owned(), json!({"id": "deep-work"}).as_object().unwrap().clone())]);
    let runs = history(&rig);
    assert_eq!(runs[0]["status"], "ok");
    assert_eq!(runs[0]["workflow_id"], "coding");
    assert_eq!(runs[0]["steps"][0]["name"], "profile.apply");
    let kinds: Vec<_> = signals(&mut rig).into_iter().map(|s| s.0).collect();
    assert_eq!(kinds, [SignalKind::Started, SignalKind::Completed]);
    // Another app starts nothing.
    rig.flow.feed(Input::Focus { app: "firefox".into(), id: "focus-2".into() });
    assert_eq!(rig.flow.running(), 0);
    assert_eq!(history(&rig).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn everything_is_denied_unless_the_workflow_allows_it() {
    let mut rig = rig("deny", true);
    // Written straight to disk: the runner must hold even when the file did not come through Save.
    files::save(&rig.paths, &niro_flow::parse(&coding("coding", &[])).unwrap()).unwrap();
    rig.flow.reload();
    rig.flow.set_global_enabled(true);
    let run = rig.flow.run_now("coding").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Error);
    assert!(history(&rig)[0]["error"].as_str().unwrap().contains("permission denied: settings (not in this workflow's allow list)"));
    assert_eq!(rig.fake.started.load(Ordering::SeqCst), 0);
    assert!(signals(&mut rig).iter().any(|s| s.0 == SignalKind::Failed));
    // The wrong capability is no better.
    files::save(&rig.paths, &niro_flow::parse(&coding("coding", &["window"])).unwrap()).unwrap();
    rig.flow.reload();
    rig.flow.set_global_enabled(true);
    tokio::time::sleep(Duration::from_secs(10)).await;
    let run = rig.flow.run_now("coding").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Error);
    assert_eq!(rig.fake.started.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn an_action_flow_never_runs_stops_the_run_even_when_listed() {
    let rig = rig("never", true);
    let wf = workflow(
        "power",
        json!({"type": "manual"}),
        &["settings", "system.shutdown"],
        json!([{"kind": "action", "id": "a", "name": "profile.apply", "args": {"id": "everyday"}, "next": "b"},
               {"kind": "action", "id": "b", "name": "system.shutdown", "args": {}, "next": null}]),
    );
    // Written straight to disk: the runner must hold even when the file did not come through Save.
    files::save(&rig.paths, &niro_flow::parse(&wf).unwrap()).unwrap();
    rig.flow.reload();
    rig.flow.set_global_enabled(true);
    let run = rig.flow.run_now("power").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Error);
    let error = history(&rig)[0]["error"].as_str().unwrap().to_owned();
    assert!(error.contains("step \"b\"") && error.contains("not an action Flow runs"), "{error}");
    assert_eq!(rig.fake.calls.lock().unwrap().len(), 1, "only the first step ran");
}

#[tokio::test(start_paused = true)]
async fn a_confirm_action_with_a_capability_says_needs_confirmation() {
    struct Asks(Arc<Fake>);
    impl Executor for Asks {
        async fn manifest(&self) -> Result<Vec<ActionInfo>, String> {
            Ok(vec![info("clipboard.copy", "confirm", json!([{"name": "text", "type": "string", "required": true}]))])
        }
        async fn run(&self, id: &str, args: &Map<String, Value>) -> Result<String, ActionError> {
            self.0.run(id, args).await
        }
    }
    let paths = Paths::under(&root("asks"));
    let wf = workflow("c", json!({"type": "manual"}), &["clipboard"], json!([{"kind": "action", "id": "a", "name": "clipboard.copy", "args": {"text": "x"}, "next": null}]));
    files::save(&paths, &niro_flow::parse(&wf).unwrap()).unwrap();
    let fake = Arc::new(Fake::default());
    let (flow, _rx) = Flow::new(paths, Asks(fake.clone()), Clock::fake(|| 0), cfg(), true);
    let run: u64 = flow.run_now("c").unwrap().parse().unwrap();
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let record: Vec<Value> = serde_json::from_str(&flow.history_json("c")).unwrap();
    assert_eq!(record[0]["id"], run);
    assert!(record[0]["error"].as_str().unwrap().contains("needs confirmation"), "{record:?}");
    assert_eq!(fake.started.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn a_failing_action_fails_the_run_with_the_registrys_words() {
    let rig = rig("fail", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    *rig.fake.fail.lock().unwrap() = Some("failed: no profile \"deep-work\"".into());
    let run = rig.flow.run_now("coding").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Error);
    assert!(history(&rig)[0]["error"].as_str().unwrap().contains("no profile"));
}

#[tokio::test(start_paused = true)]
async fn off_means_no_timer_no_events_no_runs() {
    let rig = rig("off", false);
    let schedule = workflow("night", json!({"type": "schedule", "at": "09:01"}), &["settings"], json!([{"kind": "action", "id": "a", "name": "profile.apply", "args": {"id": "everyday"}, "next": null}]));
    assert!(rig.flow.save_json(&schedule).await.0);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    assert_eq!(rig.flow.next_tick_deadline(), None, "no timer while Flow is off");
    rig.flow.feed(Input::Focus { app: "code".into(), id: "f1".into() });
    rig.flow.tick();
    assert_eq!(rig.flow.running(), 0);
    assert!(rig.flow.run_now("coding").unwrap_err().contains("turned off"));
    assert!(history(&rig).is_empty());
    // The context is still kept, so turning it on is not blind.
    rig.flow.feed(Input::Battery { percent: 50, previous: None, plugged: true });

    rig.flow.set_global_enabled(true);
    let deadline = rig.flow.next_tick_deadline().expect("armed: an enabled workflow has a schedule");
    assert_eq!(deadline % 60_000, 0);
    assert!(deadline > rig.wall.load(Ordering::SeqCst));
    rig.flow.set_workflow_enabled("night", false).unwrap();
    assert_eq!(rig.flow.next_tick_deadline(), None, "no schedule workflow enabled, no timer");
    rig.flow.set_workflow_enabled("night", true).unwrap();
    assert!(rig.flow.next_tick_deadline().is_some());
    rig.flow.set_global_enabled(false);
    assert_eq!(rig.flow.next_tick_deadline(), None);
}

#[tokio::test(start_paused = true)]
async fn a_schedule_fires_once_a_minute_and_once_a_day_even_after_a_restart() {
    let rig = rig("tick", true);
    let schedule = workflow("night", json!({"type": "schedule", "at": "09:01"}), &["settings"], json!([{"kind": "action", "id": "a", "name": "profile.apply", "args": {"id": "everyday"}, "next": null}]));
    assert!(rig.flow.save_json(&schedule).await.0);
    rig.flow.tick(); // 09:00: not yet
    assert_eq!(history(&rig).len(), 0);
    rig.wall.fetch_add(60_000, Ordering::SeqCst); // 09:01
    rig.flow.tick();
    rig.flow.tick(); // the same minute again
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(history(&rig).len(), 1);

    // The daemon restarts and the same minute is seen again: the ledger says it ran.
    let again = rig_at(rig.paths.clone(), Arc::new(Fake::default()), rig.wall.clone(), true, cfg());
    again.flow.tick();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(again.flow.running(), 0);
    assert_eq!(again.fake.started.load(Ordering::SeqCst), 0);
    assert_eq!(history(&again).len(), 1);

    // Tomorrow it runs again.
    again.wall.fetch_add(86_400_000, Ordering::SeqCst);
    again.flow.tick();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(history(&again).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_replayed_event_does_not_run_again_after_a_restart() {
    let rig = rig("replay", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    rig.flow.feed(Input::Focus { app: "code".into(), id: "focus-code-100".into() });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(history(&rig).len(), 1);

    let again = rig_at(rig.paths.clone(), Arc::new(Fake::default()), rig.wall.clone(), true, cfg());
    again.flow.feed(Input::Focus { app: "code".into(), id: "focus-code-100".into() });
    assert_eq!(again.flow.running(), 0);
    again.flow.feed(Input::Focus { app: "code".into(), id: "focus-code-200".into() });
    assert_eq!(again.flow.running(), 1, "a new event still runs");
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(history(&again).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_run_cut_off_by_a_restart_is_recorded_as_interrupted() {
    let rig = rig("interrupted", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    *rig.fake.delay.lock().unwrap() = Duration::from_secs(3600);
    let run: u64 = rig.flow.run_now("coding").unwrap().parse().unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(rig.flow.run_status(run), Some(RunStatus::Running));
    let again = rig_at(rig.paths.clone(), Arc::new(Fake::default()), rig.wall.clone(), true, cfg());
    let runs = history(&again);
    assert_eq!(runs[0]["status"], "error");
    assert_eq!(runs[0]["error"], "interrupted by a restart");
}

#[tokio::test(start_paused = true)]
async fn cancel_stops_a_run_in_the_middle_of_an_action() {
    let mut rig = rig("cancel", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    *rig.fake.delay.lock().unwrap() = Duration::from_secs(3600);
    let run: u64 = rig.flow.run_now("coding").unwrap().parse().unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(rig.flow.cancel("abc").is_err());
    assert!(rig.flow.cancel("999").is_err());
    rig.flow.cancel(&run.to_string()).unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Cancelled);
    assert_eq!(rig.flow.running(), 0);
    assert!(rig.fake.calls.lock().unwrap().is_empty(), "the action never completed");
    assert!(signals(&mut rig).iter().any(|s| s.0 == SignalKind::Failed && s.1 == "cancelled"));
    assert!(rig.flow.cancel(&run.to_string()).is_err(), "already over");
}

#[tokio::test(start_paused = true)]
async fn a_run_past_its_deadline_is_stopped_as_timed_out() {
    let rig = rig_at(
        Paths::under(&root("timeout")),
        Arc::new(Fake::default()),
        Arc::new(AtomicI64::new(1_767_603_600_000)),
        true,
        SchedulerConfig { cooldown_ms: 0, timeout_ms: 2_000, ..SchedulerConfig::default() },
    );
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    *rig.fake.delay.lock().unwrap() = Duration::from_secs(3600);
    let run: u64 = rig.flow.run_now("coding").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Cancelled);
    assert_eq!(history(&rig)[0]["error"], "timed out");
}

#[tokio::test(start_paused = true)]
async fn a_delay_step_waits_and_a_cancel_during_it_works() {
    let rig = rig("delay", true);
    let wf = workflow(
        "slow",
        json!({"type": "manual"}),
        &["settings"],
        json!([{"kind": "delay", "id": "d", "seconds": 30, "next": "a"},
               {"kind": "action", "id": "a", "name": "profile.apply", "args": {"id": "everyday"}, "next": null}]),
    );
    assert!(rig.flow.save_json(&wf).await.0);
    let run: u64 = rig.flow.run_now("slow").unwrap().parse().unwrap();
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert!(rig.fake.calls.lock().unwrap().is_empty(), "still waiting");
    tokio::time::sleep(Duration::from_secs(25)).await;
    assert_eq!(finished(&rig, run).await, RunStatus::Ok);
    assert_eq!(rig.fake.calls.lock().unwrap().len(), 1);

    tokio::time::sleep(Duration::from_secs(10)).await;
    let second: u64 = rig.flow.run_now("slow").unwrap().parse().unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await;
    rig.flow.cancel(&second.to_string()).unwrap();
    assert_eq!(finished(&rig, second).await, RunStatus::Cancelled);
    assert_eq!(rig.fake.calls.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn turning_flow_off_cancels_what_is_running_and_it_can_come_back() {
    let rig = rig("switch", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    *rig.fake.delay.lock().unwrap() = Duration::from_secs(3600);
    let run: u64 = rig.flow.run_now("coding").unwrap().parse().unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    rig.flow.switch(false).unwrap();
    assert_eq!(finished(&rig, run).await, RunStatus::Cancelled);
    assert!(rig.flow.run_now("coding").is_err());
    assert!(!files::read_text(&rig.paths.enabled).unwrap().contains("true"));
    rig.flow.switch(true).unwrap();
    *rig.fake.delay.lock().unwrap() = Duration::ZERO;
    tokio::time::sleep(Duration::from_secs(10)).await;
    let again: u64 = rig.flow.run_now("coding").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, again).await, RunStatus::Ok);
}

#[tokio::test(start_paused = true)]
async fn a_battery_trigger_fires_on_the_downward_crossing_only() {
    let rig = rig("battery", true);
    let wf = workflow("low", json!({"type": "battery_below", "percent": 20}), &["settings"], json!([{"kind": "action", "id": "a", "name": "profile.apply", "args": {"id": "everyday"}, "next": null}]));
    assert!(rig.flow.save_json(&wf).await.0);
    rig.flow.feed(Input::Battery { percent: 15, previous: None, plugged: false });
    assert_eq!(rig.flow.running(), 0, "a first reading is not a crossing");
    rig.flow.feed(Input::Battery { percent: 25, previous: Some(26), plugged: false });
    assert_eq!(rig.flow.running(), 0);
    rig.flow.feed(Input::Battery { percent: 19, previous: Some(25), plugged: false });
    assert_eq!(rig.flow.running(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_condition_reads_the_desktop_context() {
    let rig = rig("ctx", true);
    let wf = workflow(
        "net",
        json!({"type": "network_changed"}),
        &["settings"],
        json!([{"kind": "condition", "id": "c", "expr": {"op": "eq", "var": "network", "value": true}, "then": "a", "else": null},
               {"kind": "action", "id": "a", "name": "profile.apply", "args": {"id": "everyday"}, "next": null}]),
    );
    assert!(rig.flow.save_json(&wf).await.0);
    rig.flow.feed(Input::Network { connected: false });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(rig.fake.calls.lock().unwrap().is_empty());
    rig.flow.feed(Input::Network { connected: true });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(rig.fake.calls.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn dry_run_shows_the_plan_and_the_verdict_for_each_action_without_running_anything() {
    let rig = rig("dry", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    let plan: Value = serde_json::from_str(&rig.flow.dry_run_json("coding", "").await.unwrap()).unwrap();
    assert_eq!(plan["ok"], true);
    assert_eq!(plan["registry"], "ok");
    assert_eq!(plan["steps"][0]["action"], "profile.apply");
    assert_eq!(plan["steps"][0]["permission"], "allowed");
    assert_eq!(plan["steps"][0]["needs_confirmation"], false);
    assert_eq!(plan["steps"][0]["capability"], "settings");
    assert_eq!(rig.fake.started.load(Ordering::SeqCst), 0);
    assert!(rig.flow.dry_run_json("nope", "").await.is_err());
    assert!(rig.flow.dry_run_json("coding", "[1]").await.is_err());
    files::save(&rig.paths, &niro_flow::parse(&coding("bare", &[])).unwrap()).unwrap();
    rig.flow.reload();
    let plan: Value = serde_json::from_str(&rig.flow.dry_run_json("bare", "{}").await.unwrap()).unwrap();
    assert!(plan["steps"][0]["permission"].as_str().unwrap().starts_with("denied"));
    // With the registry down the plan is still shown, and says it could not check.
    rig.fake.down.store(true, Ordering::SeqCst);
    let plan: Value = serde_json::from_str(&rig.flow.dry_run_json("coding", "").await.unwrap()).unwrap();
    assert!(plan["registry"].as_str().unwrap().starts_with("unreachable"));
}

#[tokio::test(start_paused = true)]
async fn run_now_obeys_the_cooldown_and_works_for_any_trigger() {
    let rig = rig_at(Paths::under(&root("manual")), Arc::new(Fake::default()), Arc::new(AtomicI64::new(1_767_603_600_000)), true, SchedulerConfig::default());
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    let first: u64 = rig.flow.run_now("coding").unwrap().parse().unwrap();
    assert_eq!(finished(&rig, first).await, RunStatus::Ok);
    assert!(rig.flow.run_now("coding").unwrap_err().contains("cooldown"));
    assert!(rig.flow.run_now("zzz").is_err());
}

#[tokio::test(start_paused = true)]
async fn templates_are_offered_and_all_save_against_a_registry_that_has_their_actions() {
    let rig = rig("templates", true);
    let list: Vec<Value> = serde_json::from_str(&rig.flow.templates_json()).unwrap();
    assert_eq!(list.len(), niro_flow::TEMPLATES.len());
    for t in list {
        let (ok, problems) = rig.flow.save_json(&t["workflow"].to_string()).await;
        assert!(ok, "{}: {problems:?}", t["id"]);
    }
    // They ship disabled.
    assert!(files::load_all(&rig.paths).0.iter().all(|w| !w.enabled));
    let known: Value = serde_json::from_str(&rig.flow.known_actions_json().await).unwrap();
    let ids: Vec<&str> = known["actions"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"profile.apply"));
    let trash = known["actions"].as_array().unwrap().iter().find(|a| a["id"] == "system.clean.trash").unwrap();
    assert_eq!(trash["flow_can_run"], false);
}

#[test]
fn argument_checks_follow_the_registrys_rules() {
    let a = info(
        "x.y",
        "none",
        json!([{"name": "s", "type": "string", "required": true, "maxLength": 3}, {"name": "n", "type": "number", "min": 1, "max": 5},
               {"name": "b", "type": "boolean"}, {"name": "e", "type": "enum", "enum": ["a", "b"]}]),
    );
    let obj = |v: Value| v.as_object().unwrap().clone();
    assert_eq!(a.check_args(&obj(json!({"s": "ok", "n": 3, "b": true, "e": "a"}))), None);
    assert!(a.check_args(&obj(json!({}))).unwrap().contains("required"));
    assert!(a.check_args(&obj(json!({"s": "toolong"}))).unwrap().contains("too long"));
    assert!(a.check_args(&obj(json!({"s": "a", "n": 9}))).unwrap().contains("at most"));
    assert!(a.check_args(&obj(json!({"s": "a", "b": "yes"}))).unwrap().contains("true or false"));
    assert!(a.check_args(&obj(json!({"s": "a", "e": "c"}))).unwrap().contains("allowed values"));
    assert!(a.check_args(&obj(json!({"s": "a", "zz": 1}))).unwrap().contains("unknown argument"));
}

#[test]
fn system_changes_become_inputs() {
    let state = |percent: f64, plugged: bool, connected: bool| SystemState {
        battery: Some(Battery { percent, plugged, charging: plugged }),
        network: Network { connected, connection: String::new(), name: String::new() },
        ..SystemState::default()
    };
    assert_eq!(system_inputs(&state(50.0, false, true), &state(50.0, false, true)), []);
    assert_eq!(system_inputs(&state(50.0, false, true), &state(49.0, false, true)), [Input::Battery { percent: 49, previous: Some(50), plugged: false }]);
    assert_eq!(
        system_inputs(&state(49.0, false, true), &state(49.0, true, true)),
        [Input::Ac { plugged: true }]
    );
    assert_eq!(system_inputs(&state(49.0, false, true), &state(49.0, false, false)), [Input::Network { connected: false }]);
    let first = SystemState { battery: None, ..state(0.0, false, true) };
    assert_eq!(system_inputs(&first, &state(80.0, true, true)), [Input::Battery { percent: 80, previous: None, plugged: true }]);
}

fn on_event(id: &str, trigger: Value) -> String {
    workflow(id, trigger, &["settings"], json!([{"kind": "action", "id": "p", "name": "profile.apply", "args": {"id": "deep-work"}, "next": null}]))
}

#[tokio::test(start_paused = true)]
async fn live_focus_fires_at_once_and_the_late_usage_report_does_not_fire_again() {
    let rig = rig("live-focus", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    rig.flow.feed(Input::FocusLive { app: "code".into() });
    assert_eq!(rig.flow.running(), 1, "no wait for a usage report");
    tokio::time::sleep(Duration::from_secs(1)).await;
    // Same window focused again: not a new focus. The usage report for it, a minute on: no second run.
    rig.flow.feed(Input::FocusLive { app: "Code".into() });
    rig.flow.feed(Input::Focus { app: "code".into(), id: "focus-code-1".into() });
    assert_eq!(rig.flow.running(), 0);
    assert_eq!(history(&rig).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn usage_reports_still_fire_when_no_live_focus_ever_came() {
    let rig = rig("fallback-focus", true);
    assert!(rig.flow.save_json(&coding("coding", &["settings"])).await.0);
    rig.flow.feed(Input::Focus { app: "code".into(), id: "focus-code-1".into() });
    assert_eq!(rig.flow.running(), 1);
}

#[tokio::test(start_paused = true)]
async fn workspace_monitor_profile_and_launch_events_start_their_workflows() {
    let rig = rig("sources", true);
    for (id, t) in [
        ("ws", json!({"type": "workspace_changed"})),
        ("mon", json!({"type": "monitor_connected"})),
        ("prof", json!({"type": "profile_changed"})),
        ("launch", json!({"type": "app_launched", "app": "code"})),
    ] {
        assert!(rig.flow.save_json(&on_event(id, t)).await.0);
    }
    rig.flow.feed(Input::Workspace { index: 1 });
    assert_eq!(rig.flow.running(), 1);
    rig.flow.feed(Input::Monitor { count: 1, added: false });
    assert_eq!(rig.flow.running(), 1, "a removal starts nothing");
    rig.flow.feed(Input::Monitor { count: 2, added: true });
    assert_eq!(rig.flow.running(), 2);
    rig.flow.feed(Input::Profile { name: "work".into() });
    rig.flow.feed(Input::Launched { app: "firefox".into() });
    assert_eq!(rig.flow.running(), 3, "launch of another app starts nothing");
    rig.flow.feed(Input::Launched { app: "code.desktop".into() });
    assert_eq!(rig.flow.running(), 4);
}

#[tokio::test(start_paused = true)]
async fn the_new_events_do_nothing_while_flow_is_off() {
    let rig = rig("sources-off", true);
    assert!(rig.flow.save_json(&on_event("ws", json!({"type": "workspace_changed"}))).await.0);
    rig.flow.set_global_enabled(false);
    rig.flow.feed(Input::Workspace { index: 1 });
    rig.flow.feed(Input::FocusLive { app: "code".into() });
    assert_eq!(rig.flow.running(), 0);
}
