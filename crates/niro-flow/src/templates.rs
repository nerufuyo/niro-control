//! Built-in workflow templates, as JSON text a UI can offer and `parse()` / `validate()` can check.

pub struct Template {
    pub id: &'static str,
    pub title: &'static str,
    pub json: &'static str,
}

/// The registry actions the templates use; they are real ids of Search's action registry (a test checks them against
/// `shell/search/actions.ts` when the repository is at hand). No template toggles anything: every one is safe to run twice.
pub const TEMPLATE_ACTIONS: [&str; 2] = ["profile.apply", "layout.restore"];

pub const TEMPLATES: [Template; 4] = [
    Template {
        id: "coding-focus",
        title: "Coding focus",
        json: r#"{"version":1,"id":"coding-focus","name":"Coding focus","enabled":false,"allow":["settings"],
            "trigger":{"type":"app_focused","app":"code"},"steps":[
            {"kind":"action","id":"profile","name":"profile.apply","args":{"id":"deep-work"},"next":null}]}"#,
    },
    Template {
        id: "low-battery-everyday",
        title: "Low battery: back to Everyday",
        json: r#"{"version":1,"id":"low-battery-everyday","name":"Low battery: back to Everyday","enabled":false,"allow":["settings"],
            "trigger":{"type":"battery_below","percent":20},"steps":[
            {"kind":"action","id":"profile","name":"profile.apply","args":{"id":"everyday"},"next":null}]}"#,
    },
    Template {
        id: "meeting-mode",
        title: "Meeting mode",
        json: r#"{"version":1,"id":"meeting-mode","name":"Meeting mode","enabled":false,"allow":["settings","window"],
            "trigger":{"type":"app_launched","app":"zoom"},"steps":[
            {"kind":"action","id":"profile","name":"profile.apply","args":{"id":"deep-work"},"next":"layout"},
            {"kind":"action","id":"layout","name":"layout.restore","args":{"name":"Meeting"},"next":null}]}"#,
    },
    Template {
        id: "evening-wind-down",
        title: "Evening wind down",
        json: r#"{"version":1,"id":"evening-wind-down","name":"Evening wind down","enabled":false,"allow":["settings"],
            "trigger":{"type":"schedule","at":"22:00"},"steps":[
            {"kind":"action","id":"profile","name":"profile.apply","args":{"id":"everyday"},"next":null}]}"#,
    },
];

pub fn template(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{parse, validate};

    #[test]
    fn every_template_parses_and_validates_and_ships_disabled() {
        for t in &TEMPLATES {
            let w = parse(t.json).unwrap_or_else(|e| panic!("{}: {e}", t.id));
            assert_eq!(w.id, t.id);
            assert!(!w.enabled, "{} must start disabled", t.id);
            assert_eq!(validate(&w, &TEMPLATE_ACTIONS), Vec::<String>::new(), "{}", t.id);
        }
    }

    /// The names are checked against the registry's source when this repository is checked out whole.
    #[test]
    fn template_actions_are_real_registry_ids() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../shell/search/actions.ts");
        let Ok(source) = std::fs::read_to_string(path) else { return };
        for a in TEMPLATE_ACTIONS {
            assert!(source.contains(&format!("id: '{a}'")), "{a} is not registered in Search");
        }
        for t in &TEMPLATES {
            let w = parse(t.json).unwrap();
            assert!(!w.allow.is_empty(), "{} must name what it may do", t.id);
        }
    }

    #[test]
    fn template_ids_are_unique_and_every_action_has_a_capability() {
        let mut ids: Vec<_> = TEMPLATES.iter().map(|t| t.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), TEMPLATES.len());
        assert!(TEMPLATE_ACTIONS.iter().all(|a| crate::permissions::capability_for(a).is_some()));
        assert!(template("meeting-mode").is_some() && template("nope").is_none());
    }
}
