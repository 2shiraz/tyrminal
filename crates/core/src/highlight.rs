//! Highlight patterns (TRM-07): user regular expressions restricted to a subset whose matching
//! cost stays bounded. The renderer compiles them with JavaScript's engine, which backtracks,
//! so the shapes that make backtracking explode are refused here, at the persistence boundary,
//! and again in the UI; the UI also runs them off the main thread under a time limit.
//!
//! Refused: backreferences, lookaround and named groups (`(?` other than `(?:`), repeating a
//! group (`)*`, `)+`, `){n}`), more than `MAX_PATTERN_UNBOUNDED` unbounded repetitions, counts
//! above `MAX_PATTERN_REPEAT`, a stray `{`, and control or invisible characters.

use tyrminal_contracts::IpcError;
use tyrminal_contracts::limits::{MAX_HIGHLIGHT_PATTERN_LEN, MAX_PATTERN_REPEAT, MAX_PATTERN_UNBOUNDED};

use crate::error::invalid;

fn is_deceptive(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200B}'..='\u{200F}' | '\u{FEFF}')
}

/// Parses `{n}`, `{n,}` or `{n,m}` at `chars[at]`; returns (length, open-ended).
fn repetition(chars: &[char], at: usize) -> Result<(usize, bool), IpcError> {
    let bad = || invalid("Write a literal { as \\{. A count is {n}, {n,} or {n,m}.");
    let end = chars[at..].iter().position(|&c| c == '}').map(|p| at + p).ok_or_else(bad)?;
    let body: String = chars[at + 1..end].iter().collect();
    let (low, high) = match body.split_once(',') {
        None => (body.as_str(), Some(body.as_str())),
        Some((low, "")) => (low, None),
        Some((low, high)) => (low, Some(high)),
    };
    let number = |s: &str| -> Result<u32, IpcError> {
        if s.is_empty() || s.len() > 4 || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        s.parse::<u32>().map_err(|_| bad())
    };
    let low = number(low)?;
    let high = high.map(number).transpose()?;
    if low > MAX_PATTERN_REPEAT || high.is_some_and(|h| h > MAX_PATTERN_REPEAT || h < low) {
        return Err(invalid("A repetition count in a highlight pattern can be 256 at most."));
    }
    Ok((end - at + 1, high.is_none()))
}

pub(crate) fn check_pattern(pattern: &str) -> Result<(), IpcError> {
    let count = pattern.chars().count();
    if count == 0 || count > MAX_HIGHLIGHT_PATTERN_LEN {
        return Err(invalid("A highlight pattern must be 1 to 128 characters."));
    }
    if pattern.chars().any(is_deceptive) {
        return Err(invalid("The pattern contains control or invisible characters."));
    }
    let chars: Vec<char> = pattern.chars().collect();
    let repeated_group =
        || invalid("A group cannot be repeated in a highlight pattern; repeat a character or a [set] instead.");
    let mut i = 0;
    let mut in_class = false;
    let mut depth = 0usize;
    let mut unbounded = 0usize;
    let mut after_group = false;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let next = chars.get(i + 1).ok_or_else(|| invalid("The pattern ends with a lone \\."))?;
            if !in_class && (matches!(next, '1'..='9') || *next == 'k') {
                return Err(invalid("Backreferences are not supported in highlight patterns."));
            }
            i += 2;
            after_group = false;
            continue;
        }
        if in_class {
            if c == ']' {
                in_class = false;
            }
            i += 1;
            continue;
        }
        match c {
            '[' => in_class = true,
            '(' => {
                if chars.get(i + 1) == Some(&'?') {
                    if chars.get(i + 2) != Some(&':') {
                        return Err(invalid(
                            "Lookahead, lookbehind and named groups are not supported in highlight patterns.",
                        ));
                    }
                    i += 2;
                }
                depth += 1;
            }
            ')' => {
                depth = depth.checked_sub(1).ok_or_else(|| invalid("The pattern has an unmatched )."))?;
                i += 1;
                after_group = true;
                continue;
            }
            '*' | '+' => {
                if after_group {
                    return Err(repeated_group());
                }
                unbounded += 1;
            }
            '{' => {
                if after_group {
                    return Err(repeated_group());
                }
                let (len, open) = repetition(&chars, i)?;
                if open {
                    unbounded += 1;
                }
                i += len;
                continue;
            }
            '}' => return Err(invalid("Write a literal } as \\}.")),
            _ => {}
        }
        after_group = false;
        i += 1;
    }
    if in_class {
        return Err(invalid("The pattern has an unclosed [."));
    }
    if depth != 0 {
        return Err(invalid("The pattern has an unclosed (."));
    }
    if unbounded > MAX_PATTERN_UNBOUNDED {
        return Err(invalid("A highlight pattern can repeat without limit (*, +) three times at most."));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::check_pattern;

    #[test]
    fn useful_patterns_are_accepted() {
        for ok in [
            r"error|fail(ed)?",
            r"\bWARN(ING)?\b",
            r"[A-Z]{3}-\d{1,6}",
            r"(?:GET|POST) /\S+",
            r"\d+ms",
            r"[(){}*+]+",
            r"\\",
            r"\{x\}",
            r"[0-9a-f]{40}",
            r"user=\w+ id=\d+",
        ] {
            assert!(check_pattern(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn shapes_that_backtrack_without_bound_are_refused() {
        for bad in [
            r"(a+)+$",
            r"(a|aa)*b",
            r"(?:x+x+)+y",
            r"(\w+\s?){5}",
            r"(a)\1",
            r"(?<w>a)\k<w>",
            r"(?=a)a",
            r"(?!a)b",
            r"(?<=a)b",
            r"(?<!a)b",
            r"\w*\w*\w*\w*x",
            r"a{1,300}",
            r"a{2,1}",
            r"a{99999}",
            r"a{",
            r"a}",
            r"(a",
            r"a)",
            r"[a",
            "\\",
            "",
            "x\u{1b}[31m",
            "x\u{202e}y",
        ] {
            assert!(check_pattern(bad).is_err(), "{bad:?}");
        }
        assert!(check_pattern(&"a".repeat(129)).is_err());
        assert!(check_pattern(&"a".repeat(128)).is_ok());
    }
}
