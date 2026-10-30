import type { UsageSpan, WrappedModel, WrappedPr, WrappedReport, WrappedSubagent } from "@/core/gen";
import { formatCompact } from "@/design/lib/format";

/*
 * Flock Wrapped: the week's card, from every host's `host.wrapped` answer. Hosts send additive
 * facts; everything that depends on the reader's clock (the week, nights, labels) is decided here.
 * Definitions (also in the feature README):
 * - Agents run: omp sessions with requests in the week; subagent runs and automation runs beside.
 * - Unattended work: the time agents worked on their own (requests and the tool runs between
 *   them; a pause over 10 min or a prompt of yours ends a stretch), added up over agents.
 * - Lines changed: added + removed lines of your non-merge commits in the week, in the
 *   repositories the agents worked in (lock files and GitHub's merge commits left out); a commit
 *   two hosts both have counts once.
 * - PRs merged: your pull requests merged in the week in those repositories (gh on each host).
 * - Longest overnight streak: the longest stretch with an agent working (pauses ≤ 10 min) that
 *   ran through part of a night (00:00–06:00 local).
 * - Fastest model: the highest average output speed (omp's tokens/s per request) among models
 *   with at least 5 timed requests.
 * - Busiest subagent: the subagent (by task name) with the most requests, its steps.
 */

export const BRIDGE_MS = 10 * 60_000;
export const NIGHT_END_HOUR = 6;
export const FASTEST_MIN_REQUESTS = 5;
const HOUR = 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A local calendar week, Monday 00:00 to the next Monday 00:00. `back`: 0 = this week. */
export interface Week {
  since: number;
  until: number;
  back: number;
}

export function weekOf(now: number, back = 0): Week {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * back);
  const since = d.getTime();
  d.setDate(d.getDate() + 7);
  return { since, until: d.getTime(), back };
}

/** Minutes past each UTC hour at which local hours start (`host.usage`'s `hourOffset`). */
export function hourOffset(at: number): number {
  return (((-new Date(at).getTimezoneOffset()) % 60) + 60) % 60;
}

export interface Span {
  start: number;
  end: number;
}

