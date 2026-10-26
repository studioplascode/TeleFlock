//! 5-field cron schedules in the host's local time zone: parsing, next fire times (DST-safe)
//! and a plain-English description.
//!
//! Syntax: `minute hour day-of-month month day-of-week`, each field `*`, `a`, `a-b`, `*/n`,
//! `a-b/n`, `a/n` or a comma list of those; month names `jan`–`dec`, weekday names
//! `sun`–`sat` (0 and 7 are Sunday). Macros: `@hourly @daily @midnight @weekly @monthly
//! @yearly @annually`. As in classic cron, when both day fields are restricted (neither starts
//! with `*`) a day matches when either does.
//!
//! Daylight saving (as Vixie cron): a time that does not exist (skipped hour in spring) runs
//! once right after the jump when the hour field is specific, and not at all for jobs that run
//! every hour; a time that exists twice (repeated hour in autumn) runs once (the first one)
//! when the hour field is specific, and both times for jobs that run every hour.

use jiff::civil::{Date, DateTime};
use jiff::tz::{AmbiguousOffset, TimeZone};
use jiff::Timestamp;

use tf_proto::Millis;

/// Upper bound of a DST shift: civil times further than this from a reference instant's civil
/// time cannot map across it.
const MARGIN_HOURS: i64 = 2;
/// Days scanned for the next run before a schedule counts as never firing (covers Feb 29 on a
/// given weekday, which recurs within 28 years).
const MAX_SCAN_DAYS: i32 = 366 * 29;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: u64,
    hours: u32,
    doms: u32,
    months: u16,
    /// Bit 0 = Sunday … bit 6 = Saturday.
    dows: u8,
    dom_star: bool,
    dow_star: bool,
    /// Source fields (after macro expansion), for the description.
    fields: [String; 5],
}

struct FieldSpec {
    name: &'static str,
    min: u32,
    max: u32,
    names: &'static [&'static str],
}

const MINUTE: FieldSpec = FieldSpec { name: "minute", min: 0, max: 59, names: &[] };
const HOUR: FieldSpec = FieldSpec { name: "hour", min: 0, max: 23, names: &[] };
const DOM: FieldSpec = FieldSpec { name: "day of month", min: 1, max: 31, names: &[] };
const MONTH: FieldSpec = FieldSpec {
    name: "month",
    min: 1,
    max: 12,
    names: &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
};
const DOW: FieldSpec = FieldSpec { name: "day of week", min: 0, max: 7, names: &["sun", "mon", "tue", "wed", "thu", "fri", "sat"] };

const MONTH_NAMES: [&str; 12] =
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

fn value(spec: &FieldSpec, s: &str) -> Result<u32, String> {
    let lower = s.to_ascii_lowercase();
    if let Some(i) = spec.names.iter().position(|n| *n == lower) {
        return Ok(i as u32 + if spec.min == 1 { 1 } else { 0 });
    }
    let v: u32 = s.parse().map_err(|_| format!("`{s}` is not a valid {}", spec.name))?;
    if v < spec.min || v > spec.max {
        return Err(format!("{} {v} is out of range ({}–{})", spec.name, spec.min, spec.max));
    }
    Ok(v)
}

/// Parses one field into a bit set (bit `v` = value `v`).
fn field(spec: &FieldSpec, text: &str) -> Result<u64, String> {
    if text.is_empty() {
        return Err(format!("{} is empty", spec.name));
    }
    let mut bits = 0u64;
    for part in text.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: u32 = s.parse().map_err(|_| format!("`{s}` is not a valid step in the {} field", spec.name))?;
                if step == 0 || step > spec.max {
                    return Err(format!("step {step} is out of range in the {} field", spec.name));
                }
                (r, step)
            }
            None => (part, 1),
        };
        let (lo, hi) = if range == "*" {
            (spec.min, spec.max)
        } else if let Some((a, b)) = range.split_once('-') {
            let (a, b) = (value(spec, a)?, value(spec, b)?);
            if a > b {
                return Err(format!("range {range} runs backwards in the {} field", spec.name));
            }
            (a, b)
        } else {
            let a = value(spec, range)?;
            // `a/n` means from `a` to the end of the range.
            (a, if step > 1 || part.contains('/') { spec.max } else { a })
        };
        let mut v = lo;
        while v <= hi {
            bits |= 1 << v;
            v += step;
        }
    }
    Ok(bits)
}

