/**
 * Demo `host.limits`: subscription accounts whose windows fill along a smooth, slightly wavy pace
 * and reset on schedule, so every projection state (runs out / resets first / exhausted / idle)
 * shows up as time passes. Deterministic per host id and clock time.
 */
import type { AccountLimits, Agent, LimitAccount, LimitSample, LimitWindow } from "../gen";
import { hash } from "./rng";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Readings every 10 minutes (hostd's own polls + omp's hourly history). */
const SAMPLE_EVERY = 10 * MIN;
/** omp's report is a few minutes old when hostd reads it. */
const REPORT_LAG = 2 * MIN;

interface WindowSpec {
  id: string;
  label: string;
  window: string;
  tier?: string;
  durationMs: number;
  /** Average used fraction per hour. */
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
}

/** Used fraction `t` ms into a period: the wavy pace integrated, rounded to whole percent. */
function usedAt(spec: WindowSpec, t: number, seed: number): number {
  const wave = 90 * MIN;
  const k = (2 * Math.PI) / wave;
  const integral = t + (0.35 / k) * (Math.cos(k * seed) - Math.cos(k * (seed + t)));
  return Math.min(1, Math.round(((spec.rate * integral) / HOUR) * 100) / 100);
}

function windowAt(spec: WindowSpec, now: number, seed: number): LimitWindow {
  const at = now - REPORT_LAG;
  const start = Math.floor((at + spec.phase) / spec.durationMs) * spec.durationMs - spec.phase;
  const resetsAt = start + spec.durationMs;
  const used = usedAt(spec, at - start, seed + start);
  const samples: LimitSample[] = [];
  for (let t = Math.ceil(start / SAMPLE_EVERY) * SAMPLE_EVERY; t < at && samples.length < 120; t += SAMPLE_EVERY)
    if (at - t <= 24 * HOUR) samples.push({ at: t, used: usedAt(spec, t - start, seed + start) });
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
function claude(rate5: number, rate7: number, phase: number, off: number): WindowSpec[] {
  return [
    { id: "anthropic:5h", label: "Claude 5 Hour", window: "5 Hour", durationMs: 5 * HOUR, rate: rate5, phase: phase + off },
    { id: "anthropic:7d", label: "Claude 7 Day", window: "7 Day", durationMs: 7 * DAY, rate: rate7, phase: phase * 7 + off },
    { id: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", window: "7 Day", tier: "opus", durationMs: 7 * DAY, rate: rate7 * 0.6, phase: phase * 7 + off },
  ];
}

/** ChatGPT's (Codex) windows: 5 hours and 7 days. */
function codex(rate5: number, rate7: number, phase: number, off: number): WindowSpec[] {
  return [
    { id: "openai-codex:primary", label: "5 hours", window: "5 hours", durationMs: 5 * HOUR, rate: rate5, phase: phase + off },
    { id: "openai-codex:secondary", label: "7 days", window: "7 days", durationMs: 7 * DAY, rate: rate7, phase: 3 * DAY + off },
  ];
}

function specs(hostId: string): AccountSpec[] {
  const off = offset(hostId);
  return [
    { provider: "anthropic", label: "you@flock.dev", plan: "Max 20x", windows: claude(0.24, 0.0062, 2 * HOUR, off), resetsAvailable: 1 },
    { provider: "anthropic", label: "team@acme.io", org: "Acme", plan: "Team", windows: claude(0.06, 0.0072, 4 * HOUR, off) },
    { provider: "openai-codex", label: "you@flock.dev", plan: "pro", windows: codex(0.11, 0.0035, HOUR, off) },
  ];
}

function keyOf(s: { provider: string; label: string; org?: string }): string {
  return `${s.provider}|email:${s.label}${s.org ? `|org:${s.org.toLowerCase()}` : ""}`;
}

function report(s: AccountSpec, now: number, seed: number): LimitAccount {
  return {
    key: keyOf(s),
    provider: s.provider,
    label: s.label,
    org: s.org,
    plan: s.plan,
    fetchedAt: now - REPORT_LAG,
    windows: s.windows.map((w) => windowAt(w, now, seed)),
    resetsAvailable: s.resetsAvailable,
    notes: [],
    disabled: false,
  };
}

/**
 * What omp reports for an account linked during the demo (or linked again after it expired):
 * Claude and ChatGPT accounts report their windows at once, on a pace of their own; other
 * providers report none.
 */
export function demoLinkedReport(hostId: string, now: number, a: { provider: string; label: string; org?: string; plan?: string }): LimitAccount {
  const h = hash(keyOf(a));
  const phase = (h % 5) * HOUR;
  const off = offset(hostId);
  const windows = a.provider === "anthropic" ? claude(0.05 + (h % 7) / 100, 0.003, phase, off) : a.provider === "openai-codex" ? codex(0.07, 0.002, phase, off) : [];
  if (windows.length > 0) return report({ ...a, plan: a.plan ?? (a.provider === "anthropic" ? "pro" : "plus"), windows }, now, hash(`${hostId}limits`) + h);
  return { key: keyOf(a), provider: a.provider, label: a.label, org: a.org, plan: a.plan, windows: [], notes: [], error: "omp reported no limit windows for this account", disabled: false };
}

/** The demo host's `host.limits` answer at `now`. */
export function demoLimits(hostId: string, now: number, agents: Agent[], withDisabled: boolean): AccountLimits {
  const seed = hash(`${hostId}limits`);
  const accounts: LimitAccount[] = specs(hostId).map((s, i) => report(s, now, seed + i * 7919));
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
