//! Execution scheduler core: decides which jobs an event starts. No threads, no clock, no I/O: the caller passes
//! `now_ms`, runs the jobs, and calls `finish`. Guards, in order: self-trigger, duplicate event, workflow already
//! running, cooldown, global concurrency, loop window.
//!
//! An event is decided once: once claimed in the ledger it is never reconsidered, even if a guard skipped it, so a
//! replay after a restart cannot start something the first pass declined.

use crate::triggers::{Event, EventKind, matching};
use crate::{Ledger, Workflow};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    /// Minimum time between two starts of the same workflow.
    pub cooldown_ms: u64,
    /// Runs in flight across all workflows.
    pub max_concurrent: usize,
    /// A workflow may start at most `loop_max` times within `loop_window_ms`.
    pub loop_window_ms: u64,
    pub loop_max: usize,
    /// Each job's deadline is its start plus this.
    pub timeout_ms: u64,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        SchedulerConfig { cooldown_ms: 5_000, max_concurrent: 4, loop_window_ms: 60_000, loop_max: 5, timeout_ms: 120_000 }
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: u64,
    pub workflow_id: String,
    pub event_id: String,
    pub started_ms: u64,
    pub deadline_ms: u64,
    cancel: Arc<AtomicBool>,
}

impl Job {
    /// A flag the run loop can poll (or hand to another thread); set by `cancel`, `stop_all` and timeouts.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    SelfTrigger,
    Duplicate,
    AlreadyRunning,
    Cooldown,
    TooManyRuns,
    LoopGuard,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub workflow_id: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Cancelled,
    TimedOut,
    Unknown,
}

pub struct Scheduler {
    cfg: SchedulerConfig,
    ledger: Ledger,
    running: HashMap<u64, Job>,
    last_start: HashMap<String, u64>,
    recent: HashMap<String, VecDeque<u64>>,
    skips: Vec<Skipped>,
    next_id: u64,
    stopped: bool,
}

impl Scheduler {
    pub fn new(cfg: SchedulerConfig) -> Scheduler {
        Scheduler::with_ledger(cfg, Ledger::default())
    }
    /// Starts from a ledger saved before a restart (`ledger_json` / `Ledger::from_json`).
    pub fn with_ledger(cfg: SchedulerConfig, ledger: Ledger) -> Scheduler {
        Scheduler { cfg, ledger, running: HashMap::new(), last_start: HashMap::new(), recent: HashMap::new(), skips: Vec::new(), next_id: 1, stopped: false }
    }
    pub fn ledger_json(&self) -> String {
        self.ledger.to_json()
    }

    fn dedup_key(wf: &Workflow, event: &Event) -> String {
        match &event.kind {
            // A schedule runs once per calendar day however many ticks or replays there are.
            EventKind::Tick { day, .. } => format!("{}|day-{day}", wf.id),
            _ => format!("{}|{}", wf.id, event.id),
        }
    }

    /// The jobs `event` starts at `now_ms`. Why others did not start is in `take_skips`.
    pub fn on_event(&mut self, workflows: &[Workflow], event: &Event, now_ms: u64) -> Vec<Job> {
        let mut jobs = Vec::new();
        for wf in matching(workflows, event) {
            let skip = |s: &mut Scheduler, reason| s.skips.push(Skipped { workflow_id: wf.id.clone(), reason });
            if self.stopped {
                skip(self, SkipReason::Stopped);
                continue;
            }
            // Tagged with the workflow that caused it: never feed a workflow its own output.
            if event.origin.as_deref() == Some(wf.id.as_str()) {
                skip(self, SkipReason::SelfTrigger);
                continue;
            }
            if !self.ledger.claim(&Self::dedup_key(wf, event)) {
                skip(self, SkipReason::Duplicate);
                continue;
            }
            if self.running.values().any(|j| j.workflow_id == wf.id) {
                skip(self, SkipReason::AlreadyRunning);
                continue;
            }
            if self.last_start.get(&wf.id).is_some_and(|last| now_ms.saturating_sub(*last) < self.cfg.cooldown_ms) {
                skip(self, SkipReason::Cooldown);
                continue;
            }
            if self.running.len() >= self.cfg.max_concurrent {
                skip(self, SkipReason::TooManyRuns);
                continue;
            }
            let window = self.recent.entry(wf.id.clone()).or_default();
            while window.front().is_some_and(|t| now_ms.saturating_sub(*t) >= self.cfg.loop_window_ms) {
                window.pop_front();
            }
            if window.len() >= self.cfg.loop_max {
                skip(self, SkipReason::LoopGuard);
                continue;
            }
            window.push_back(now_ms);
            self.last_start.insert(wf.id.clone(), now_ms);
            let job = Job {
                id: self.next_id,
                workflow_id: wf.id.clone(),
                event_id: event.id.clone(),
                started_ms: now_ms,
                deadline_ms: now_ms.saturating_add(self.cfg.timeout_ms),
                cancel: Arc::new(AtomicBool::new(false)),
            };
            self.next_id += 1;
            self.running.insert(job.id, job.clone());
            jobs.push(job);
        }
        jobs
    }

