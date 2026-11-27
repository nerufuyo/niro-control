// SPDX-License-Identifier: GPL-3.0-or-later

//! Flow's files: one JSON file per workflow under `~/.config/niro/flow/workflows/`, the on/off switch beside them
//! (`flow.enabled`), and the ledger and history under the state directory. Writes are atomic (temp file, fsync,
//! rename) and private (0600); a file that cannot be read or is not a valid workflow is reported, never fatal.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use niro_flow::Workflow;
use serde::Serialize;

use crate::store::create_private_dir;

/// Where everything lives; tests point it at a temporary folder.
#[derive(Debug, Clone)]
pub struct Paths {
    pub workflows: PathBuf,
    pub enabled: PathBuf,
    pub ledger: PathBuf,
    pub history: PathBuf,
}

impl Paths {
    pub fn standard() -> Paths {
        let config = dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("niro").join("flow");
        let state = dirs::state_dir()
            .or_else(dirs::data_dir)
            .unwrap_or_else(std::env::temp_dir)
            .join("niro")
            .join("flow");
        Paths {
            workflows: config.join("workflows"),
            enabled: config.join("flow.enabled"),
            ledger: state.join("ledger.json"),
            history: state.join("history.json"),
        }
    }

    #[cfg(test)]
    pub fn under(root: &Path) -> Paths {
        Paths {
            workflows: root.join("config/workflows"),
            enabled: root.join("config/flow.enabled"),
            ledger: root.join("state/ledger.json"),
            history: root.join("state/history.json"),
        }
    }
}

/// A file in the workflows folder that could not be used, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadProblem {
    pub file: String,
    pub error: String,
}

/// Temp file in the same folder, fsync, rename, fsync the folder: a crash leaves the old file or the new one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::other("no parent folder"))?;
    create_private_dir(parent)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = parent.join(format!(".{name}.tmp"));
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)?;
    fs::File::open(parent)?.sync_all()
}

/// The id as a file name: nothing that could leave the folder or hide a file.
pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('.') && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn file_of(paths: &Paths, id: &str) -> PathBuf {
    paths.workflows.join(format!("{id}.json"))
}

/// Every valid workflow file, sorted by id, and a note for each file that is not. Only the workflow's own shape is
/// checked here (the registry may not be running); the action names are checked on save and again at run time.
pub fn load_all(paths: &Paths) -> (Vec<Workflow>, Vec<LoadProblem>) {
    let mut workflows: Vec<Workflow> = Vec::new();
    let mut problems = Vec::new();
    let entries = match fs::read_dir(&paths.workflows) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return (workflows, problems),
        Err(err) => {
            problems.push(LoadProblem { file: paths.workflows.display().to_string(), error: format!("cannot read the folder: {err}") });
            return (workflows, problems);
        }
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json") && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .collect();
    files.sort();
    for path in files {
        let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let bad = |error: String| LoadProblem { file: file.clone(), error };
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) => {
                problems.push(bad(format!("cannot read: {err}")));
                continue;
            }
        };
        let wf = match niro_flow::parse(&text) {
            Ok(wf) => wf,
            Err(err) => {
                problems.push(bad(err));
                continue;
            }
        };
        let issues = structural_problems(&wf);
        if !issues.is_empty() {
            problems.push(bad(issues.join("; ")));
            continue;
        }
        if path.file_stem().is_some_and(|s| s.to_string_lossy() != wf.id) {
            problems.push(bad(format!("the file name does not match the workflow id \"{}\"", wf.id)));
            continue;
        }
        if workflows.iter().any(|w| w.id == wf.id) {
            problems.push(bad(format!("a second workflow with the id \"{}\"", wf.id)));
            continue;
        }
        workflows.push(wf);
    }
    (workflows, problems)
}

/// `validate()` without the registry: every action name the workflow uses counts as known.
pub fn structural_problems(wf: &Workflow) -> Vec<String> {
    let names: Vec<&str> = wf
        .steps
        .iter()
        .filter_map(|s| if let niro_flow::Step::Action { name, .. } = s { Some(name.as_str()) } else { None })
        .collect();
    let mut problems = niro_flow::validate(wf, &names);
    if !safe_id(&wf.id) {
        problems.push("workflow id may not start with a dot".into());
    }
    problems
}

pub fn save(paths: &Paths, wf: &Workflow) -> io::Result<()> {
    let text = serde_json::to_string_pretty(wf).map_err(io::Error::other)?;
    write_atomic(&file_of(paths, &wf.id), text.as_bytes())
}

