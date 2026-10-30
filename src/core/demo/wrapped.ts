import type { UsageSpan, WrappedCommit, WrappedModel, WrappedPr, WrappedReport, WrappedSubagent } from "@/core/gen";
import { hash, Rng } from "./rng";

/*
 * `host.wrapped` on the demo hosts: a believable week, the same every time it is asked. forge is
 * the busy one (automations, nights, pull requests); studio-pc adds a little, shares three commits
 * with forge (its clone fetched them: the card counts them once) and has gh signed out. The first
 * ask of a week answers `pending` (git and GitHub "still counting"), the next ones everything.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
/** How long the demo hosts "count commits" for a week they are first asked about. */
const GATHER_MS = 2_000;
const firstAsked = new Map<string, number>();

/** Commits on both demo hosts. */
const SHARED: Omit<WrappedCommit, "at">[] = [
  { sha: "5e1f0c2a9b7d", repo: "teleflock", added: 212, removed: 38 },
  { sha: "a03c77e41d29", repo: "teleflock", added: 64, removed: 51 },
  { sha: "c9b2e5f80a17", repo: "teleflock", added: 18, removed: 4 },
];

const PRS: { title: string; repo: string; day: number; hour: number }[] = [
  { title: "Flock Wrapped: the week on one card", repo: "demo/teleflock", day: 4, hour: 16.5 },
  { title: "Resume a session after a usage limit", repo: "demo/teleflock", day: 1, hour: 11 },
  { title: "Retry idempotent POSTs once", repo: "demo/api-gateway", day: 2, hour: 9.2 },
  { title: "Quiet chip for parked agents", repo: "demo/teleflock", day: 3, hour: 14 },
  { title: "Fix a flaky worktree test", repo: "demo/teleflock", day: 0, hour: 17.8 },
  { title: "Cache the model catalog for 5 min", repo: "demo/api-gateway", day: 5, hour: 12 },
];

interface Shape {
  /** Agents, subagents and automation runs over a whole week. */
  agents: number;
  subagents: number;
  automationRuns: number;
  /** Agents working side by side, on average, while the host is busy. */
  parallel: number;
  /** Day stretches: [start hour, length in hours] per weekday (Mon = 0); weekends get the first. */
  day: [number, number][];
  /** Night stretches: [weekday it starts, start hour, length in hours]. */
  nights: [number, number, number][];
  models: [provider: string, model: string, requests: number, tps: number][];
  crew: [name: string, requests: number][];
  repos: [name: string, commits: number][];
}

const FORGE: Shape = {
  agents: 31,
  subagents: 118,
  automationRuns: 7,
  parallel: 2.6,
  day: [
    [9.2, 3.1],
    [13.6, 4.2],
  ],
  nights: [
    [1, 22.9, 6.2],
    [3, 0.7, 2.3],
  ],
  models: [
    ["anthropic", "claude-opus-5", 910, 61],
    ["anthropic", "claude-sonnet-5", 1_340, 88],
    ["openai-codex", "gpt-6-luna", 420, 187],
    ["openai", "gpt-5.5", 260, 71],
    // Very fast, but three requests are not a week's evidence.
    ["google", "gemini-3-pro", 3, 241],
  ],
  crew: [
    ["Worker", 214],
    ["Explore", 168],
    ["Scout", 97],
    ["Reviewer", 71],
  ],
  repos: [
    ["teleflock", 18],
    ["api-gateway", 8],
  ],
};

const STUDIO: Shape = {
  agents: 6,
  subagents: 19,
  automationRuns: 0,
  parallel: 1.3,
  day: [[10.5, 2.4]],
  nights: [[2, 22.4, 2.8]],
  models: [
    ["anthropic", "claude-sonnet-5", 210, 91],
    ["openai-codex", "gpt-6-luna", 64, 176],
  ],
  crew: [
    ["Worker", 41],
    ["Explore", 23],
  ],
  // Its own commits: none in teleflock, whose three commits came from forge.
  repos: [
    ["infra", 6],
    ["teleflock", 0],
  ],
};

