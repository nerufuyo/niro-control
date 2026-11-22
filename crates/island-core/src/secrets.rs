// SPDX-License-Identifier: GPL-3.0-or-later

//! Does copied text look like a secret? The same heuristics as `shell/shared/clipboardTools.js` (`sensitiveKind`),
//! plus bearer tokens. It errs toward flagging: a false alarm only means one copy is not remembered.

/// Why text looks like a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    PrivateKey,
    Token,
    Jwt,
    Card,
    PasswordLine,
    LongSecret,
}

fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Every position of `prefix` in `text` that starts a word (not preceded by a word character).
fn starts<'a>(text: &'a str, prefix: &'a str) -> impl Iterator<Item = &'a str> {
    text.match_indices(prefix).filter_map(move |(i, _)| {
        let before = text[..i].chars().next_back();
        before.is_none_or(|c| !word(c)).then(|| &text[i + prefix.len()..])
    })
}

/// Length in characters of the leading run of characters accepted by `ok`.
fn run(text: &str, ok: impl Fn(char) -> bool) -> usize {
    text.chars().take_while(|c| ok(*c)).count()
}

fn is_private_key(t: &str) -> bool {
    t.match_indices("-----BEGIN ").any(|(i, m)| {
        let rest = &t[i + m.len()..];
        let n = run(rest, |c| c.is_ascii_uppercase() || c == ' '); // ASCII only, so bytes = chars
        rest[..n].ends_with("PRIVATE KEY") && rest[n..].starts_with("-----")
    })
}

fn has_token(t: &str) -> bool {
    // AKIA / ASIA + exactly 16 upper-case letters or digits, then a word boundary.
    for prefix in ["AKIA", "ASIA"] {
        for rest in starts(t, prefix) {
            let n = run(rest, |c| c.is_ascii_digit() || c.is_ascii_uppercase());
            if n >= 16 && !rest.chars().nth(16).is_some_and(word) {
                return true;
            }
        }
    }
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if starts(t, prefix).any(|rest| run(rest, |c| c.is_ascii_alphanumeric()) >= 30) {
            return true;
        }
    }
    for prefix in ["xoxa-", "xoxb-", "xoxp-"] {
        if starts(t, prefix).any(|rest| run(rest, |c| c.is_ascii_alphanumeric() || c == '-') >= 10) {
            return true;
        }
    }
    if starts(t, "sk-").any(|rest| run(rest, |c| c.is_ascii_alphanumeric() || c == '_' || c == '-') >= 20) {
        return true;
    }
    // `Bearer <token>`: a long opaque value after the word.
    let lower = t.to_ascii_lowercase();
    starts(&lower, "bearer").any(|rest| {
        let rest = rest.trim_start_matches([' ', '\t']);
        !rest.is_empty() && run(rest, |c| c.is_ascii_alphanumeric() || "-._~+/=".contains(c)) >= 20
    })
}

