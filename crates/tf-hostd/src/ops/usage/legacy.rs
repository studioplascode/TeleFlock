//! The `host.usage` answer of apps < 0.7.0 (requests without `view`): today, the last `days`
//! host-local days and per-model totals, from the same index the insights read.

use std::path::Path;

use chrono::{Days, Local};
use tf_proto::{ApiError, UsageDay, UsageModel, UsageReport, UsageTotals};

use crate::ops::host::open_ro;

fn sql_err(e: rusqlite::Error) -> ApiError {
    ApiError::new("io_error", format!("stats.db: {e}"))
}

/// Today (host-local day), the last `days` local days (oldest first, zero-filled) and per-model
/// totals over that window. `input` = input + cache read + cache write tokens.
pub(crate) fn usage(db: &Path, days: u32) -> Result<UsageReport, ApiError> {
    let empty = || UsageTotals { cost_usd: 0.0, tokens: 0, input: 0, output: 0 };
    let Some(conn) = open_ro(db)? else {
        return Ok(UsageReport { today: Some(empty()), days: Some(zero_days(days)), models: Some(vec![]), index: None, insights: None, unchanged: None, live: None });
    };
    let today = conn
        .query_row(
            "SELECT COALESCE(SUM(cost_total),0), COALESCE(SUM(total_tokens),0),
                    COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens),0), COALESCE(SUM(output_tokens),0)
             FROM messages
             WHERE timestamp >= CAST(strftime('%s','now','localtime','start of day','utc') AS INTEGER) * 1000",
            [],
            |r| Ok(UsageTotals { cost_usd: r.get(0)?, tokens: r.get::<_, i64>(1)? as u64, input: r.get::<_, i64>(2)? as u64, output: r.get::<_, i64>(3)? as u64 }),
        )
        .map_err(sql_err)?;
    let back = format!("-{} days", days.saturating_sub(1));
    let mut stmt = conn
        .prepare(
            "WITH RECURSIVE d(day) AS (
                 SELECT date('now','localtime', ?1)
                 UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < date('now','localtime')
             ),
             agg AS (
                 SELECT date(timestamp/1000,'unixepoch','localtime') AS day, SUM(cost_total) AS cost, SUM(total_tokens) AS tokens
                 FROM messages
                 WHERE timestamp >= CAST(strftime('%s', date('now','localtime', ?1), 'utc') AS INTEGER) * 1000
                 GROUP BY 1
             )
             SELECT d.day, COALESCE(agg.cost,0), COALESCE(agg.tokens,0) FROM d LEFT JOIN agg ON agg.day = d.day ORDER BY d.day",
        )
        .map_err(sql_err)?;
    let days_v = stmt
        .query_map([&back], |r| Ok(UsageDay { day: r.get(0)?, cost_usd: r.get(1)?, tokens: r.get::<_, i64>(2)? as u64 }))
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT provider || '/' || model, SUM(cost_total), SUM(total_tokens) FROM messages
             WHERE timestamp >= CAST(strftime('%s', date('now','localtime', ?1), 'utc') AS INTEGER) * 1000
             GROUP BY provider, model ORDER BY 2 DESC, 3 DESC",
        )
        .map_err(sql_err)?;
    let models = stmt
        .query_map([&back], |r| Ok(UsageModel { model: r.get(0)?, cost_usd: r.get(1)?, tokens: r.get::<_, i64>(2)? as u64 }))
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(UsageReport { today: Some(today), days: Some(days_v), models: Some(models), index: None, insights: None, unchanged: None, live: None })
}

/// The last `days` host-local dates, oldest first, stepping calendar days (a DST day is still
/// one day).
fn zero_days(days: u32) -> Vec<UsageDay> {
    let today = Local::now().date_naive();
    (0..days.max(1))
        .rev()
        .filter_map(|i| today.checked_sub_days(Days::new(u64::from(i))))
        .map(|d| UsageDay { day: d.format("%Y-%m-%d").to_string(), cost_usd: 0.0, tokens: 0 })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The schema before omp-stats grew its later columns: the legacy answer needs only these.
    fn old_fixture(path: &Path) {
        let c = rusqlite::Connection::open(path).unwrap();
        c.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_file TEXT, model TEXT, provider TEXT, timestamp INTEGER,
               input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
               total_tokens INTEGER, cost_total REAL);",
        )
        .unwrap();
        let now = crate::util::now_ms();
        let rows = [
            (now, "m1", "p", 10, 5, 100, 0, 115, 1.5),
            (now, "m2", "q", 1, 1, 0, 0, 2, 0.25),
            (now - 2 * 86_400_000, "m1", "p", 1000, 0, 0, 0, 1000, 10.0),
            (now - 40 * 86_400_000, "m1", "p", 1, 1, 1, 1, 4, 99.0),
        ];
        for (ts, model, prov, i, o, cr, cw, t, cost) in rows {
            c.execute(
                "INSERT INTO messages (session_file, model, provider, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total) VALUES ('f',?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![model, prov, ts, i, o, cr, cw, t, cost],
            )
            .unwrap();
        }
    }

    #[test]
    fn legacy_report_from_stats_db() {
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("stats.db");
        old_fixture(&db);
        let r = usage(&db, 7).unwrap();
        let today = r.today.unwrap();
        assert!((today.cost_usd - 1.75).abs() < 1e-9);
        assert_eq!((today.tokens, today.input, today.output), (117, 111, 6));
        let days = r.days.unwrap();
        assert_eq!(days.len(), 7);
        assert_eq!(days.last().unwrap().day, crate::util::local_day(crate::util::now_ms()));
        assert!((days.iter().map(|d| d.cost_usd).sum::<f64>() - 11.75).abs() < 1e-9);
        let models = r.models.unwrap();
        assert_eq!(models[0].model, "p/m1");
        assert!((models[0].cost_usd - 11.5).abs() < 1e-9);
        // The new fields stay off the legacy answer.
        assert!(r.index.is_none() && r.insights.is_none() && r.live.is_none());
        let missing = usage(&td.path().join("nope.db"), 3).unwrap();
        let days = missing.days.unwrap();
        assert_eq!(days.len(), 3);
        assert!(missing.models.unwrap().is_empty());
        // Calendar steps: consecutive distinct dates ending today.
        assert_eq!(days.last().unwrap().day, crate::util::local_day(crate::util::now_ms()));
        assert!(days.windows(2).all(|w| w[0].day < w[1].day));
    }
}