    pub fn take_skips(&mut self) -> Vec<Skipped> {
        std::mem::take(&mut self.skips)
    }
    pub fn running_count(&self) -> usize {
        self.running.len()
    }

    /// The run loop calls this before each step: an error says to stop and why.
    pub fn check(&self, job_id: u64, now_ms: u64) -> Result<(), StopReason> {
        match self.running.get(&job_id) {
            None => Err(StopReason::Unknown),
            Some(j) if j.is_cancelled() => Err(StopReason::Cancelled),
            Some(j) if now_ms >= j.deadline_ms => Err(StopReason::TimedOut),
            Some(_) => Ok(()),
        }
    }

    /// Jobs past their deadline: removed from the running set and their cancel flag set.
    pub fn reap_expired(&mut self, now_ms: u64) -> Vec<Job> {
        let ids: Vec<u64> = self.running.values().filter(|j| now_ms >= j.deadline_ms).map(|j| j.id).collect();
        ids.into_iter()
            .filter_map(|id| self.running.remove(&id))
            .inspect(|j| j.cancel.store(true, Ordering::SeqCst))
            .collect()
    }

    pub fn finish(&mut self, job_id: u64) -> bool {
        self.running.remove(&job_id).is_some()
    }

    /// Sets the job's cancel flag; the job stays counted until the caller calls `finish`.
    pub fn cancel(&mut self, job_id: u64) -> bool {
        self.running.get(&job_id).map(|j| j.cancel.store(true, Ordering::SeqCst)).is_some()
    }

