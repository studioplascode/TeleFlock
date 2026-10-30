# Usage (`#/usage`)

Spend, tokens and request insights from omp's own stats index on every host in view (`host.usage`,
hostd `ops/usage/`, architecture §3.16), next to the subscription limits (`host.limits`).

```ts
// src/features/usage/UsageView.tsx: the page
export function UsageView(): JSX.Element;
// src/features/usage/UsageTiles.tsx: Highlights, StreakTile (streaks + activity calendar), ModelsTile (cost, tok/s,
// first token), SpendersTile (agent types, providers, subagents, tiers), ProjectsTile, ToolsTile, HoursTile,
// SessionsTile, RecordsTile; usd() prints N/A for a $0 that only unpriced requests make.
// src/features/usage/usageData.ts (pure, usageData.test.ts): mergeInsights, daySeries, bars, activeDays, streaks,
// heatmap, hourProfile, derive (avg duration, TTFT, tok/s, cache rate and savings, error rate), formatSpanMs, projectName.
// src/features/usage/LimitsSection.tsx + limitsUi.ts: "Subscriptions & limits" (see the board README).
```

**Data** (`src/core/usage.ts`, exported from `@/core`):
- `useHostUsage(hostIds, range, everyMs)`: one shared poller per host and range (`today` = the board's summary;
  `7d` / `30d` / `90d` / `all` = insights), `null` subscribes without polling (inactive window). It sends the
  device's local midnight as `since`, its UTC offset mod 60 as `hourOffset` (hosts bucket on the device's local
  hours, so `:30` zones work) and the version it holds as `have` (an unchanged report costs nothing). While a host
  syncs its index it is asked again every 6 s. Every host keeps its **last good answer**: a failed request sets
  `error`, an offline host is not asked, and neither drops what was shown (`usageIsStale` flags it); answers persist
  in localStorage `tf.usage` (≤ 1.5 M chars, today's summaries first) so history shows before hosts reconnect.
- `calendar(tz?)`: local days and hours (this device, or a named zone in tests): day keys, DST-safe
  `startOfDay` / `addDays`, offsets. Hosts in other zones add up by absolute hour, never by their own date labels.
- `todaySpend` / `useTodaySpend(hostIds, everyMs, now)`: today on this device = each host's indexed hours since
  local midnight + what its live ledger saw since the host's last sync (`UsageLive`) + the ledger's growth since
  that answer (`HostState.usage`). Hosts without a report yet count their ledger alone (`approx`). The board's
  Today tile (`useTodayUsage` in `BentoRow.tsx`) and this page's Today tile use it, so they always agree.

**Page.** Today (live chip while live spend is not indexed yet, hourly mini bars, $/h pace on the device's day) and
limits; per-host freshness (synced N min ago, syncing, first indexing, offline/last report, sync failed); range
control (7/30/90 days/all) and a refresh that asks every host to sync now; headline cards (spend, requests and
error rate, cache hit rate and savings, agent time); spend per day (grouped into bars of several days on long
ranges; today's bar is the Today figure); streak + 18-week calendar; models; who spent it; projects; tools; hour of
day; records; top sessions; the board's agents. Costs are labelled API-equivalent estimates, unpriced requests
read N/A. Values jump (no springs on bars): calm by default (architecture §6.3). Phones stack every tile in one
column with the range control above the freshness line and a 14-week calendar.

**Demo.** `src/core/demo/usage.ts` answers `view` requests with four months of history per demo host.

**Tests.** `bun test src/features/usage` (calendar and DST, two host time zones merged into device days, streaks,
calendar, bars, last-good retention, today with live spend, persistence budget).
