// SPDX-License-Identifier: GPL-3.0-or-later

//! opencode: a plugin Island writes into opencode's own plugins folder (`~/.config/opencode/plugins/niro-island.js`). opencode loads
//! it by itself; it runs `island-daemon --agent-hook opencode` with what opencode reports: it needs a permission, asks a question,
//! or has finished. It only tells: opencode asks its questions and permissions in its own window as it always did (a plugin of
//! another program must not decide for the user, and opencode's own answering call is not one to rely on across versions).
//! The plugin is a file of Island's alone, marked, so a file of the user's by that name is never touched.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

use super::file;

/// What marks the file as Island's; the plugin's first line says it.
const MARK: &str = "niro-island-opencode-plugin";

/// opencode's config folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_default().join("opencode")
}

/// Where the plugin goes: opencode loads every `.js` or `.ts` file of this folder.
pub fn plugin_path() -> PathBuf {
    config_dir().join("plugins").join("niro-island.js")
}

/// Whether Island's plugin is in place.
pub fn hooked(path: &Path) -> bool {
    file::read(path)
        .ok()
        .flatten()
        .is_some_and(|text| text.contains(MARK))
}

/// Writes the plugin, pointing at `islandd`. Refuses a file of that name that is not Island's.
pub fn install(path: &Path, islandd: &str) -> anyhow::Result<()> {
    if let Some(text) = file::read(path).with_context(|| format!("could not read {}", path.display()))?
        && !text.contains(MARK)
    {
        bail!("{} is not Island's own plugin file", path.display());
    }
    file::write_atomic(path, &plugin_source(islandd))
        .with_context(|| format!("could not write {}", path.display()))
}

/// Takes the plugin out again; false if it was not there. A file that is not Island's stays.
pub fn remove(path: &Path) -> anyhow::Result<bool> {
    match file::read(path).with_context(|| format!("could not read {}", path.display()))? {
        Some(text) if text.contains(MARK) => {
            std::fs::remove_file(path)
                .with_context(|| format!("could not remove {}", path.display()))?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// The plugin: opencode calls the exported function once and gives it the project's folder; `event` then gets every event, of which
/// three matter. Every failure stays inside the plugin: it never gets in opencode's way.
pub fn plugin_source(islandd: &str) -> String {
    // A JSON string is also a JavaScript one.
    let command = serde_json::to_string(islandd).unwrap_or_else(|_| "\"island-daemon\"".into());
    PLUGIN.replace("__ISLANDD__", &command)
}

const PLUGIN: &str = r#"// niro-island-opencode-plugin
// Written by Niro Control (Island) so the island can tell you when opencode needs you or has finished. Turn the alert off in
// Settings, and Island removes this file. Do not edit it: the next time it is turned on, it is written again.
import { spawn } from "node:child_process";

const ISLANDD = __ISLANDD__;

// One report, the way Claude Code's hooks make theirs: JSON on island-daemon's input. Nothing here may throw.
function report(payload) {
  try {
    const child = spawn(ISLANDD, ["--agent-hook", "opencode"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  } catch (_error) {
    // No island-daemon: nothing to tell.
  }
}

const words = (value) => (typeof value === "string" ? value.trim() : "");

export const NiroIsland = async (context) => {
  const cwd = words(context && context.directory) || process.cwd();
  return {
    event: async ({ event }) => {
      try {
        const type = event && event.type;
        const props = (event && event.properties) || {};
        const session = words(props.sessionID) || words(props.info && props.info.id);
        if (type === "permission.asked" || type === "permission.updated" || type === "permission.v2.asked") {
          const what = words(props.permission) || words(props.type) || words(props.title) || "a tool";
          const target = Array.isArray(props.patterns) ? words(props.patterns[0]) : words(props.pattern);
          report({
            hook_event_name: "Notification",
            notification_type: "permission_prompt",
            message: target ? `Permission for ${what}: ${target}` : `Permission for ${what}`,
            session_id: session,
            cwd,
          });
        } else if (type === "question.asked" || type === "question.v2.asked") {
          const first = Array.isArray(props.questions) ? props.questions[0] : null;
          report({
            hook_event_name: "Notification",
            notification_type: "elicitation_dialog",
            message: words(first && first.question) || "opencode has a question",
            session_id: session,
            cwd,
          });
        } else if (type === "session.idle" || (type === "session.status" && props.status && props.status.type === "idle")) {
          report({ hook_event_name: "Stop", session_id: session, cwd });
        }
      } catch (_error) {
        // Never in opencode's way.
      }
    },
  };
};
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::file::tests::scratch;

    #[test]
    fn installs_a_marked_plugin_that_runs_this_daemon() {
        let dir = scratch("opencode-install");
        let path = dir.join("plugins/niro-island.js");
        assert!(!hooked(&path));
        install(&path, "/usr/bin/island-daemon").unwrap();
        assert!(hooked(&path));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("// niro-island-opencode-plugin"));
        assert!(text.contains(r#"const ISLANDD = "/usr/bin/island-daemon";"#), "{text}");
        assert!(text.contains(r#""--agent-hook", "opencode""#));
        // Put in again (a new island-daemon after an update): the same file, pointing at the new one.
        install(&path, "/opt/island/island-daemon").unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains(r#""/opt/island/island-daemon""#));
        assert!(remove(&path).unwrap());
        assert!(!path.exists());
        assert!(!remove(&path).unwrap());
    }

    #[test]
    fn a_path_with_quotes_stays_one_javascript_string() {
        let source = plugin_source("/home/o\"brien/island daemon");
        assert!(source.contains(r#"const ISLANDD = "/home/o\"brien/island daemon";"#), "{source}");
    }

    #[test]
    fn a_file_of_the_users_with_the_same_name_is_never_touched() {
        let dir = scratch("opencode-theirs");
        let path = dir.join("niro-island.js");
        std::fs::write(&path, "export const Mine = async () => ({});\n").unwrap();
        assert!(!hooked(&path));
        assert!(install(&path, "/usr/bin/island-daemon").is_err());
        assert!(!remove(&path).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "export const Mine = async () => ({});\n");
    }
}
