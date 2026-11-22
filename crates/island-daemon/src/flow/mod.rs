// SPDX-License-Identifier: GPL-3.0-or-later

//! Niro Flow, the runtime: workflows (JSON files under `~/.config/niro/flow/workflows/`) started by what the desktop
//! does, run through Search's typed action registry, with the D-Bus object `org.niro.Flow1` to manage them.
//!
//! Opt-in and off by default: nothing is read, armed or run until the switch is on (`NIRO_FLOW_ENABLED=1`, or the
//! `flow.enabled` file in the flow config folder, or `SetGlobalEnabled(true)`). While it is off there are no timers,
//! events are dropped, and `RunNow` refuses.
//!
//! Permissions: a workflow may only do what its own `allow` list names (capability labels such as `settings`,
//! `window`, `launch`, `clipboard`, `network`, `notifications`, or exact action ids such as `profile.apply`);
//! everything else is denied, and so is every action Flow has no capability for (power, session, process, files).
//! An action the registry would confirm on screen is never run: the run stops at that step with "needs confirmation".
//!
//! Event sources: the shell's `Notify` calls (focus, launch, workspace, monitor, profile; immediate), the focused app
//! from the shell's app-usage reports (up to about a minute late, used only while no `Notify` focus arrives), battery level
//! and AC (UPower, through the system state), network (NetworkManager), a minute timer that exists only while an
//! enabled workflow has a schedule, and manual runs.

mod engine;
mod files;

use std::time::Duration;

use anyhow::bail;
use log::{info, warn};
use niro_flow::SchedulerConfig;
use serde_json::{Map, Value};
use std::sync::OnceLock;
use tokio::sync::mpsc;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

pub use engine::{ActionError, ActionInfo, Executor, Flow, FlowSignal, Input, SignalKind};
use files::Paths;

/// The registry on the session bus (`org.niro.Search`), reached the way the assistant reaches it.
pub struct SearchExecutor;

impl Executor for SearchExecutor {
    async fn manifest(&self) -> Result<Vec<ActionInfo>, String> {
        let list = tokio::time::timeout(Duration::from_secs(8), crate::assistant::niro::manifest())
            .await
            .map_err(|_| "the action registry did not answer in time".to_owned())??;
        Ok(list.iter().filter_map(ActionInfo::from_value).collect())
    }

    async fn run(&self, id: &str, args: &Map<String, Value>) -> Result<String, ActionError> {
        let text = Value::Object(args.clone()).to_string();
        let outcome = crate::assistant::niro::run_action(id, &text).await.map_err(ActionError::Unavailable)?;
        if outcome["ok"].as_bool() == Some(true) {
            return Ok(outcome["message"].as_str().unwrap_or_default().to_owned());
        }
        let code = outcome["code"].as_str().unwrap_or("failed");
        let error = outcome["error"].as_str().unwrap_or("the action failed");
        Err(ActionError::Failed(format!("{code}: {error}")))
    }
}

/// The running Flow, for the hooks other modules call.
static RUNTIME: OnceLock<Flow<SearchExecutor>> = OnceLock::new();

/// The app in front, as the shell reported it: one `(app id, start ms, duration ms)` per stretch. Only stretches
/// that ended within the last two minutes count, so a late or repeated report does not replay old focus.
pub fn observe_apps(stretches: &[(String, i64, i64)]) {
    let Some(flow) = RUNTIME.get() else { return };
    let now = crate::clock::now_ms();
    for (app, start, ms) in stretches {
        if start.saturating_add(*ms) >= now - 120_000 {
            flow.feed(Input::Focus { app: app.clone(), id: format!("focus-{app}-{start}") });
        }
    }
}

/// The battery, AC and network changes between two states of the system service.
pub fn observe_system(before: &crate::system::SystemState, after: &crate::system::SystemState) {
    if let Some(flow) = RUNTIME.get() {
        system_inputs(before, after).into_iter().for_each(|input| flow.feed(input));
    }
}

fn system_inputs(before: &crate::system::SystemState, after: &crate::system::SystemState) -> Vec<Input> {
    let mut out = Vec::new();
    if let Some(now) = &after.battery {
        let percent = now.percent.clamp(0.0, 100.0) as u8;
        let previous = before.battery.as_ref().map(|b| b.percent.clamp(0.0, 100.0) as u8);
        if previous != Some(percent) {
            out.push(Input::Battery { percent, previous, plugged: now.plugged });
        }
        if before.battery.as_ref().is_some_and(|b| b.plugged != now.plugged) {
            out.push(Input::Ac { plugged: now.plugged });
        }
    }
    if before.network.connected != after.network.connected || before.network.name != after.network.name {
        out.push(Input::Network { connected: after.network.connected });
    }
    out
}

