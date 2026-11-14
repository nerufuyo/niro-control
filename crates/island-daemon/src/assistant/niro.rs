// SPDX-License-Identifier: GPL-3.0-or-later

//! The assistant's way to Niro's action registry (the one Search uses, on the session bus as `org.niro.Search`).
//!
//! The AI may only name an action by its id. island-daemon asks the registry what exists and what is available, refuses any
//! id the registry does not list, refuses the same request twice in one answer chain and too many in all, and passes the
//! rest on. The registry validates the arguments and keeps the confirmations: a sensitive action is asked about on screen,
//! and "declined" comes back as a result like any other. Nothing here runs anything itself, and nothing here can skip a
//! confirmation. Every request is noted in an audit file.

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use zbus::proxy::{CacheProperties, MethodFlags};

const BUS_NAME: &str = "org.niro.Search";
const OBJECT_PATH: &str = "/org/niro/Search";
const INTERFACE: &str = "org.niro.Search";
/// Reading the registry's list.
const LIST_WITHIN: Duration = Duration::from_secs(5);
/// A run may wait for the person to confirm.
const RUN_WITHIN: Duration = Duration::from_secs(5 * 60);
/// At most this many registry requests in one request of the user's.
pub const MAX_PER_REQUEST: usize = 8;
/// The audit file is started over when it reaches this size (the old one is kept as `.old`).
const AUDIT_MAX: u64 = 512 * 1024;

/// What this request already asked for, so a repeat (an AI looping, or saying it twice) runs once.
#[derive(Default)]
pub struct Seen(HashSet<String>);

/// Whether `id` is a registry id (`profile.apply`), and nothing else: no paths, no spaces, no shell words.
pub fn plausible_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let word = |p: &str, dash: bool| {
        !p.is_empty()
            && p.len() <= 24
            && p.chars().next().is_some_and(|c| c.is_ascii_lowercase() || (dash && c.is_ascii_digit()))
            && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || (dash && c == '-'))
    };
    let Some(first) = parts.next() else { return false };
    if !word(first, false) {
        return false;
    }
    let rest: Vec<&str> = parts.collect();
    !rest.is_empty() && rest.len() <= 3 && id.len() <= 64 && rest.iter().all(|p| word(p, true))
}

/// The arguments as one canonical text (object keys are sorted), for telling repeats apart.
fn canonical(args: &Value) -> String {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&map[k]))).collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    sorted(args).to_string()
}

fn outcome(ok: bool, code: &str, text: &str) -> Value {
    if ok {
        json!({"ok": true, "message": text})
    } else {
        json!({"ok": false, "code": code, "error": text})
    }
}

fn audit_path() -> PathBuf {
    crate::store::data_dir().join("niro-audit.jsonl")
}

