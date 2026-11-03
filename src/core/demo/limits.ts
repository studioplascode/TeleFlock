/**
 * Demo `host.limits`: subscription accounts whose agents work around the clock, in bursts or not
 * at all, so their windows fill in whole-percent steps (as omp reports them) and reset on schedule.
 * Every projection state shows up at once (runs out / resets first / idle), and exhausted ones as
 * time passes. Readings come the way hostd sends them: every minute for the last hour, older ones
 * evenly spaced over the period. Deterministic per host id and clock time.
 */
import type { AccountLimits, Agent, LimitAccount, LimitSample, LimitWindow } from "../gen";
import { hash } from "./rng";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** omp refreshes a working account's windows about once a minute: its report is a minute old when hostd reads it. */
const REPORT_LAG = MIN;
/** Readings older than the last hour hostd sends per window (evenly spaced). */
const OLDER_SAMPLES = 60;

/** When an account's agents work: `on` ms of every `every` ms, `shift` ms into the cycle at epoch 0. */
interface Work {
  every: number;
  on: number;
  shift: number;
}

const AROUND_THE_CLOCK: Work = { every: DAY, on: DAY, shift: 0 };

interface WindowSpec {
  id: string;
  label: string;
  window: string;
  tier?: string;
  durationMs: number;
  /** Used fraction per hour while the account's agents work. */
  rate: number;
  /** Phase of the reset schedule (ms into the period at epoch 0). */
  phase: number;
}

interface AccountSpec {
  provider: string;
  label: string;
  org?: string;
  plan?: string;
  windows: WindowSpec[];
  resetsAvailable?: number;
  work: Work;
}

/** Time the account's agents worked from epoch 0 to `t`. */
function worked(w: Work, t: number): number {
  const x = t + w.shift;
  const cycles = Math.floor(x / w.every);
  return cycles * w.on + Math.min(x - cycles * w.every, w.on);
}

/** Used fraction at `t` of the period that began at `start`, in whole percent like omp reports it. */
function usedAt(spec: WindowSpec, work: Work, start: number, t: number): number {
  return Math.min(1, Math.floor(((spec.rate * (worked(work, t) - worked(work, start))) / HOUR) * 100 + 1e-9) / 100);
}

function windowAt(spec: WindowSpec, work: Work, now: number): LimitWindow {
  const at = now - REPORT_LAG;
  const start = Math.floor((at + spec.phase) / spec.durationMs) * spec.durationMs - spec.phase;
  const resetsAt = start + spec.durationMs;
  const used = usedAt(spec, work, start, at);
  const recent = Math.max(start, at - HOUR);
  const samples: LimitSample[] = [];
  if (recent > start)
    for (let i = 0; i < OLDER_SAMPLES; i++) {
      const t = start + Math.floor(((recent - start) * i) / OLDER_SAMPLES);
      samples.push({ at: t, used: usedAt(spec, work, start, t) });
    }
  for (let t = at - Math.floor((at - recent) / MIN) * MIN; t < at; t += MIN) samples.push({ at: t, used: usedAt(spec, work, start, t) });
  return {
    id: spec.id,
    label: spec.label,
    window: spec.window,
    tier: spec.tier,
    durationMs: spec.durationMs,
    resetsAt,
    used,
    status: used >= 1 ? "exhausted" : used >= 0.8 ? "warning" : "ok",
    unit: "percent",
    notes: [],
    samples,
  };
}

/** A host's offset into the reset schedules, so hosts don't reset in lockstep. */
function offset(hostId: string): number {
  return (hash(hostId) % 97) * 13 * MIN;
}