/// The most a `Notify` payload may be, in bytes.
const MAX_PAYLOAD: usize = 2048;
/// Events per kind per second `Notify` acts on; more are dropped.
const NOTIFY_PER_SECOND: u32 = 10;

/// `Notify` kinds and payloads to a Flow input; `None` for anything unknown or malformed. Pure.
fn notification_input(kind: &str, payload: &str) -> Option<Input> {
    if payload.len() > MAX_PAYLOAD {
        return None;
    }
    let v: Value = serde_json::from_str(payload).ok()?;
    let id = |key: &str| {
        let s = v.get(key)?.as_str()?.trim();
        (!s.is_empty() && s.chars().count() <= 200 && !s.chars().any(char::is_control)).then(|| s.to_owned())
    };
    let number = |key: &str| v.get(key)?.as_u64().filter(|n| *n <= 10_000).map(|n| n as u32);
    match kind {
        "workspace" => Some(Input::Workspace { index: number("index")? }),
        "monitor" => Some(Input::Monitor { count: number("count")?, added: v.get("added")?.as_bool()? }),
        "profile" => Some(Input::Profile { name: id("name")? }),
        "app-launched" => Some(Input::Launched { app: id("appId")? }),
        "app-focus" => Some(Input::FocusLive { app: id("appId")? }),
        _ => None,
    }
}

/// A fixed one-second window per kind.
#[derive(Default)]
struct RateLimit(std::collections::HashMap<String, (i64, u32)>);

impl RateLimit {
    fn allow(&mut self, kind: &str, now_ms: i64) -> bool {
        let slot = self.0.entry(kind.to_owned()).or_insert((now_ms, 0));
        if now_ms - slot.0 >= 1000 || now_ms < slot.0 {
            *slot = (now_ms, 0);
        }
        slot.1 += 1;
        slot.1 <= NOTIFY_PER_SECOND
    }
}

/// The `org.niro.Flow1` D-Bus object. Method names and shapes are version 1 (`ApiVersion`).
pub struct FlowService {
    flow: Flow<SearchExecutor>,
    limits: std::sync::Mutex<RateLimit>,
}

impl FlowService {
    /// What `Notify` does, without the bus.
    fn notify_inner(&self, kind: &str, payload: &str) -> bool {
        if !self.flow.is_enabled() {
            return false;
        }
        let Some(input) = notification_input(kind, payload) else { return false };
        let allowed = self.limits.lock().unwrap_or_else(|e| e.into_inner()).allow(kind, crate::clock::now_ms());
        if !allowed {
            return false;
        }
        self.flow.feed(input);
        true
    }
}

fn failed(message: String) -> fdo::Error {
    fdo::Error::Failed(message)
}

#[interface(name = "org.niro.Flow1")]
impl FlowService {
    #[zbus(property)]
    fn api_version(&self) -> u32 {
        1
    }

    /// Whether Flow is on. Off: no timers, no events, no runs.
    #[zbus(property)]
    fn enabled(&self) -> bool {
        self.flow.is_enabled()
    }

    /// Turns Flow on or off, remembering it in the `flow.enabled` file.
    async fn set_global_enabled(&self, on: bool, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.flow.switch(on).map_err(failed)?;
        self.enabled_changed(&emitter).await?;
        Ok(())
    }

    /// Re-reads the switch and the workflow files.
    async fn reload(&self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.flow.reload();
        self.enabled_changed(&emitter).await?;
        Ok(())
    }

    /// JSON `{api, flow_enabled, workflows: [...], problems: [{file, error}]}`.
    fn list(&self) -> String {
        self.flow.list_json()
    }

    fn get(&self, id: &str) -> fdo::Result<String> {
        self.flow.get_json(id).map_err(failed)
    }

    /// Validates against the registry and saves. Returns whether it was saved and a JSON array of problems.
    async fn save(&self, json: &str) -> (bool, String) {
        let (ok, problems) = self.flow.save_json(json).await;
        (ok, serde_json::to_string(&problems).unwrap_or_else(|_| "[]".into()))
    }