/** Local midnight `days` after the one at `since`. */
function dayStart(since: number, days: number): number {
  const d = new Date(since);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** `host.wrapped` of the demo host `hostId` (`rich`: forge's shape) at `now`. */
export function demoWrapped(hostId: string, rich: boolean, p: { since: number; until?: number }, now: number): WrappedReport {
  const shape = rich ? FORGE : STUDIO;
  const end = Math.min(p.until ?? now, now);
  const rng = new Rng(hash(`${hostId}:wrapped:${p.since}`));
  const at = (day: number, hour: number) => dayStart(p.since, day) + Math.round(hour * HOUR);
  const clip = (s: UsageSpan): UsageSpan | null => (s.start >= end || s.end <= p.since ? null : { start: Math.max(s.start, p.since), end: Math.min(s.end, end) });

  const spans: UsageSpan[] = [];
  for (let day = 0; day < 7; day++) {
    const stretches = day >= 5 ? shape.day.slice(0, 1) : shape.day;
    for (const [hour, length] of stretches) {
      const start = at(day, hour + rng.range(-0.4, 0.4));
      spans.push({ start, end: start + Math.round((length * (day >= 5 ? 0.5 : 1) + rng.range(-0.5, 0.5)) * HOUR) });
    }
  }
  for (const [day, hour, length] of shape.nights) spans.push({ start: at(day, hour), end: at(day, hour + length) });
  const busy = spans.map(clip).filter((s): s is UsageSpan => s !== null).toSorted((a, b) => a.start - b.start);
  const busyMs = busy.reduce((n, s) => n + s.end - s.start, 0);
  // The share of the week's work done by `end` (a week in progress has done part of it).
  const done = Math.min(1, Math.max(0, (end - p.since) / (7 * 24 * HOUR)));
  const scaled = (n: number) => Math.round(n * done);

  const models: WrappedModel[] = shape.models
    .map(([provider, model, requests, tps]) => ({ provider, model, n: requests < 10 ? requests : scaled(requests), tps }))
    .filter((m) => m.n > 0)
    .map((m) => ({ provider: m.provider, model: m.model, requests: m.n, tps: m.tps * m.n, tpsN: m.n }));
  const crew: WrappedSubagent[] = shape.crew
    .map(([name, requests]) => ({ name, requests: scaled(requests), tokens: scaled(requests) * 5_400, output: scaled(requests) * 310, costUsd: Math.round(scaled(requests) * 4.2) / 100 }))
    .filter((s) => s.requests > 0);

  const report: WrappedReport = {
    since: p.since,
    until: end,
    index: { path: "/home/demo/.omp/agent/stats.db", ready: true, syncing: false, syncedAt: now - 4 * MIN, newest: end - 2 * MIN },
    agents: scaled(shape.agents),
    subagents: scaled(shape.subagents),
    automationRuns: scaled(shape.automationRuns),
    workMs: Math.round(busyMs * shape.parallel),
    busy,
    models,
    crew,
  };

  const key = `${hostId}:${p.since}:${p.until ?? ""}`;
  const asked = firstAsked.get(key) ?? now;
  firstAsked.set(key, asked);
  if (now - asked < GATHER_MS) return { ...report, pending: true };

  const commits: WrappedCommit[] = [];
  for (const [repo, n] of shape.repos)
    for (let i = 0; i < n; i++) {
      const c = { sha: rng.hex(12), repo, at: at(Math.floor(rng.range(0, 7)), rng.range(9, 23)), added: Math.round(rng.range(4, 380)), removed: Math.round(rng.range(0, 140)) };
      if (c.at < end) commits.push(c);
    }
  SHARED.forEach((c, i) => {
    const t = at(1 + i, 15 + i);
    if (t < end) commits.push({ ...c, at: t });
  });
  commits.sort((a, b) => b.at - a.at);
  report.code = { repos: shape.repos.map(([name]) => ({ name, path: `/home/demo/${name}` })), commits };
  if (rich) {
    const prs: WrappedPr[] = PRS.map((pr, i) => ({ url: `https://github.com/${pr.repo}/pull/${412 + i}`, number: 412 + i, title: pr.title, repo: pr.repo, mergedAt: at(pr.day, pr.hour) }))
      .filter((pr) => pr.mergedAt < end)
      .toSorted((a, b) => b.mergedAt - a.mergedAt);
    report.prs = prs;
  } else report.prsNote = "gh is not signed in on this host: run `gh auth login` there to count merged pull requests.";
  return report;
}
