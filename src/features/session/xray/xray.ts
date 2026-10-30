import type { ContextXray, SessionMeta, TranscriptItem, XrayEntry } from "@/core/gen";

/**
 * Context X-ray (`session.context`, architecture §3.20): omp's own `/context` breakdown of what fills
 * a session's context window, shown natively. Pure helpers; the view is `ContextXray.tsx`.
 */

/** One color per omp category (stable across sessions), plus the buffer and free space. */
export const XRAY_COLOR: Record<string, string> = {
  "system-prompt": "#a35cf0",
  skills: "#d29bff",
  "built-in-tools": "#5b8def",
  "custom-tools": "#4cc9f0",
  "user-messages": "#f4a261",
  "assistant-messages": "#2ec4b6",
  "assistant-thinking": "#e76f9a",
  "tool-calls": "#ffd166",
  "tool-output": "#ef476f",
  buffer: "#f59e0b",
  free: "rgb(255 255 255 / 0.08)",
};

/** Share of the window as omp's overview prints it: one decimal, `<0.1%` for slivers, `—` without a window. */
export function sharePct(tokens: number, window: number): string {
  if (!(window > 0)) return "—";
  const pct = (tokens / window) * 100;
  return pct > 0 && pct < 0.05 ? "<0.1%" : `${pct.toFixed(1)}%`;
}

export interface XraySegment {
  id: string;
  label: string;
  tokens: number;
  color: string;
}

/** The stacked bar in omp's order: categories with a share, free space, then the auto-compaction buffer. */
export function xraySegments(x: ContextXray): XraySegment[] {
  const segments: XraySegment[] = x.categories
    .filter((c) => (c.tokens ?? 0) > 0)
    .map((c) => ({ id: c.id, label: c.label, tokens: c.tokens ?? 0, color: XRAY_COLOR[c.id] ?? "#8b8b9e" }));
  segments.push({ id: "free", label: "Free space", tokens: x.free, color: XRAY_COLOR.free as string });
  if (x.buffer > 0) segments.push({ id: "buffer", label: "Auto-compact buffer", tokens: x.buffer, color: XRAY_COLOR.buffer as string });
  return segments;
}

const int = new Intl.NumberFormat("en-US");

/** omp's `contextUsageSummary` room text: how far auto-compaction is. */
export function roomText(x: ContextXray): string {
  if (x.threshold === undefined) return `${int.format(x.free)} free`;
  const at = `${x.window > 0 ? Math.round((x.threshold / x.window) * 100) : 0}%`;
  return x.used >= x.threshold ? `Past auto-compaction at ${at}` : `${int.format(x.threshold - x.used)} left before auto-compaction at ${at}`;
}

/** The biggest tool outputs (omp's tool-output entries, biggest first). */
export function biggestOutputs(x: ContextXray): XrayEntry[] {
  return x.categories.find((c) => c.id === "tool-output")?.top ?? [];
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * What a compaction should keep, for the one-tap "Compact with focus": the goal, else the task in
 * progress, else the latest prompt.
 */
export function suggestFocus(meta: SessionMeta | undefined, items: readonly TranscriptItem[]): string {
  if (meta?.goal?.objective) return oneLine(meta.goal.objective, 200);
  for (const phase of meta?.todos ?? []) {
    const task = phase.tasks.find((t) => t.status === "inProgress");
    if (task) return oneLine(`${task.content} (${phase.name})`, 200);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "user" && item.text.trim()) return oneLine(item.text, 200);
  }
  return "";
}

/** The transcript row of a tool call (to jump to the output that fills the context). */
export function toolRowOf(items: readonly TranscriptItem[], callId: string): string | undefined {
  return items.find((i) => i.kind === "tool" && i.callId === callId)?.id;
}
