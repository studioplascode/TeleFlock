/**
 * Demo `host.usage` answers for apps ≥ 0.7.0 (`view` set): four months of believable history per
 * demo host (work-hour rhythm, weekends lighter, a few long nights), the same shape and
 * definitions hostd answers with. Today's live spend comes from the demo host's ticking ledger
 * (`live.ledgerToday`), like a real host between syncs.
 */
import type { UsageInsights, UsageKeyStat, UsageParams, UsageReport, UsageSessionStat, UsageStat, UsageTotals } from "../gen";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SPAN_DAYS = 120;

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface Hour {
  hour: number;
  cost: number;
  requests: number;
  tokens: number;
  errors: number;
  unpriced: number;
}

/** The host's whole history (deterministic per host and day). */
function history(hostId: string, big: boolean, now: number): Hour[] {
  const out: Hour[] = [];
  const first = Math.floor((now - SPAN_DAYS * DAY) / HOUR);
  const last = Math.floor(now / HOUR);
  const scale = big ? 1 : 0.35;
  for (let h = first; h <= last; h++) {
    const r = rng(seedOf(`${hostId}:${h}`));
    const at = new Date(h * HOUR);
    const local = (at.getUTCHours() + 1) % 24; // a European working day
    const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6;
    const dayOff = rng(seedOf(`${hostId}:day:${Math.floor(h / 24)}`))() < (weekend ? 0.55 : 0.08);
    let p = local >= 9 && local < 19 ? 0.85 : local >= 19 || local < 1 ? 0.35 : 0.06;
    if (weekend) p *= 0.5;
    if (dayOff || r() > p) continue;
    const requests = Math.round((6 + r() * 34) * scale) + 1;
    const cost = Math.round(requests * (0.02 + r() * 0.09) * 1e6) / 1e6;
    out.push({ hour: h, cost, requests, tokens: Math.round(requests * (18_000 + r() * 40_000)), errors: r() < 0.08 ? 1 : 0, unpriced: r() < 0.05 ? 1 : 0 });
  }
  return out;
}

function stat(cost: number, requests: number, tokens: number, errors: number, unpriced: number, speed = 1, first?: number, last?: number): UsageStat {
  const input = Math.round(tokens * 0.18);
  const output = Math.round(tokens * 0.06);
  const cacheRead = Math.round(tokens * 0.72);
  const timed = Math.max(0, requests - unpriced);
  return {
    requests,
    errors,
    costUsd: cost,
    unpriced,
    tokens,
    input,
    output,
    cacheRead,
    cacheWrite: tokens - input - output - cacheRead,
    premium: 0,
    uncachedUsd: cost * 2.6,
    cachedUsd: cost * 0.9,
    durationMs: timed * 9_000 / speed,
    durationN: timed,
    ttftMs: timed * 1_400 / speed,
    ttftN: timed,
    tps: timed * 70 * speed,
    tpsN: timed,
    firstAt: first,
    lastAt: last,
  };
}

const MODELS: [provider: string, model: string, share: number, speed: number][] = [
  ["anthropic", "claude-opus-5-5", 0.52, 0.9],
  ["openai-codex", "gpt-6-astra", 0.22, 1.25],
  ["anthropic", "claude-sonnet-5", 0.13, 1.6],
  ["openai-codex", "gpt-6-luna", 0.08, 2.4],
  ["xai-oauth", "grok-5", 0.05, 1.1],
];
const PROJECTS: [folder: string, cwd: string, share: number][] = [
  ["-src-teleflock", "/home/dev/src/teleflock", 0.41],
  ["-src-api-gateway", "/home/dev/src/api-gateway", 0.27],
  ["-src-web-shop", "/home/dev/src/web-shop", 0.2],
  ["-src-infra", "/home/dev/src/infra", 0.12],
];
const SUBAGENTS: [string, number][] = [
  ["Explore", 0.34],
  ["FixTests", 0.24],
  ["Review", 0.18],
  ["Docs", 0.12],
  ["Migrate", 0.12],
];
const TOOLS: [string, number][] = [
  ["read", 0.31],
  ["bash", 0.2],
  ["grep", 0.16],
  ["edit", 0.13],
  ["eval", 0.07],
  ["write", 0.05],
  ["glob", 0.04],
  ["web_search", 0.02],
  ["task", 0.02],
];
const TITLES = ["Checkout flow refactor", "Flaky e2e on CI", "Rate limiter rewrite", "Dark mode polish", "Terraform drift", "Search indexing", "Auth token rotation", "Release notes", "Payment webhooks", "Onboarding tour"];