impl Cron {
    pub fn parse(expr: &str) -> Result<Cron, String> {
        let expr = expr.trim();
        let expanded = match expr.to_ascii_lowercase().as_str() {
            "@hourly" => "0 * * * *",
            "@daily" | "@midnight" => "0 0 * * *",
            "@weekly" => "0 0 * * 0",
            "@monthly" => "0 0 1 * *",
            "@yearly" | "@annually" => "0 0 1 1 *",
            s if s.starts_with('@') => return Err(format!("unknown schedule `{expr}`")),
            _ => expr,
        };
        let parts: Vec<&str> = expanded.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(format!(
                "a schedule has 5 fields (minute hour day-of-month month day-of-week), got {}",
                parts.len()
            ));
        }
        let minutes = field(&MINUTE, parts[0])?;
        let hours = field(&HOUR, parts[1])? as u32;
        let doms = field(&DOM, parts[2])? as u32;
        let months = field(&MONTH, parts[3])? as u16;
        let mut dows = field(&DOW, parts[4])?;
        if dows & (1 << 7) != 0 {
            dows = (dows | 1) & 0x7f;
        }
        let cron = Cron {
            minutes,
            hours,
            doms,
            months,
            dows: dows as u8,
            dom_star: parts[2].starts_with('*'),
            dow_star: parts[4].starts_with('*'),
            fields: std::array::from_fn(|i| parts[i].to_string()),
        };
        Ok(cron)
    }

    fn day_matches(&self, d: Date) -> bool {
        if self.months & (1 << d.month()) == 0 {
            return false;
        }
        let dom = self.doms & (1 << d.day()) != 0;
        let dow = self.dows & (1 << d.weekday().to_sunday_zero_offset()) != 0;
        match (self.dom_star, self.dow_star) {
            (true, true) => true,
            (true, false) => dow,
            (false, true) => dom,
            (false, false) => dom || dow,
        }
    }

    /// The first fire time strictly after `after` (epoch ms), in `tz`.
    pub fn next_after(&self, after: Millis, tz: &TimeZone) -> Option<Millis> {
        let after_ts = Timestamp::from_millisecond(after).ok()?;
        let after_dt = after_ts.to_zoned(tz.clone()).datetime();
        // Civil times this far before `after` cannot map past it (DST shifts are ≤ 2 h).
        let floor = after_dt.checked_sub(jiff::SignedDuration::from_hours(MARGIN_HOURS)).ok()?;
        // Start a day early: a fold can map the previous civil day's times past `after`.
        let mut day = floor.date();
        for _ in 0..MAX_SCAN_DAYS {
            if self.day_matches(day)
                && let Some(t) = self.first_on(day, floor, after_ts, tz)
            {
                return Some(t.as_millisecond());
            }
            day = day.tomorrow().ok()?;
        }
        None
    }

    /// The earliest fire instant on civil `day` that is after `after` (civil times before
    /// `floor` are skipped without a time-zone lookup).
    fn first_on(&self, day: Date, floor: DateTime, after: Timestamp, tz: &TimeZone) -> Option<Timestamp> {
        let mut best: Option<(Timestamp, DateTime)> = None;
        for h in (0..24).filter(|h| self.hours & (1 << h) != 0) {
            if let Some((_, civil)) = best
                && day.at(h as i8, 0, 0, 0) > civil.checked_add(jiff::SignedDuration::from_hours(MARGIN_HOURS)).ok()?
            {
                break;
            }
            for m in (0..60).filter(|m| self.minutes & (1u64 << m) != 0) {
                let dt = day.at(h as i8, m as i8, 0, 0);
                if dt < floor {
                    continue;
                }
                for t in self.instants(dt, tz) {
                    if t > after && best.is_none_or(|(b, _)| t < b) {
                        best = Some((t, dt));
                    }
                }
            }
        }
        best.map(|(t, _)| t)
    }

    /// The latest fire time in `(after, until]`.
    pub fn latest_between(&self, after: Millis, until: Millis, tz: &TimeZone) -> Option<Millis> {
        let after_ts = Timestamp::from_millisecond(after).ok()?;
        let until_ts = Timestamp::from_millisecond(until).ok()?;
        let first_day = after_ts.to_zoned(tz.clone()).date().yesterday().ok()?;
        let mut day = until_ts.to_zoned(tz.clone()).date().tomorrow().ok()?;
        for _ in 0..MAX_SCAN_DAYS {
            if day < first_day {
                return None;
            }
            if self.day_matches(day) {
                let latest = self
                    .times_on(day)
                    .flat_map(|dt| self.instants(dt, tz))
                    .filter(|t| *t > after_ts && *t <= until_ts)
                    .max();
                if let Some(t) = latest {
                    return Some(t.as_millisecond());
                }
            }
            day = day.yesterday().ok()?;
        }
        None
    }

    fn times_on(&self, day: Date) -> impl Iterator<Item = DateTime> + '_ {
        (0..24i8)
            .filter(|h| self.hours & (1 << h) != 0)
            .flat_map(move |h| (0..60i8).filter(|m| self.minutes & (1u64 << m) != 0).map(move |m| day.at(h, m, 0, 0)))
    }

    /// The hour field covers every hour (`*`, `*/1`, `0-23`): such jobs follow the clock
    /// through DST jumps instead of being moved.
    fn every_hour(&self) -> bool {
        self.hours == (1 << 24) - 1
    }

    /// The instants a civil fire time maps to (see the module docs for DST).
    fn instants(&self, dt: DateTime, tz: &TimeZone) -> Vec<Timestamp> {
        let amb = tz.to_ambiguous_timestamp(dt);
        match amb.offset() {
            AmbiguousOffset::Unambiguous { offset } => offset.to_timestamp(dt).ok().into_iter().collect(),
            AmbiguousOffset::Gap { after, .. } => {
                if self.every_hour() {
                    return vec![];
                }
                // Right after the jump: the first transition after this time read with the
                // post-jump offset.
                let Ok(early) = after.to_timestamp(dt) else { return vec![] };
                tz.following(early).next().map(|t| t.timestamp()).into_iter().collect()
            }
            AmbiguousOffset::Fold { before, after } => {
                let first = before.to_timestamp(dt).ok();
                let second = if self.every_hour() { after.to_timestamp(dt).ok() } else { None };
                first.into_iter().chain(second).collect()
            }
        }
    }

    /// Up to `n` fire times after `after`.
    pub fn upcoming(&self, after: Millis, n: usize, tz: &TimeZone) -> Vec<Millis> {
        let mut out = Vec::with_capacity(n);
        let mut cursor = after;
        while out.len() < n {
            match self.next_after(cursor, tz) {
                Some(t) => {
                    out.push(t);
                    cursor = t;
                }
                None => break,
            }
        }
        out
    }

    /// Plain-English reading, e.g. `At 09:00, Monday through Friday`.
    pub fn describe(&self) -> String {
        let [min, hour, ..] = &self.fields;
        let all_min = self.minutes == (1u64 << 60) - 1;
        let single_min = self.minutes.count_ones() == 1;
        let m0 = self.minutes.trailing_zeros();
        let time = if all_min && self.every_hour() {
            "Every minute".to_string()
        } else if self.every_hour() && let Some(n) = step_of(min, 59) {
            format!("Every {n} minutes")
        } else if single_min && self.every_hour() {
            format!("Every hour at :{m0:02}")
        } else if single_min && let Some(n) = step_of(hour, 23) {
            format!("Every {n} hours at :{m0:02}")
        } else if single_min && self.hours.count_ones() <= 6 {
            let times: Vec<String> = bits(u64::from(self.hours), 0, 23).map(|h| format!("{h:02}:{m0:02}")).collect();
            format!("At {}", join(&times))
        } else {
            let mins = if all_min {
                "Every minute".to_string()
            } else if let Some(n) = step_of(min, 59) {
                format!("Every {n} minutes")
            } else {
                format!("At minute {}", join(&ranges(self.minutes, 0, 59, |v| v.to_string())))
            };
            let hrs = if self.every_hour() {
                if mins.starts_with("At") { " past every hour".to_string() } else { String::new() }
            } else if let Some(n) = step_of(hour, 23) {
                format!(", every {n} hours")
            } else {
                format!(", past hour {}", join(&ranges(u64::from(self.hours), 0, 23, |v| format!("{v:02}"))))
            };
            format!("{mins}{hrs}")
        };
        let dow_text = || {
            let mask = self.dows;
            match mask {
                0b0111_1111 => "every day".to_string(),
                0b0011_1110 => "Monday through Friday".to_string(),
                0b0100_0001 => "on Saturday and Sunday".to_string(),
                _ => format!("on {}", join(&ranges(u64::from(mask), 0, 6, |v| DAY_NAMES[v as usize].to_string()))),
            }
        };
        let dom_text = || {
            let days = ranges(u64::from(self.doms), 1, 31, |v| v.to_string());
            format!("on day{} {} of the month", if self.doms.count_ones() == 1 { "" } else { "s" }, join(&days))
        };
        let days = match (self.dom_star, self.dow_star) {
            (true, true) if self.doms == ALL_DOMS => "every day".to_string(),
            (true, true) => dom_text(),
            (true, false) => dow_text(),
            (false, true) => dom_text(),
            (false, false) => format!("{} or {}", dom_text(), dow_text()),
        };
        let months = if self.months == ALL_MONTHS {
            String::new()
        } else {
            format!(", in {}", join(&ranges(u64::from(self.months), 1, 12, |v| MONTH_NAMES[v as usize - 1].to_string())))
        };
        let days = if days == "every day" && (time.starts_with("Every") || self.every_hour()) { String::new() } else { format!(", {days}") };
        format!("{time}{days}{months}")
    }
}