fn is_jwt(t: &str) -> bool {
    let parts: Vec<&str> = t.split('.').collect();
    let body = |s: &str| s.chars().all(|c| word(c) || c == '-');
    parts.len() == 3
        && parts[0].starts_with("eyJ")
        && parts[1].starts_with("eyJ")
        && parts[0].len() > 3
        && parts[1].len() > 3
        && body(parts[0])
        && body(parts[1])
        && body(parts[2])
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.chars().rev().enumerate() {
        let mut d = c.to_digit(10).unwrap_or(0);
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

fn is_card(t: &str) -> bool {
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') {
        return false;
    }
    let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    (13..=19).contains(&digits.len()) && luhn(&digits)
}

fn is_password_line(t: &str) -> bool {
    const KEYS: [&str; 8] = ["password", "passwd", "pwd", "passphrase", "secret", "api_key", "api-key", "apikey"];
    t.lines().any(|line| {
        let l = line.trim_start().to_ascii_lowercase();
        let rest = KEYS.iter().chain(["token"].iter()).find_map(|k| l.strip_prefix(k));
        let Some(rest) = rest else { return false };
        let rest = rest.trim_start();
        rest.strip_prefix([':', '=']).is_some_and(|v| v.trim_start().chars().next().is_some_and(|c| !c.is_whitespace()))
    })
}

fn is_long_secret(t: &str) -> bool {
    t.chars().count() >= 32
        && !t.chars().any(char::is_whitespace)
        && t.chars().any(|c| c.is_ascii_alphabetic())
        && t.chars().any(|c| c.is_ascii_digit())
        && t.chars().all(|c| c.is_ascii_alphanumeric() || "+/_=-".contains(c))
}

/// Why `text` looks like a secret, or `None`.
pub fn sensitive_kind(text: &str) -> Option<SecretKind> {
    let t = text.trim();
    if is_private_key(t) {
        return Some(SecretKind::PrivateKey);
    }
    if has_token(t) {
        return Some(SecretKind::Token);
    }
    if is_jwt(t) {
        return Some(SecretKind::Jwt);
    }
    if is_card(t) {
        return Some(SecretKind::Card);
    }
    if is_password_line(t) {
        return Some(SecretKind::PasswordLine);
    }
    if is_long_secret(t) {
        return Some(SecretKind::LongSecret);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every value here is made up for the test.
    #[test]
    fn private_keys_tokens_and_jwts() {
        assert_eq!(sensitive_kind("-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKE\n-----END RSA PRIVATE KEY-----"), Some(SecretKind::PrivateKey));
        assert_eq!(sensitive_kind("-----BEGIN PRIVATE KEY-----"), Some(SecretKind::PrivateKey));
        assert_eq!(sensitive_kind("-----BEGIN PUBLIC KEY-----\nabc"), None);
        // Built at run time: a literal in the shape of a real key would trip a secret scanner on push.
        assert_eq!(sensitive_kind(&format!("key {}{} here", "AKIA", "FAKE".repeat(4))), Some(SecretKind::Token));
        assert_eq!(sensitive_kind(&format!("{}_{}", "ghp", "FAKE".repeat(9))), Some(SecretKind::Token));
        assert_eq!(sensitive_kind("xoxb-FAKE-FAKE-FAKE"), Some(SecretKind::Token));
        assert_eq!(sensitive_kind(&format!("{}-{}", "sk", "FAKE".repeat(6))), Some(SecretKind::Token));
        assert_eq!(sensitive_kind("Authorization: Bearer fake.fake.fake.fake.fake"), Some(SecretKind::Token));
        assert_eq!(sensitive_kind("eyJfake.eyJfake.fake_sig"), Some(SecretKind::Jwt));
        assert_eq!(sensitive_kind("eyJfake.notjwt.x"), None);
    }

    #[test]
    fn cards_password_lines_and_long_strings() {
        assert_eq!(sensitive_kind("4111 1111 1111 1111"), Some(SecretKind::Card));
        assert_eq!(sensitive_kind("4111 1111 1111 1112"), None);
        assert_eq!(sensitive_kind("user\n  Password = fakepass"), Some(SecretKind::PasswordLine));
        assert_eq!(sensitive_kind("API_KEY: fake"), Some(SecretKind::PasswordLine));
        assert_eq!(sensitive_kind("password:"), None);
        assert_eq!(sensitive_kind("token is fine"), None);
        assert_eq!(sensitive_kind("Fake1Fake2Fake3Fake4Fake5Fake6Fake7"), Some(SecretKind::LongSecret));
        assert_eq!(sensitive_kind("justlettersjustlettersjustlettersjustletters"), None, "needs a digit");
        assert_eq!(sensitive_kind("has some spaces 1 and is long enough to pass 32 chars"), None);
    }

    #[test]
    fn ordinary_text_is_not_flagged() {
        for t in ["hello world", "https://example.com/a/b", "2026-01-05", "ask-for-skills sk-short", "cargo build --release"] {
            assert_eq!(sensitive_kind(t), None, "{t}");
        }
    }
}