    fn delete(&self, id: &str) -> fdo::Result<()> {
        self.flow.delete(id).map_err(failed)
    }

    fn set_enabled(&self, id: &str, enabled: bool) -> fdo::Result<()> {
        self.flow.set_workflow_enabled(id, enabled).map_err(failed)
    }

    /// What a run would do now, as JSON; `vars_json` is an optional JSON object laid over the current context.
    async fn dry_run(&self, id: &str, vars_json: &str) -> fdo::Result<String> {
        self.flow.dry_run_json(id, vars_json).await.map_err(failed)
    }

    /// The shell reports what the desktop did: kind `workspace` {"index":N}, `monitor` {"count":N,"added":bool},
    /// `profile` {"name":S}, `app-launched` {"appId":S}, `app-focus` {"appId":S}. True when it was acted on; false
    /// when Flow is off, the kind or payload is not accepted (2 KB at most), or the kind is over 10 events a second.
    fn notify(&self, kind: &str, payload: &str) -> bool {
        self.notify_inner(kind, payload)
    }

    /// Starts a run now and returns its run id.
    fn run_now(&self, id: &str) -> fdo::Result<String> {
        self.flow.run_now(id).map_err(failed)
    }

    fn cancel(&self, run_id: &str) -> fdo::Result<()> {
        self.flow.cancel(run_id).map_err(failed)
    }

    /// Runs of one workflow (all when `id` is empty), oldest first, as JSON.
    fn history(&self, id: &str) -> String {
        self.flow.history_json(id)
    }

    fn clear_history(&self) {
        self.flow.clear_history();
    }

    fn templates(&self) -> String {
        self.flow.templates_json()
    }

    /// The registry's actions (Search's `ListActions`), as JSON `{ok, error?, actions}`.
    async fn known_actions(&self) -> String {
        self.flow.known_actions_json().await
    }