const ALL_DOMS: u32 = ((1u64 << 32) - 2) as u32;
const ALL_MONTHS: u16 = ((1u32 << 13) - 2) as u16;

/// `n` for `*/n` (also `0/n`, `0-max/n`).
fn step_of(field: &str, max: u32) -> Option<u32> {
    let (range, step) = field.split_once('/')?;
    if field.contains(',') || !(range == "*" || range == "0" || range == format!("0-{max}")) {
        return None;
    }
    step.parse().ok().filter(|n| *n > 1)
}

fn bits(mask: u64, lo: u32, hi: u32) -> impl Iterator<Item = u32> {
    (lo..=hi).filter(move |v| mask & (1u64 << v) != 0)
}

/// Runs of consecutive values: `1 through 5`, single values as is.
fn ranges(mask: u64, lo: u32, hi: u32, name: impl Fn(u32) -> String) -> Vec<String> {
    let vals: Vec<u32> = bits(mask, lo, hi).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < vals.len() {
        let mut j = i;
        while j + 1 < vals.len() && vals[j + 1] == vals[j] + 1 {
            j += 1;
        }
        if j - i >= 2 {
            out.push(format!("{} through {}", name(vals[i]), name(vals[j])));
        } else {
            out.extend(vals[i..=j].iter().map(|v| name(*v)));
        }
        i = j + 1;
    }
    out
}