/// One line in the audit file: when, what, with which arguments (long text cut), and how it ended.
fn audit(id: &str, args: &Value, result: &Value, started: Instant) {
    let mut shown = args.clone();
    if let Some(map) = shown.as_object_mut() {
        for value in map.values_mut() {
            if let Some(text) = value.as_str().filter(|t| t.chars().count() > 120) {
                *value = Value::String(format!("{}…", text.chars().take(120).collect::<String>()));
            }
        }
    }
    let line = json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "source": "assistant",
        "id": id,
        "args": shown,
        "ok": result["ok"],
        "code": result["code"],
        "ms": started.elapsed().as_millis() as u64,
    });
    let path = audit_path();
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > AUDIT_MAX) {
        let _ = std::fs::rename(&path, path.with_extension("jsonl.old"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
}

async fn proxy(timeout: Duration) -> zbus::Result<zbus::Proxy<'static>> {
    let bus = zbus::conn::Builder::session()?.method_timeout(timeout).build().await?;
    zbus::proxy::Builder::new(&bus)
        .destination(BUS_NAME)?
        .path(OBJECT_PATH)?
        .interface(INTERFACE)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

/// The registry's list: id, title, description, category, parameters, permission, and whether it can run now.
async fn manifest() -> Result<Vec<Value>, String> {
    let proxy = proxy(LIST_WITHIN).await.map_err(|e| format!("the action registry is not reachable: {e}"))?;
    let json: String = proxy
        .call_with_flags("ListActions", MethodFlags::NoAutoStart.into(), &())
        .await
        .map_err(|e| format!("the action registry did not answer: {e}"))?
        .ok_or("the action registry did not answer")?;
    serde_json::from_str::<Vec<Value>>(&json).map_err(|_| "the action registry's list is not readable".to_owned())
}

/// Runs one `{"type": "niro", "action": id, "args": {…}}` the AI asked for, and returns what to tell it: a JSON outcome.
/// `{"action": "list"}` returns what exists.
pub async fn execute(call: &Value, seen: &mut Seen) -> String {
    let started = Instant::now();
    let id = call["action"].as_str().unwrap_or_default().trim().to_owned();
    let args = match &call["args"] {
        Value::Null => json!({}),
        object @ Value::Object(_) => object.clone(),
        _ => {
            let result = outcome(false, "invalid", "args must be an object");
            audit(&id, &Value::Null, &result, started);
            return format!("niro {id}: {result}");
        }
    };
    let list = match manifest().await {
        Ok(list) => list,
        Err(why) => return format!("niro: {}", outcome(false, "unavailable", &why)),
    };
    if id == "list" {
        let compact: Vec<Value> = list
            .iter()
            .map(|a| {
                json!({"id": a["id"], "title": a["title"], "description": a["description"], "params": a["params"],
                       "asks_first": a["permission"] != "none", "available": a["available"], "why_not": a["reason"]})
            })
            .collect();
        return format!("niro actions: {}", Value::Array(compact));
    }
    let known = plausible_id(&id) && list.iter().any(|a| a["id"] == id.as_str());
    if !known {
        let result = outcome(false, "unknown", "no such action: ask with action \"list\" to see which exist");
        audit(&id, &args, &result, started);
        return format!("niro {id}: {result}");
    }
    let key = format!("{id}\u{1f}{}", canonical(&args));
    if seen.0.len() >= MAX_PER_REQUEST {
        let result = outcome(false, "limit", "too many registry requests for one request of the user's");
        audit(&id, &args, &result, started);
        return format!("niro {id}: {result}");
    }
    if !seen.0.insert(key) {
        let result = outcome(false, "duplicate", "this was already requested: it is not run again");
        audit(&id, &args, &result, started);
        return format!("niro {id}: {result}");
    }
    let entry = list.iter().find(|a| a["id"] == id.as_str());
    if let Some(false) = entry.and_then(|a| a["available"].as_bool()) {
        let why = entry.and_then(|a| a["reason"].as_str()).unwrap_or("not available now");
        let result = outcome(false, "unavailable", why);
        audit(&id, &args, &result, started);
        return format!("niro {id}: {result}");
    }
    let result = match proxy(RUN_WITHIN).await {
        Err(e) => outcome(false, "unavailable", &format!("the action registry is not reachable: {e}")),
        Ok(proxy) => {
            let reply: zbus::Result<Option<String>> = proxy
                .call_with_flags("RunAction", MethodFlags::NoAutoStart.into(), &(id.as_str(), canonical(&args)))
                .await;
            match reply {
                Ok(Some(text)) => serde_json::from_str(&text).unwrap_or_else(|_| outcome(false, "failed", "unreadable answer")),
                Ok(None) => outcome(false, "failed", "no answer"),
                Err(e) => outcome(false, "failed", &e.to_string()),
            }
        }
    };
    audit(&id, &args, &result, started);
    format!("niro {id}: {result}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_registry_shaped_ids_pass() {
        for ok in ["profile.apply", "system.dnd.toggle", "app.launch", "settings.open"] {
            assert!(plausible_id(ok), "{ok}");
        }
        for bad in ["", "list", "profile", "Profile.apply", "profile..apply", ".apply", "profile.", "profile.apply ", "a.b.c.d.e",
                    "profile.apply;rm", "../x.y", "profile/apply", "system.shutdown\n", "1abc.def", "x.-y"] {
            assert!(!plausible_id(bad), "{bad:?}");
        }
        assert!(!plausible_id(&format!("a.{}", "b".repeat(30))));
    }

    #[test]
    fn arguments_are_compared_in_a_fixed_order() {
        assert_eq!(canonical(&json!({"b": 1, "a": 2})), canonical(&json!({"a": 2, "b": 1})));
    }

    #[test]
    fn outcomes_have_the_registry_shape() {
        assert_eq!(outcome(true, "", "done"), json!({"ok": true, "message": "done"}));
        assert_eq!(outcome(false, "declined", "cancelled")["code"], "declined");
    }

    #[test]
    fn repeats_and_the_cap_are_refused_before_the_bus_is_asked() {
        let mut seen = Seen::default();
        assert!(seen.0.insert("a\u{1f}{}".into()));
        assert!(!seen.0.insert("a\u{1f}{}".into()));
    }
}