    /// Cancels everything in flight and refuses new jobs until `resume`.
    pub fn stop_all(&mut self) {
        self.stopped = true;
        self.running.values().for_each(|j| j.cancel.store(true, Ordering::SeqCst));
    }
    pub fn resume(&mut self) {
        self.stopped = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wf(id: &str) -> Workflow {
        serde_json::from_value(json!({"version":1,"id":id,"trigger":{"type":"workspace_changed"},
            "steps":[{"kind":"action","id":"a","name":"notify","args":{},"next":null}]}))
        .unwrap()
    }
    fn ev(id: &str) -> Event {
        Event::new(id, EventKind::WorkspaceChanged)
    }
    fn cfg() -> SchedulerConfig {
        SchedulerConfig { cooldown_ms: 0, max_concurrent: 8, loop_window_ms: 60_000, loop_max: 100, timeout_ms: 1000 }
    }

    #[test]
    fn an_event_starts_a_job_with_a_deadline() {
        let mut s = Scheduler::new(cfg());
        let jobs = s.on_event(&[wf("a")], &ev("e1"), 10);
        assert_eq!(jobs.len(), 1);
        assert_eq!((jobs[0].workflow_id.as_str(), jobs[0].event_id.as_str(), jobs[0].deadline_ms), ("a", "e1", 1010));
        assert_eq!(s.running_count(), 1);
    }

    #[test]
    fn a_replayed_event_does_not_run_twice_even_after_a_restart() {
        let ws = [wf("a")];
        let mut s = Scheduler::new(cfg());
        assert_eq!(s.on_event(&ws, &ev("e1"), 0).len(), 1);
        s.finish(1);
        assert!(s.on_event(&ws, &ev("e1"), 5000).is_empty());
        assert_eq!(s.take_skips(), [Skipped { workflow_id: "a".into(), reason: SkipReason::Duplicate }]);
        let mut restarted = Scheduler::with_ledger(cfg(), Ledger::from_json(&s.ledger_json()));
        assert!(restarted.on_event(&ws, &ev("e1"), 9000).is_empty());
        assert_eq!(restarted.on_event(&ws, &ev("e2"), 9000).len(), 1);
    }

    #[test]
    fn a_workflows_own_event_does_not_retrigger_it_but_does_trigger_others() {
        let ws = [wf("a"), wf("b")];
        let mut s = Scheduler::new(cfg());
        let jobs = s.on_event(&ws, &ev("e1").from_workflow("a"), 0);
        assert_eq!(jobs.iter().map(|j| j.workflow_id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert_eq!(s.take_skips(), [Skipped { workflow_id: "a".into(), reason: SkipReason::SelfTrigger }]);
    }

    #[test]
    fn a_ping_pong_between_two_workflows_is_cut_by_the_loop_window() {
        let ws = [wf("a")];
        let mut s = Scheduler::new(SchedulerConfig { loop_max: 3, ..cfg() });
        let mut started = 0;
        for i in 0..10u64 {
            let jobs = s.on_event(&ws, &ev(&format!("e{i}")).from_workflow("other"), i * 100);
            started += jobs.len();
            jobs.iter().for_each(|j| {
                s.finish(j.id);
            });
        }
        assert_eq!(started, 3);
        assert!(s.take_skips().iter().any(|k| k.reason == SkipReason::LoopGuard));
        // The window slides: a minute later it may run again.
        assert_eq!(s.on_event(&ws, &ev("late"), 61_000).len(), 1);
    }

    #[test]
    fn cooldown_spaces_starts_of_one_workflow() {
        let ws = [wf("a")];
        let mut s = Scheduler::new(SchedulerConfig { cooldown_ms: 1000, ..cfg() });
        let j = s.on_event(&ws, &ev("e1"), 0);
        s.finish(j[0].id);
        assert!(s.on_event(&ws, &ev("e2"), 999).is_empty());
        assert_eq!(s.take_skips()[0].reason, SkipReason::Cooldown);
        assert_eq!(s.on_event(&ws, &ev("e3"), 1000).len(), 1);
    }

    #[test]
    fn concurrency_is_capped_and_one_workflow_never_overlaps_itself() {
        let ws = [wf("a"), wf("b"), wf("c")];
        let mut s = Scheduler::new(SchedulerConfig { max_concurrent: 2, ..cfg() });
        let jobs = s.on_event(&ws, &ev("e1"), 0);
        assert_eq!(jobs.len(), 2);
        assert_eq!(s.take_skips()[0].reason, SkipReason::TooManyRuns);
        assert!(s.on_event(&ws, &ev("e2"), 1).is_empty());
        let reasons: Vec<_> = s.take_skips().into_iter().map(|k| k.reason).collect();
        assert!(reasons.contains(&SkipReason::AlreadyRunning));
        s.finish(jobs[0].id);
        assert_eq!(s.running_count(), 1);
    }

    #[test]
    fn a_job_times_out_and_is_cancelled() {
        let mut s = Scheduler::new(cfg());
        let job = s.on_event(&[wf("a")], &ev("e1"), 0).remove(0);
        assert_eq!(s.check(job.id, 999), Ok(()));
        assert_eq!(s.check(job.id, 1000), Err(StopReason::TimedOut));
        assert!(s.reap_expired(500).is_empty());
        let reaped = s.reap_expired(1000);
        assert_eq!(reaped.len(), 1);
        assert!(job.is_cancelled(), "the flag the run loop holds is set");
        assert_eq!(s.running_count(), 0);
        assert_eq!(s.check(job.id, 0), Err(StopReason::Unknown));
    }

    #[test]
    fn cancel_and_stop_all_set_the_flag_and_stop_all_refuses_new_work() {
        let ws = [wf("a"), wf("b")];
        let mut s = Scheduler::new(cfg());
        let jobs = s.on_event(&ws, &ev("e1"), 0);
        assert!(s.cancel(jobs[0].id));
        assert!(jobs[0].is_cancelled() && !jobs[1].is_cancelled());
        assert_eq!(s.check(jobs[0].id, 1), Err(StopReason::Cancelled));
        s.stop_all();
        assert!(jobs[1].is_cancelled());
        assert!(s.on_event(&ws, &ev("e2"), 5000).is_empty());
        assert_eq!(s.take_skips().last().map(|k| k.reason), Some(SkipReason::Stopped));
        s.resume();
        jobs.iter().for_each(|j| {
            s.finish(j.id);
        });
        assert_eq!(s.on_event(&ws, &ev("e3"), 9000).len(), 2);
    }

    #[test]
    fn a_schedule_runs_once_per_day_even_with_different_event_ids() {
        let w: Workflow = serde_json::from_value(json!({"version":1,"id":"s","trigger":{"type":"schedule","at":"09:00"},
            "steps":[{"kind":"action","id":"a","name":"notify","args":{},"next":null}]}))
        .unwrap();
        let tick = |id: &str, day| Event::new(id, EventKind::Tick { minutes_of_day: 540, previous: Some(539), day });
        let mut s = Scheduler::new(cfg());
        assert_eq!(s.on_event(std::slice::from_ref(&w), &tick("t1", 7), 0).len(), 1);
        assert!(s.on_event(std::slice::from_ref(&w), &tick("t2", 7), 100).is_empty());
        let mut again = Scheduler::with_ledger(cfg(), Ledger::from_json(&s.ledger_json()));
        assert!(again.on_event(std::slice::from_ref(&w), &tick("t3", 7), 200).is_empty());
        assert_eq!(again.on_event(&[w], &tick("t4", 8), 300).len(), 1);
    }
}