    #[zbus(signal)]
    async fn workflow_started(emitter: &SignalEmitter<'_>, id: &str, run_id: &str, message: &str) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn workflow_completed(emitter: &SignalEmitter<'_>, id: &str, run_id: &str, message: &str) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn workflow_failed(emitter: &SignalEmitter<'_>, id: &str, run_id: &str, message: &str) -> zbus::Result<()>;
}

/// Loads Flow, registers its object and returns what `run` needs. The switch is read here, once.
pub async fn serve(server: &zbus::ObjectServer) -> anyhow::Result<(InterfaceRef<FlowService>, Flow<SearchExecutor>, mpsc::UnboundedReceiver<FlowSignal>)> {
    let paths = Paths::standard();
    let on = files::read_enabled(&paths);
    let (flow, signals) = Flow::new(paths, SearchExecutor, engine::Clock::real(), SchedulerConfig::default(), on);
    let _ = RUNTIME.set(flow.clone());
    server.at(crate::OBJECT_PATH, FlowService { flow: flow.clone(), limits: Default::default() }).await?;
    let iface = server.interface::<_, FlowService>(crate::OBJECT_PATH).await?;
    info!("flow: {}", if on { "on" } else { "off (opt in with NIRO_FLOW_ENABLED=1 or the flow.enabled file)" });
    Ok((iface, flow, signals))
}

/// Forwards run signals to D-Bus and keeps the schedule timer. The timer waits with no deadline (so does not exist)
/// until Flow is on and an enabled workflow has a schedule.
pub async fn run(iface: InterfaceRef<FlowService>, flow: Flow<SearchExecutor>, mut signals: mpsc::UnboundedReceiver<FlowSignal>) {
    let ticker = flow.clone();
    tokio::spawn(async move {
        loop {
            if crate::clock::wait_until(ticker.next_tick_deadline(), ticker.wake()).await {
                ticker.tick();
            }
        }
    });
    while let Some(signal) = signals.recv().await {
        let emitter = iface.signal_emitter();
        let sent = match signal.kind {
            SignalKind::Started => FlowService::workflow_started(emitter, &signal.workflow_id, &signal.run_id, &signal.message).await,
            SignalKind::Completed => FlowService::workflow_completed(emitter, &signal.workflow_id, &signal.run_id, &signal.message).await,
            SignalKind::Failed => FlowService::workflow_failed(emitter, &signal.workflow_id, &signal.run_id, &signal.message).await,
        };
        if let Err(err) = sent {
            warn!("flow: could not send a signal: {err}");
        }
    }
}

pub const HELP: &str = "island-daemon --flow COMMAND: Niro Flow, the workflow runtime (off until switched on)
  status                 whether Flow is on, and the workflow folder
  list                   the saved workflows, and files that could not be used
  templates              the built-in workflows
  actions                the registry actions Flow can run (needs Niro Search running)
  dry-run ID [VARS_JSON] what a workflow would do now; nothing is run
  history [ID]           recent runs
  enable | disable       the switch (also tells a running daemon)";

/// `island-daemon --flow ...`: reads the same files the service does; never runs an action.
pub async fn cli(args: &[String]) -> anyhow::Result<()> {
    let paths = Paths::standard();
    let (flow, _signals) = Flow::new(paths.clone(), SearchExecutor, engine::Clock::real(), SchedulerConfig::default(), files::read_enabled(&paths));
    let pretty = |text: String| serde_json::from_str::<Value>(&text).and_then(|v| serde_json::to_string_pretty(&v)).unwrap_or(text);
    match args.first().map(String::as_str) {
        Some("status") => {
            println!("Flow: {}", if flow.is_enabled() { "on" } else { "off" });
            println!("Workflows: {}", paths.workflows.display());
        }
        Some("list") => println!("{}", pretty(flow.list_json())),
        Some("templates") => println!("{}", pretty(flow.templates_json())),
        Some("actions") => println!("{}", pretty(flow.known_actions_json().await)),
        Some("history") => println!("{}", pretty(flow.history_json(args.get(1).map_or("", String::as_str)))),
        Some("dry-run") => {
            let Some(id) = args.get(1) else { bail!("dry-run needs a workflow id") };
            let vars = args.get(2).map_or("", String::as_str);
            println!("{}", pretty(flow.dry_run_json(id, vars).await.map_err(anyhow::Error::msg)?));
        }
        Some(which @ ("enable" | "disable")) => {
            flow.switch(which == "enable").map_err(anyhow::Error::msg)?;
            println!("Flow is now {}", if which == "enable" { "on" } else { "off" });
            // A running daemon reads the switch only at start: tell it, if there is one.
            if let Ok(bus) = zbus::Connection::session().await
                && let Ok(proxy) = zbus::Proxy::new(&bus, crate::BUS_NAME, crate::OBJECT_PATH, "org.niro.Flow1").await
            {
                let told: zbus::Result<()> = proxy.call("Reload", &()).await;
                if told.is_ok() {
                    println!("(the running daemon was told)");
                }
            }
        }
        _ => {
            println!("{HELP}");
            if !matches!(args.first().map(String::as_str), None | Some("--help" | "help")) {
                bail!("unknown --flow command");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod notify_tests {
    use super::*;

    #[test]
    fn payloads_map_to_inputs_and_bad_ones_to_none() {
        assert!(matches!(notification_input("workspace", r#"{"index":2}"#), Some(Input::Workspace { index: 2 })));
        assert!(matches!(notification_input("monitor", r#"{"count":2,"added":true}"#), Some(Input::Monitor { count: 2, added: true })));
        assert!(matches!(notification_input("profile", r#"{"name":"work"}"#), Some(Input::Profile { .. })));
        assert!(matches!(notification_input("app-launched", r#"{"appId":"code.desktop"}"#), Some(Input::Launched { .. })));
        assert!(matches!(notification_input("app-focus", r#"{"appId":"code"}"#), Some(Input::FocusLive { .. })));
        for (k, p) in [
            ("nope", "{}"), ("workspace", "{}"), ("workspace", "[1]"), ("workspace", "not json"), ("workspace", r#"{"index":-1}"#),
            ("monitor", r#"{"count":1}"#), ("app-focus", r#"{"appId":""}"#), ("app-focus", "{\"appId\":\"a\\u0000b\"}"), ("profile", r#"{"name":5}"#),
        ] {
            assert!(notification_input(k, p).is_none(), "{k} {p}");
        }
        let big = format!(r#"{{"appId":"{}"}}"#, "a".repeat(MAX_PAYLOAD));
        assert!(notification_input("app-focus", &big).is_none());
    }

    #[test]
    fn each_kind_is_limited_to_ten_a_second() {
        let mut r = RateLimit::default();
        assert!((0..10).all(|i| r.allow("workspace", 5000 + i)));
        assert!(!r.allow("workspace", 5500));
        assert!(r.allow("monitor", 5500), "kinds are counted apart");
        assert!(r.allow("workspace", 6001), "a new window");
    }
}