/** Spans merged where they overlap or the pause between them is at most `bridge`, ascending. */
export function unionSpans(spans: readonly UsageSpan[], bridge = BRIDGE_MS): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).toSorted((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= bridge) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

export interface ModelSpeed {
  provider: string;
  model: string;
  requests: number;
  /** Average output speed, tokens/s. */
  tps: number;
}

export interface RepoLines {
  name: string;
  added: number;
  removed: number;
  commits: number;
}

/** Every host's answer added up. */
export interface WrappedFacts {
  agents: number;
  subagents: number;
  automationRuns: number;
  workMs: number;
  busy: Span[];
  models: WrappedModel[];
  crew: WrappedSubagent[];
  commits: number;
  added: number;
  removed: number;
  /** Most changed first. */
  repos: RepoLines[];
  /** `null`: no host could ask GitHub. Newest first. */
  prs: WrappedPr[] | null;
  /** Why something is missing (gh, unreadable repositories), once each. */
  notes: string[];
  /** A host still asks git or GitHub. */
  pending: boolean;
  /** A host's omp index is syncing: figures may still grow. */
  indexing: boolean;
  /** Hosts whose omp index does not exist yet. */
  unindexed: number;
}

/** Adds the hosts' answers up; `hosts[i]` names `reports[i]` in the notes. */
export function mergeReports(reports: readonly WrappedReport[], hosts: readonly string[] = []): WrappedFacts {
  const f: WrappedFacts = { agents: 0, subagents: 0, automationRuns: 0, workMs: 0, busy: [], models: [], crew: [], commits: 0, added: 0, removed: 0, repos: [], prs: null, notes: [], pending: false, indexing: false, unindexed: 0 };
  const spans: UsageSpan[] = [];
  const models = new Map<string, WrappedModel>();
  const crew = new Map<string, WrappedSubagent>();
  const shas = new Set<string>();
  const repos = new Map<string, RepoLines>();
  const prs = new Map<string, WrappedPr>();
  const notes = new Set<string>();
  let askedGitHub = false;
  for (const [i, r] of reports.entries()) {
    const from = hosts[i] ? `${hosts[i]}: ` : "";
    f.agents += r.agents;
    f.subagents += r.subagents;
    f.automationRuns += r.automationRuns;
    f.workMs += r.workMs;
    spans.push(...r.busy);
    for (const m of r.models) {
      const key = `${m.provider}/${m.model}`;
      const had = models.get(key);
      models.set(key, had ? { ...had, requests: had.requests + m.requests, tps: had.tps + m.tps, tpsN: had.tpsN + m.tpsN } : { ...m });
    }
    for (const s of r.crew) {
      const had = crew.get(s.name);
      crew.set(s.name, had ? { name: s.name, requests: had.requests + s.requests, tokens: had.tokens + s.tokens, output: had.output + s.output, costUsd: had.costUsd + s.costUsd } : { ...s });
    }
    for (const c of r.code?.commits ?? []) {
      if (shas.has(c.sha)) continue;
      shas.add(c.sha);
      f.commits += 1;
      f.added += c.added;
      f.removed += c.removed;
      const repo = repos.get(c.repo) ?? { name: c.repo, added: 0, removed: 0, commits: 0 };
      repo.added += c.added;
      repo.removed += c.removed;
      repo.commits += 1;
      repos.set(c.repo, repo);
    }
    for (const repo of r.code?.repos ?? []) if (repo.error) notes.add(`${from}git could not read ${repo.name} (${repo.error})`);
    if (r.prs) {
      askedGitHub = true;
      for (const p of r.prs) if (!prs.has(p.url)) prs.set(p.url, p);
    }
    if (r.prsNote) notes.add(`${from}${r.prsNote}`);
    if (r.pending) f.pending = true;
    if (r.index?.syncing) f.indexing = true;
    if (r.index && !r.index.ready) f.unindexed += 1;
  }
  f.busy = unionSpans(spans);
  f.models = [...models.values()];
  f.crew = [...crew.values()];
  f.repos = [...repos.values()].toSorted((a, b) => b.added + b.removed - (a.added + a.removed) || a.name.localeCompare(b.name));
  f.prs = askedGitHub ? [...prs.values()].toSorted((a, b) => b.mergedAt - a.mergedAt) : null;
  f.notes = [...notes];
  return f;
}

/** Local midnights from the one at or before `start` through `end`. */
function midnights(start: number, end: number): number[] {
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  const out: number[] = [];
  while (d.getTime() < end) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** The span ran through part of a local night (00:00 until `NIGHT_END_HOUR`). */
export function isOvernight(s: Span): boolean {
  return midnights(s.start, s.end).some((m) => {
    const dawn = new Date(m);
    dawn.setHours(NIGHT_END_HOUR, 0, 0, 0);
    return s.start < dawn.getTime() && s.end > m;
  });
}

/** The longest stretch that ran through part of a night (the earliest of equals). */
export function longestOvernight(busy: readonly Span[]): Span | null {
  let best: Span | null = null;
  for (const s of busy) if (isOvernight(s) && (!best || s.end - s.start > best.end - best.start)) best = s;
  return best;
}

export function fastestModel(models: readonly WrappedModel[]): ModelSpeed | null {
  let best: ModelSpeed | null = null;
  for (const m of models) {
    if (m.tpsN < FASTEST_MIN_REQUESTS) continue;
    const tps = m.tps / m.tpsN;
    if (!best || tps > best.tps || (tps === best.tps && m.requests > best.requests)) best = { provider: m.provider, model: m.model, requests: m.requests, tps };
  }
  return best;
}

export function topSubagent(crew: readonly WrappedSubagent[]): WrappedSubagent | null {
  let best: WrappedSubagent | null = null;
  for (const s of crew) {
    if (s.requests <= 0) continue;
    if (!best || s.requests > best.requests || (s.requests === best.requests && (s.output > best.output || (s.output === best.output && s.name < best.name)))) best = s;
  }
  return best;
}

// ───────────────────────────── words ─────────────────────────────

/** "41 h", "6.5 h", "35 min". */
export function formatWork(ms: number): string {
  if (ms <= 0) return "0 h";
  const h = ms / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 10) return `${Number(h.toFixed(1))} h`;
  return `${Math.round(h).toLocaleString("en-US")} h`;
}

/** "6 h 10 min", "45 min", "12 h". */
export function formatSpan(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Tue 22:40" in local time. */
export function formatMoment(at: number): string {
  const d = new Date(at);
  return `${DAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Oct 26 – Nov 1, 2026" (the week's last day is the day before `until`). */
export function formatRange(week: Week): string {
  const a = new Date(week.since);
  const b = new Date(week.until - 1);
  const left = `${MONTHS[a.getMonth()]} ${a.getDate()}${a.getFullYear() !== b.getFullYear() ? `, ${a.getFullYear()}` : ""}`;
  const right = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() ? `${b.getDate()}` : `${MONTHS[b.getMonth()]} ${b.getDate()}`;
  return `${left} – ${right}, ${b.getFullYear()}`;
}

export function formatPeriod(back: number): string {
  if (back === 0) return "This week so far";
  if (back === 1) return "Last week";
  return `${back} weeks ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** Exact below 10,000, compact above ("12.4K"). */
export function formatCount(n: number): string {
  return n < 10_000 ? Math.round(n).toLocaleString("en-US") : formatCompact(n);
}

// ───────────────────────────── the card ─────────────────────────────

export type StatKey = "agents" | "lines" | "prs" | "overnight" | "fastest" | "crew";

export interface CardStat {
  key: StatKey;
  label: string;
  value: string;
  detail: string;
  /** Nothing to show (the value is a dash). */
  empty: boolean;
}

export interface WrappedCard {
  period: string;
  range: string;
  hero: { value: string; caption: string; detail: string; empty: boolean };
  stats: CardStat[];
  footer: string;
  /** Everything on the card as one sentence (the image's text alternative). */
  summary: string;
}

/** Shortest readable model id: drop a trailing date stamp (`-20250929`). */
export function shortModel(model: string): string {
  return model.replace(/[-@]\d{8}$/, "");
}

export function buildCard(f: WrappedFacts, week: Week, hosts: number): WrappedCard {
  const night = longestOvernight(f.busy);
  const fast = fastestModel(f.models);
  const top = topSubagent(f.crew);
  const lines = f.added + f.removed;
  const agentsDetail = [f.subagents > 0 && plural(f.subagents, "subagent"), f.automationRuns > 0 && `${formatCount(f.automationRuns)} from automations`].filter(Boolean).join(" · ");
  const prs = f.prs;
  const latest = prs?.[0];
  const stats: CardStat[] = [
    { key: "agents", label: "Agents run", value: formatCount(f.agents), detail: agentsDetail || (f.agents > 0 ? "no subagents" : "No agent worked this week"), empty: false },
    {
      key: "lines",
      label: "Lines changed",
      value: f.commits > 0 ? formatCount(lines) : "0",
      detail: f.commits > 0 ? `+${formatCount(f.added)} −${formatCount(f.removed)} · ${plural(f.commits, "commit")}` : f.pending ? "Counting commits…" : "No commits of yours",
      empty: false,
    },
    {
      key: "prs",
      label: "PRs merged",
      value: prs ? formatCount(prs.length) : "—",
      detail: latest ? `Latest: ${latest.title || `#${latest.number}`}` : prs ? "None merged" : f.pending ? "Asking GitHub…" : "GitHub not reachable",
      empty: !prs,
    },
    {
      key: "overnight",
      label: "Longest overnight streak",
      value: night ? formatSpan(night.end - night.start) : "—",
      detail: night ? `${formatMoment(night.start)} → ${formatMoment(night.end)}` : "Nobody worked through the night",
      empty: !night,
    },
    {
      key: "fastest",
      label: "Fastest model",
      value: fast ? shortModel(fast.model) : "—",
      detail: fast ? `${formatCount(Math.round(fast.tps))} tok/s · ${fast.provider}` : "Not enough requests yet",
      empty: !fast,
    },
    {
      key: "crew",
      label: "Busiest subagent",
      value: top ? top.name : "—",
      detail: top ? `${plural(top.requests, "step")} · ${formatCompact(top.tokens)} tokens` : "No subagents this week",
      empty: !top,
    },
  ];
  const hero = { value: formatWork(f.workMs), caption: "of unattended work", detail: "Agents working on their own between your prompts, added up", empty: f.workMs <= 0 };
  const range = formatRange(week);
  const footer = `${plural(hosts, "host")} · ${plural(f.agents, "agent")}`;
  const summary = [
    `Flock Wrapped, ${range}: ${hero.value} ${hero.caption}`,
    ...stats.map((s) => `${s.label}: ${s.value}${s.empty ? "" : ` (${s.detail})`}`),
  ].join(". ");
  return { period: formatPeriod(week.back), range, hero, stats, footer, summary: `${summary}.` };
}

/** `flock-wrapped-2026-10-26.png` (the week's Monday). */
export function fileName(week: Week): string {
  const d = new Date(week.since);
  return `flock-wrapped-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.png`;
}