/** Claude's windows (`omp usage` labels): 5 hours, 7 days, 7 days for Opus. */
function claude(rate5: number, rate7: number, rateOpus: number, phase: number, off: number): WindowSpec[] {
  return [
    { id: "anthropic:5h", label: "Claude 5 Hour", window: "5 Hour", durationMs: 5 * HOUR, rate: rate5, phase: phase + off },
    { id: "anthropic:7d", label: "Claude 7 Day", window: "7 Day", durationMs: 7 * DAY, rate: rate7, phase: phase * 7 + off },
    { id: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", window: "7 Day", tier: "opus", durationMs: 7 * DAY, rate: rateOpus, phase: phase * 7 + off },
  ];
}

/** ChatGPT's (Codex) windows: 5 hours and 7 days. */
function codex(rate5: number, rate7: number, phase: number, off: number): WindowSpec[] {
  return [
    { id: "openai-codex:primary", label: "5 hours", window: "5 hours", durationMs: 5 * HOUR, rate: rate5, phase: phase + off },
    { id: "openai-codex:secondary", label: "7 days", window: "7 days", durationMs: 7 * DAY, rate: rate7, phase: 3 * DAY + off },
  ];
}

/**
 * Your Claude account works around the clock and runs out (its 5-hour windows half a period apart
 * from Codex's, so one of them is always on its way out); the team seat works an hour in six and
 * never touches Opus (idle); Codex's weekly window resets first.
 */
function specs(hostId: string): AccountSpec[] {
  const off = offset(hostId);
  return [
    { provider: "anthropic", label: "you@flock.dev", plan: "Max 20x", windows: claude(0.24, 0.0062, 0.0025, 2 * HOUR, off), resetsAvailable: 1, work: AROUND_THE_CLOCK },
    { provider: "anthropic", label: "team@acme.io", org: "Acme", plan: "Team", windows: claude(0.4, 0.012, 0, 4 * HOUR, off), work: { every: 6 * HOUR, on: HOUR, shift: off } },
    { provider: "openai-codex", label: "you@flock.dev", plan: "pro", windows: codex(0.22, 0.0025, 4.5 * HOUR, off), work: AROUND_THE_CLOCK },
  ];
}

function keyOf(s: { provider: string; label: string; org?: string }): string {
  return `${s.provider}|email:${s.label}${s.org ? `|org:${s.org.toLowerCase()}` : ""}`;
}

function report(s: AccountSpec, now: number): LimitAccount {
  return {
    key: keyOf(s),
    provider: s.provider,
    label: s.label,
    org: s.org,
    plan: s.plan,
    fetchedAt: now - REPORT_LAG,
    windows: s.windows.map((w) => windowAt(w, s.work, now)),
    resetsAvailable: s.resetsAvailable,
    notes: [],
    disabled: false,
  };
}

/**
 * What omp reports for an account linked during the demo (or linked again after it expired):
 * Claude and ChatGPT accounts report their windows at once, on a steady pace of their own; other
 * providers report none.
 */
export function demoLinkedReport(hostId: string, now: number, a: { provider: string; label: string; org?: string; plan?: string }): LimitAccount {
  const h = hash(keyOf(a));
  const phase = (h % 5) * HOUR;
  const off = offset(hostId);
  const windows = a.provider === "anthropic" ? claude(0.05 + (h % 7) / 100, 0.003, 0.001, phase, off) : a.provider === "openai-codex" ? codex(0.07, 0.002, phase, off) : [];
  if (windows.length > 0) return report({ ...a, plan: a.plan ?? (a.provider === "anthropic" ? "pro" : "plus"), windows, work: AROUND_THE_CLOCK }, now);
  return { key: keyOf(a), provider: a.provider, label: a.label, org: a.org, plan: a.plan, windows: [], notes: [], error: "omp reported no limit windows for this account", disabled: false };
}

/** The demo host's `host.limits` answer at `now`. */
export function demoLimits(hostId: string, now: number, agents: Agent[], withDisabled: boolean): AccountLimits {
  const accounts: LimitAccount[] = specs(hostId).map((s) => report(s, now));
  if (withDisabled)
    accounts.push({
      key: "anthropic|email:old@flock.dev",
      provider: "anthropic",
      label: "old@flock.dev",
      windows: [],
      notes: [],
      error: "Disabled by omp: oauth refresh failed: invalid_grant (Refresh token expired)",
      disabled: true,
    });
  const anthropic = accounts.filter((a) => a.provider === "anthropic" && !a.disabled);
  let n = 0;
  const sessions = agents.flatMap((a) => {
    const sid = a.omp?.sessionId;
    const provider = a.omp?.model?.provider;
    if (!sid || !provider) return [];
    const accountKey = provider === "anthropic" ? anthropic[n++ % anthropic.length]?.key : accounts.find((x) => x.provider === provider)?.key;
    return [{ sessionId: sid, provider, accountKey }];
  });
  return { fetchedAt: now, accounts, sessions };
}