fn join(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// The host's time zone (system setting).
pub fn local_tz() -> TimeZone {
    TimeZone::system()
}

/// IANA name of `tz`, else its current UTC offset (`UTC+02:00`).
pub fn tz_name(tz: &TimeZone) -> String {
    match tz.iana_name() {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => {
            let off = tz.to_offset(Timestamp::now());
            if off.seconds() == 0 { "UTC".to_string() } else { format!("UTC{off}") }
        }
    }
}

/// `yyyymmdd-hhmm` of `at` in `tz` (automation branch names).
pub fn stamp(at: Millis, tz: &TimeZone) -> String {
    Timestamp::from_millisecond(at).map(|t| t.to_zoned(tz.clone()).strftime("%Y%m%d-%H%M").to_string()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn berlin() -> TimeZone {
        TimeZone::posix("CET-1CEST,M3.5.0,M10.5.0/3").unwrap()
    }

    fn ms(s: &str, tz: &TimeZone) -> Millis {
        let dt: DateTime = s.parse().unwrap();
        tz.to_ambiguous_timestamp(dt).earlier().unwrap().as_millisecond()
    }

    fn show(t: Millis, tz: &TimeZone) -> String {
        Timestamp::from_millisecond(t).unwrap().to_zoned(tz.clone()).strftime("%Y-%m-%d %H:%M %:z").to_string()
    }

    fn next_n(expr: &str, from: &str, n: usize, tz: &TimeZone) -> Vec<String> {
        Cron::parse(expr).unwrap().upcoming(ms(from, tz), n, tz).into_iter().map(|t| show(t, tz)).collect()
    }

    #[test]
    fn parses_and_rejects() {
        assert!(Cron::parse("*/15 9-17 * * mon-fri").is_ok());
        assert!(Cron::parse("@daily").is_ok());
        assert!(Cron::parse("0 0 * JAN,Jul 7").is_ok());
        assert!(Cron::parse("5/10 * * * *").is_ok());
        assert!(Cron::parse("* * * *").unwrap_err().contains("5 fields"));
        assert!(Cron::parse("60 * * * *").unwrap_err().contains("out of range"));
        assert!(Cron::parse("* * * * 8").is_err());
        assert!(Cron::parse("*/0 * * * *").is_err());
        assert!(Cron::parse("5-1 * * * *").is_err());
        assert!(Cron::parse("@reboot").is_err());
        assert!(Cron::parse("x * * * *").is_err());
    }

    #[test]
    fn next_runs_basic() {
        let tz = TimeZone::UTC;
        assert_eq!(next_n("*/15 * * * *", "2026-01-05T10:07", 3, &tz), ["2026-01-05 10:15 +00:00", "2026-01-05 10:30 +00:00", "2026-01-05 10:45 +00:00"]);
        // Weekdays only: Friday 9:00 → Monday 9:00.
        assert_eq!(next_n("0 9 * * 1-5", "2026-01-09T09:00", 2, &tz), ["2026-01-12 09:00 +00:00", "2026-01-13 09:00 +00:00"]);
        // `7` is Sunday; 2026-01-11 is a Sunday.
        assert_eq!(next_n("0 0 * * 7", "2026-01-05T00:00", 1, &tz), ["2026-01-11 00:00 +00:00"]);
        // Both day fields restricted: OR (the 1st, or any Monday).
        assert_eq!(next_n("0 8 1 * mon", "2026-01-27T09:00", 3, &tz), ["2026-02-01 08:00 +00:00", "2026-02-02 08:00 +00:00", "2026-02-09 08:00 +00:00"]);
        // Feb 29 only in leap years.
        assert_eq!(next_n("0 0 29 2 *", "2026-01-01T00:00", 1, &tz), ["2028-02-29 00:00 +00:00"]);
        // Never fires.
        assert_eq!(Cron::parse("0 0 30 2 *").unwrap().next_after(0, &tz), None);
    }

    #[test]
    fn dst_spring_forward() {
        let tz = berlin();
        // 2026-03-29: 02:00 CET jumps to 03:00 CEST. A specific time in the gap runs right after.
        assert_eq!(next_n("30 2 * * *", "2026-03-28T12:00", 3, &tz), ["2026-03-29 03:00 +02:00", "2026-03-30 02:30 +02:00", "2026-03-31 02:30 +02:00"]);
        // Every-hour jobs skip the missing hour (no burst of duplicates).
        assert_eq!(
            next_n("0,30 * * * *", "2026-03-29T01:00", 4, &tz),
            ["2026-03-29 01:30 +01:00", "2026-03-29 03:00 +02:00", "2026-03-29 03:30 +02:00", "2026-03-29 04:00 +02:00"]
        );
        // Two specific times in the gap fold into one run.
        assert_eq!(next_n("0,30 2 * * *", "2026-03-29T00:00", 2, &tz), ["2026-03-29 03:00 +02:00", "2026-03-30 02:00 +02:00"]);
    }

    #[test]
    fn dst_fall_back() {
        let tz = berlin();
        // 2026-10-25: 03:00 CEST goes back to 02:00 CET; 02:30 happens twice.
        assert_eq!(next_n("30 2 * * *", "2026-10-24T12:00", 2, &tz), ["2026-10-25 02:30 +02:00", "2026-10-26 02:30 +01:00"]);
        assert_eq!(
            next_n("30 * * * *", "2026-10-25T01:45", 3, &tz),
            ["2026-10-25 02:30 +02:00", "2026-10-25 02:30 +01:00", "2026-10-25 03:30 +01:00"]
        );
        // Strictly after: from the first 02:30 a daily job moves to the next day.
        let first = Cron::parse("30 2 * * *").unwrap().next_after(ms("2026-10-24T12:00", &tz), &tz).unwrap();
        assert_eq!(show(Cron::parse("30 2 * * *").unwrap().next_after(first, &tz).unwrap(), &tz), "2026-10-26 02:30 +01:00");
    }

    #[test]
    fn latest_missed_run() {
        let tz = TimeZone::UTC;
        let c = Cron::parse("0 * * * *").unwrap();
        let from = ms("2026-01-05T10:00", &tz);
        assert_eq!(c.latest_between(from, ms("2026-01-05T13:20", &tz), &tz).map(|t| show(t, &tz)).as_deref(), Some("2026-01-05 13:00 +00:00"));
        assert_eq!(c.latest_between(from, ms("2026-01-05T10:59", &tz), &tz), None);
        // A very old cursor still finds the latest one.
        let old = ms("2025-01-01T00:00", &tz);
        let m = Cron::parse("* * * * *").unwrap();
        assert_eq!(m.latest_between(old, ms("2026-01-05T10:07", &tz), &tz).map(|t| show(t, &tz)).as_deref(), Some("2026-01-05 10:07 +00:00"));
    }

    #[test]
    fn describes() {
        let d = |s: &str| Cron::parse(s).unwrap().describe();
        assert_eq!(d("* * * * *"), "Every minute");
        assert_eq!(d("*/15 * * * *"), "Every 15 minutes");
        assert_eq!(d("5 * * * *"), "Every hour at :05");
        assert_eq!(d("0 */2 * * *"), "Every 2 hours at :00");
        assert_eq!(d("0 9 * * *"), "At 09:00, every day");
        assert_eq!(d("0 9 * * 1-5"), "At 09:00, Monday through Friday");
        assert_eq!(d("0 9,17 * * 1,3,5"), "At 09:00 and 17:00, on Monday, Wednesday and Friday");
        assert_eq!(d("@monthly"), "At 00:00, on day 1 of the month");
        assert_eq!(d("0 9 1 1 *"), "At 09:00, on day 1 of the month, in January");
        assert_eq!(d("0 10 * * sat,sun"), "At 10:00, on Saturday and Sunday");
        assert_eq!(d("*/10 9-17 * * 1-5"), "Every 10 minutes, past hour 09 through 17, Monday through Friday");
        assert_eq!(d("5,35 * * * *"), "At minute 5 and 35 past every hour");
        assert_eq!(d("5,35 * * * 1-5"), "At minute 5 and 35 past every hour, Monday through Friday");
    }
}