export function demoUsageReport(hostId: string, big: boolean, p: UsageParams, now: number, ledgerToday: UsageTotals): UsageReport {
  const all = history(hostId, big, now);
  const since = p.since ?? -Infinity;
  const until = p.until ?? Infinity;
  const off = (p.hourOffset ?? 0) * 60_000;
  const win = all.filter((h) => h.hour * HOUR >= since && h.hour * HOUR < until);
  const sum = (f: (h: Hour) => number) => win.reduce((n, h) => n + f(h), 0);
  const [cost, requests, tokens, errors, unpriced] = [sum((h) => h.cost), sum((h) => h.requests), sum((h) => h.tokens), sum((h) => h.errors), sum((h) => h.unpriced)];
  const first = win[0] ? win[0].hour * HOUR : undefined;
  const last = win.length ? (win[win.length - 1] as Hour).hour * HOUR + 40 * 60_000 : undefined;
  const share = (s: number, speed = 1, pricedOnly = false): UsageStat =>
    stat(pricedOnly ? 0 : cost * s, Math.max(1, Math.round(requests * s)), Math.round(tokens * s), Math.round(errors * s), pricedOnly ? Math.max(1, unpriced) : 0, speed, first, last);
  const keyed = (rows: [string, number][]): UsageKeyStat[] => rows.map(([key, s]) => ({ key, stat: share(s) }));
  const r = rng(seedOf(`${hostId}:sessions:${Math.floor(now / DAY)}`));
  const sessions: UsageSessionStat[] = TITLES.map((title, i) => {
    const s = 0.16 / (i + 1);
    const ended = now - Math.round(r() * 6 * DAY) - i * 3 * HOUR;
    const id = `01demo${i.toString(16).padStart(2, "0")}-0000-7000-8000-${hostId.padEnd(12, "0").slice(0, 12)}`;
    return {
      file: `/home/dev/.omp/agent/sessions/${PROJECTS[i % PROJECTS.length]?.[0]}/${id}.jsonl`,
      id,
      title,
      cwd: PROJECTS[i % PROJECTS.length]?.[1],
      startedAt: ended - Math.round((1.5 + r() * 9) * HOUR),
      endedAt: ended,
      requests: Math.max(1, Math.round(requests * s)),
      delegated: Math.round(requests * s * 0.45),
      costUsd: cost * s,
      unpriced: 0,
      tokens: Math.round(tokens * s),
      models: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5"].slice(0, 1 + (i % 2)),
    };
  });
  const longest = [...sessions].sort((a, b) => b.endedAt - b.startedAt - (a.endedAt - a.startedAt))[0];
  const priciest = win.reduce<Hour | undefined>((m, h) => (!m || h.cost > m.cost ? h : m), undefined);
  const view = p.view ?? "summary";
  const stretches = win.map((h) => ({ start: h.hour * HOUR + 5 * 60_000, end: h.hour * HOUR + 50 * 60_000 }));
  const insights: UsageInsights = {
    version: `${hostId}:${view}:${p.since ?? ""}:${p.until ?? ""}:${Math.floor(now / (10 * 60_000))}`,
    since: p.since,
    until: p.until,
    hourOffset: p.hourOffset ?? 0,
    hours: {
      hour: win.map((h) => Math.floor((h.hour * HOUR - off) / HOUR)),
      costUsd: win.map((h) => h.cost),
      tokens: win.map((h) => h.tokens),
      input: win.map((h) => Math.round(h.tokens * 0.18)),
      output: win.map((h) => Math.round(h.tokens * 0.06)),
      cacheRead: win.map((h) => Math.round(h.tokens * 0.72)),
      cacheWrite: win.map((h) => h.tokens - Math.round(h.tokens * 0.18) - Math.round(h.tokens * 0.06) - Math.round(h.tokens * 0.72)),
      requests: win.map((h) => h.requests),
      errors: win.map((h) => h.errors),
      unpriced: win.map((h) => h.unpriced),
    },
    totals: { ...stat(cost, requests, tokens, errors, unpriced, 1, first, last), premium: Math.round(requests * 0.03) },
    models: [],
    providers: [],
    projects: [],
    agents: [],
    subagents: [],
    tiers: [],
    tools: [],
    sessions: [],
    sessionCount: 0,
    subagentCount: 0,
    records: {},
    activity: { hour: [], requests: [] },
    work: { agentMs: 0, stretches: [] },
  };
  if (view === "insights" && win.length) {
    insights.models = MODELS.map(([provider, model, s, speed]) => ({ provider, model, stat: share(s, speed, provider === "xai-oauth") }));
    const providers = new Map<string, UsageKeyStat>();
    for (const m of insights.models) {
      const cur = providers.get(m.provider);
      if (cur) {
        cur.stat = { ...cur.stat, requests: cur.stat.requests + m.stat.requests, costUsd: cur.stat.costUsd + m.stat.costUsd, tokens: cur.stat.tokens + m.stat.tokens, unpriced: cur.stat.unpriced + m.stat.unpriced };
      } else providers.set(m.provider, { key: m.provider, stat: { ...m.stat } });
    }
    insights.providers = [...providers.values()];
    insights.projects = PROJECTS.map(([folder, cwd, s]) => ({ folder, cwd, stat: share(s) }));
    insights.agents = keyed([
      ["main", 0.46],
      ["subagent", 0.44],
      ["advisor", 0.1],
    ]);
    insights.subagents = SUBAGENTS.map(([key, s]) => ({ key, stat: share(0.44 * s) }));
    insights.tiers = keyed([
      ["", 0.9],
      ["priority", 0.1],
    ]);
    insights.tools = TOOLS.map(([name, s]) => ({ name, calls: Math.round(requests * 1.4 * s), errors: Math.round(requests * 0.02 * s), costUsd: cost * s }));
    insights.sessions = sessions;
    insights.sessionCount = Math.max(sessions.length, Math.round(win.length / 3));
    insights.subagentCount = Math.round(win.length * 0.8);
    insights.records = {
      priciest: priciest ? { at: priciest.hour * HOUR + 17 * 60_000, provider: "anthropic", model: "claude-opus-5-5", costUsd: priciest.cost * 0.4, tokens: Math.round(priciest.tokens * 0.3), folder: "-src-teleflock", agent: "main", durationMs: 48_000 } : undefined,
      biggest: priciest ? { at: priciest.hour * HOUR + 17 * 60_000, provider: "anthropic", model: "claude-opus-5-5", costUsd: priciest.cost * 0.4, tokens: Math.round(priciest.tokens * 0.3), folder: "-src-teleflock", agent: "main", durationMs: 48_000 } : undefined,
      longestSession: longest,
    };
    insights.activity = { hour: all.map((h) => Math.floor((h.hour * HOUR - off) / HOUR)), requests: all.map((h) => h.requests) };
    insights.work = { agentMs: stretches.reduce((n, s) => n + (s.end - s.start), 0) * 1.6, stretches };
  }
  return {
    index: { path: "/home/dev/.omp/stats.db", ready: true, syncing: false, syncedAt: now - 3 * 60_000, added: 37, newest: now - 2 * 60_000 },
    insights: p.have === insights.version ? undefined : insights,
    unchanged: p.have === insights.version ? true : undefined,
    live: { since: now - 3 * 60_000, costUsd: 0, tokens: 0, input: 0, output: 0, ledgerToday },
  };
}
