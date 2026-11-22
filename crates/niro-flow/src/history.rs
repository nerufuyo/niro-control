//! Bounded execution history: one record per run with start, finish, error and the steps taken. Arguments are
//! redacted with `redact()` before they are stored, so secrets never reach the history or its JSON.

use crate::redact;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;

pub const DEFAULT_HISTORY_MAX: usize = 200;
const STEPS_PER_RUN_MAX: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Ok,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepRecord {
    pub step: String,
    pub name: String,
    pub args: Map<String, Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: u64,
    pub workflow_id: String,
    pub event_id: String,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
    pub status: RunStatus,
    pub error: Option<String>,
    pub steps: Vec<StepRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionHistory {
    cap: usize,
    next: u64,
    runs: VecDeque<RunRecord>,
}

impl Default for ExecutionHistory {
    fn default() -> Self {
        ExecutionHistory::new(DEFAULT_HISTORY_MAX)
    }
}

impl ExecutionHistory {
    pub fn new(cap: usize) -> ExecutionHistory {
        ExecutionHistory { cap: cap.max(1), next: 1, runs: VecDeque::new() }
    }

    /// Opens a record and returns its id. The oldest records fall off once `cap` is exceeded.
    pub fn start(&mut self, workflow_id: &str, event_id: &str, now_ms: u64) -> u64 {
        let id = self.next;
        self.next += 1;
        self.runs.push_back(RunRecord {
            id,
            workflow_id: workflow_id.into(),
            event_id: event_id.into(),
            started_ms: now_ms,
            finished_ms: None,
            status: RunStatus::Running,
            error: None,
            steps: Vec::new(),
        });
        while self.runs.len() > self.cap {
            self.runs.pop_front();
        }
        id
    }

    /// Adds a step to a running record; `args` is redacted here. Unknown or finished runs are ignored.
    pub fn record_step(&mut self, run: u64, step: &str, name: &str, args: &Map<String, Value>, error: Option<&str>) {
        if let Some(r) = self.open(run).filter(|r| r.steps.len() < STEPS_PER_RUN_MAX) {
            r.steps.push(StepRecord { step: step.into(), name: name.into(), args: redact(args), error: error.map(String::from) });
        }
    }

    pub fn finish(&mut self, run: u64, now_ms: u64) {
        self.close(run, now_ms, RunStatus::Ok, None);
    }
    pub fn fail(&mut self, run: u64, now_ms: u64, error: &str) {
        self.close(run, now_ms, RunStatus::Error, Some(error));
    }
    /// A run stopped by cancel, stop or timeout.
    pub fn cancelled(&mut self, run: u64, now_ms: u64, why: &str) {
        self.close(run, now_ms, RunStatus::Cancelled, Some(why));
    }

    fn open(&mut self, run: u64) -> Option<&mut RunRecord> {
        self.runs.iter_mut().find(|r| r.id == run && r.status == RunStatus::Running)
    }
    fn close(&mut self, run: u64, now_ms: u64, status: RunStatus, error: Option<&str>) {
        if let Some(r) = self.open(run) {
            r.finished_ms = Some(now_ms);
            r.status = status;
            r.error = error.map(String::from);
        }
    }

    /// Oldest first.
    pub fn runs(&self) -> impl Iterator<Item = &RunRecord> {
        self.runs.iter()
    }
    pub fn get(&self, run: u64) -> Option<&RunRecord> {
        self.runs.iter().find(|r| r.id == run)
    }
    pub fn len(&self) -> usize {
        self.runs.len()
    }
    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }
    pub fn clear(&mut self) {
        self.runs.clear();
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
    /// Junk gives an empty history. A saved record still marked running (the daemon died mid-run) is closed as an error.
    pub fn from_json(text: &str) -> ExecutionHistory {
        let mut h = serde_json::from_str::<ExecutionHistory>(text).unwrap_or_default();
        h.cap = h.cap.max(1);
        while h.runs.len() > h.cap {
            h.runs.pop_front();
        }
        for r in h.runs.iter_mut().filter(|r| r.status == RunStatus::Running) {
            r.status = RunStatus::Error;
            r.error = Some("interrupted by a restart".into());
        }
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn a_run_records_start_steps_and_finish() {
        let mut h = ExecutionHistory::new(10);
        let id = h.start("wf", "e1", 100);
        h.record_step(id, "a", "notify", &args(json!({"text":"hi"})), None);
        h.finish(id, 250);
        let r = h.get(id).unwrap();
        assert_eq!((r.status, r.started_ms, r.finished_ms), (RunStatus::Ok, 100, Some(250)));
        assert_eq!(r.steps.len(), 1);
        assert_eq!(r.error, None);
    }

    #[test]
    fn errors_are_recorded_and_a_finished_run_is_closed() {
        let mut h = ExecutionHistory::default();
        let id = h.start("wf", "e1", 0);
        h.record_step(id, "a", "dnd.set", &args(json!({})), Some("denied"));
        h.fail(id, 5, "step \"a\": denied");
        h.finish(id, 9);
        h.record_step(id, "b", "notify", &args(json!({})), None);
        let r = h.get(id).unwrap();
        assert_eq!((r.status, r.finished_ms), (RunStatus::Error, Some(5)));
        assert_eq!(r.steps.len(), 1);
        assert_eq!(r.steps[0].error.as_deref(), Some("denied"));
        let c = h.start("wf", "e2", 10);
        h.cancelled(c, 11, "timed out");
        assert_eq!(h.get(c).unwrap().status, RunStatus::Cancelled);
    }

    #[test]
    fn secrets_are_redacted_in_the_history_and_in_its_json() {
        let mut h = ExecutionHistory::default();
        let id = h.start("wf", "e1", 0);
        h.record_step(id, "a", "net.post", &args(json!({"api_token":"hunter2","Password":"p4ss","url":"https://x"})), None);
        let r = h.get(id).unwrap();
        assert_eq!(r.steps[0].args["api_token"], json!("***"));
        assert_eq!(r.steps[0].args["url"], json!("https://x"));
        let text = h.to_json();
        assert!(!text.contains("hunter2") && !text.contains("p4ss"));
    }

    #[test]
    fn history_is_bounded_oldest_first_out() {
        let mut h = ExecutionHistory::new(3);
        let ids: Vec<u64> = (0..5).map(|i| h.start("wf", &format!("e{i}"), i)).collect();
        assert_eq!(h.len(), 3);
        assert!(h.get(ids[0]).is_none() && h.get(ids[1]).is_none());
        assert!(h.get(ids[4]).is_some());
    }

    #[test]
    fn json_round_trips_closes_interrupted_runs_and_clear_empties() {
        let mut h = ExecutionHistory::new(5);
        let done = h.start("wf", "e1", 0);
        h.finish(done, 1);
        let open = h.start("wf", "e2", 2);
        let mut back = ExecutionHistory::from_json(&h.to_json());
        assert_eq!(back.get(done).unwrap().status, RunStatus::Ok);
        assert_eq!(back.get(open).unwrap().status, RunStatus::Error);
        assert_eq!(back.start("wf", "e3", 3), 3, "ids keep counting");
        back.clear();
        assert!(back.is_empty());
        assert!(ExecutionHistory::from_json("junk").is_empty());
    }
}