/// Flips `enabled` in the file as it is now, so hand edits and fields this version does not know survive.
pub fn set_enabled(paths: &Paths, id: &str, on: bool) -> Result<Workflow, String> {
    let path = file_of(paths, id);
    let text = fs::read_to_string(&path).map_err(|e| format!("could not read the workflow: {e}"))?;
    let mut wf = niro_flow::parse(&text)?;
    let issues = structural_problems(&wf);
    if wf.id != id || !issues.is_empty() {
        return Err(format!("the workflow file was changed and cannot be used, so it was left alone: {}", issues.join("; ")));
    }
    let mut raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    raw["enabled"] = on.into();
    wf.enabled = on;
    let text = serde_json::to_string_pretty(&raw).map_err(|e| e.to_string())?;
    write_atomic(&path, text.as_bytes()).map_err(|e| format!("could not write the workflow: {e}"))?;
    Ok(wf)
}

pub fn delete(paths: &Paths, id: &str) -> io::Result<()> {
    match fs::remove_file(file_of(paths, id)) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// The on/off switch: `NIRO_FLOW_ENABLED` (1/0, true/false, on/off) wins, then the `flow.enabled` file; off when neither.
pub fn read_enabled(paths: &Paths) -> bool {
    let env = std::env::var("NIRO_FLOW_ENABLED").ok();
    parse_switch(env.as_deref()).or_else(|| parse_switch(fs::read_to_string(&paths.enabled).ok().as_deref())).unwrap_or(false)
}

fn parse_switch(text: Option<&str>) -> Option<bool> {
    match text?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn write_enabled(paths: &Paths, on: bool) -> io::Result<()> {
    write_atomic(&paths.enabled, if on { b"true\n" } else { b"false\n" })
}

pub fn read_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("niro-flow-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn wf(id: &str) -> Workflow {
        niro_flow::parse(&format!(
            r#"{{"version":1,"id":"{id}","trigger":{{"type":"manual"}},"allow":["settings"],"steps":[{{"kind":"action","id":"a","name":"profile.apply","args":{{"id":"deep-work"}},"next":null}}]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn a_saved_workflow_comes_back_private_and_sorted() {
        let root = tmp("roundtrip");
        let paths = Paths::under(&root);
        save(&paths, &wf("b")).unwrap();
        save(&paths, &wf("a")).unwrap();
        let (list, problems) = load_all(&paths);
        assert_eq!(list.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(problems.is_empty());
        assert_eq!(list[0].allow, ["settings"]);
        let mode = fs::metadata(file_of(&paths, "a")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // No temp file is left behind.
        assert!(fs::read_dir(&paths.workflows).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        delete(&paths, "a").unwrap();
        delete(&paths, "a").unwrap();
        assert_eq!(load_all(&paths).0.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bad_files_are_reported_and_the_good_ones_still_load() {
        let root = tmp("bad");
        let paths = Paths::under(&root);
        save(&paths, &wf("good")).unwrap();
        fs::write(paths.workflows.join("junk.json"), "{not json").unwrap();
        fs::write(paths.workflows.join("shell.json"), r#"{"version":1,"id":"shell","trigger":{"type":"manual"},"steps":[{"kind":"shell","id":"a","cmd":"ls"}]}"#).unwrap();
        fs::write(paths.workflows.join("loop.json"), r#"{"version":1,"id":"loop","trigger":{"type":"manual"},"steps":[{"kind":"action","id":"a","name":"x.y","args":{},"next":"a"}]}"#).unwrap();
        let mut renamed = serde_json::to_string(&wf("other")).unwrap();
        renamed.push('\n');
        fs::write(paths.workflows.join("wrongname.json"), renamed).unwrap();
        fs::write(paths.workflows.join("notes.txt"), "ignored").unwrap();
        let (list, problems) = load_all(&paths);
        assert_eq!(list.len(), 1);
        let files: Vec<&str> = problems.iter().map(|p| p.file.as_str()).collect();
        assert_eq!(files, ["junk.json", "loop.json", "shell.json", "wrongname.json"]);
        assert!(problems[1].error.contains("loop"));
        assert!(problems[3].error.contains("does not match"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_id_cannot_escape_the_folder() {
        for bad in ["", ".hidden", "..", "a/b", "../x", "a b", &"x".repeat(65)] {
            assert!(!safe_id(bad), "{bad:?}");
        }
        assert!(safe_id("coding-focus") && safe_id("a.b_c"));
    }

    #[test]
    fn the_switch_is_off_unless_asked() {
        let root = tmp("switch");
        let paths = Paths::under(&root);
        // NIRO_FLOW_ENABLED is not set by the test run.
        if std::env::var_os("NIRO_FLOW_ENABLED").is_none() {
            assert!(!read_enabled(&paths));
            write_enabled(&paths, true).unwrap();
            assert!(read_enabled(&paths));
            write_enabled(&paths, false).unwrap();
            assert!(!read_enabled(&paths));
            fs::write(&paths.enabled, "garbage").unwrap();
            assert!(!read_enabled(&paths));
        }
        assert_eq!(parse_switch(Some(" On\n")), Some(true));
        assert_eq!(parse_switch(Some("0")), Some(false));
        assert_eq!(parse_switch(None), None);
        let _ = fs::remove_dir_all(root);
    }
}
