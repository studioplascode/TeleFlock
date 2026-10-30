import type { DeviceKind, EscalateTo, NotifyConfig, NotifyKind, NotifyTestResult, PresenceState, PushKind, PushWhen } from "@/core/gen";

/** Escalation delays offered in Settings, in seconds (0 = never). */
export const ESCALATE_AFTER_S: readonly number[] = [0, 60, 120, 300, 600, 900, 1800];

/** "Never", "1 min", "5 min"; a delay hostd was configured with elsewhere reads as minutes too. */
export function escalateLabel(s: number): string {
  if (s <= 0) return "Never";
  if (s < 60) return `${s} s`;
  const m = s / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/** The delays to offer: the standard ones, plus the host's current value when it is something else. */
export function escalateOptions(current: number): number[] {
  return ESCALATE_AFTER_S.includes(current) ? [...ESCALATE_AFTER_S] : [...ESCALATE_AFTER_S, current].sort((a, b) => a - b);
}

export const ESCALATE_TO_LABEL: Record<EscalateTo, string> = { phones: "Phones", all: "All devices" };

/** "Idle after" choices, in minutes. */
export const IDLE_AFTER_MIN: readonly number[] = [1, 2, 3, 5, 10, 15];
export const DEFAULT_IDLE_AFTER_MIN = 3;

/** The stored value, or the nearest choice when a settings file holds something else. */
export function idleChoice(stored: number | undefined): number {
  const v = stored ?? DEFAULT_IDLE_AFTER_MIN;
  return IDLE_AFTER_MIN.reduce((best, m) => (Math.abs(m - v) < Math.abs(best - v) ? m : best), IDLE_AFTER_MIN[0] ?? DEFAULT_IDLE_AFTER_MIN);
}

/** What "Auto" means on this platform (the engine's rule: Android → phone, desktop app → desktop, browser → web). */
export function autoDeviceKind(env: { android: boolean; tauri: boolean }): DeviceKind {
  if (env.android) return "phone";
  return env.tauri ? "desktop" : "web";
}

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = { desktop: "a desktop", phone: "a phone", web: "a browser tab" };

export const PRESENCE_LABEL: Record<PresenceState, string> = { active: "Active", idle: "Idle", away: "Away" };
export const PRESENCE_HINT: Record<PresenceState, string> = {
  active: "In use right now",
  idle: "Open, but no input for a while",
  away: "Hidden, locked or disconnected",
};

export const PUSH_KIND_LABEL: Record<PushKind, string> = { ntfy: "ntfy", pushover: "Pushover", webhook: "Webhook" };

export const PUSH_WHEN_LABEL: Record<PushWhen, string> = {
  offline: "Only with no app connected",
  unseen: "Also when nobody saw it in time",
  always: "Every notification",
};
export const PUSH_WHEN_SHORT: Record<PushWhen, string> = { offline: "No app connected", unseen: "Unseen", always: "Always" };

/** The kinds a channel can carry, as Settings names them (the quiet-agent stall belongs to errors). */
export const PUSH_KIND_CHOICES: readonly { id: string; label: string; kinds: readonly NotifyKind[] }[] = [
  { id: "needs", label: "Needs you", kinds: ["needs"] },
  { id: "errors", label: "Errors and stalls", kinds: ["error", "quiet"] },
  { id: "finished", label: "Finished", kinds: ["finished"] },
  { id: "automations", label: "Automations", kinds: ["info"] },
];
export const DEFAULT_PUSH_KINDS: readonly NotifyKind[] = ["needs", "error", "quiet", "finished"];

/** A choice is on when all its kinds are listed. */
export function choiceOn(kinds: readonly NotifyKind[], choice: { kinds: readonly NotifyKind[] }): boolean {
  return choice.kinds.every((k) => kinds.includes(k));
}

/** Turn a choice on or off without disturbing the others (kinds stay in a stable order). */
export function toggleChoice(kinds: readonly NotifyKind[], choice: { kinds: readonly NotifyKind[] }, on: boolean): NotifyKind[] {
  const rest = kinds.filter((k) => !choice.kinds.includes(k));
  return PUSH_KIND_CHOICES.flatMap((c) => c.kinds).filter((k) => (on && choice.kinds.includes(k)) || rest.includes(k));
}

/** "Needs you · Errors and stalls · Finished", or "No notifications" for none. */
export function kindsLabel(kinds: readonly NotifyKind[]): string {
  const names = PUSH_KIND_CHOICES.filter((c) => c.kinds.some((k) => kinds.includes(k))).map((c) => c.label);
  return names.length > 0 ? names.join(" · ") : "No notifications";
}

/** The toast after "Send a test": who was alerted at once, or why nobody was. */
export function describeTest(result: NotifyTestResult, config: Pick<NotifyConfig, "policy" | "devices">): { title: string; status: "done" | "idle" } {
  if (result.alerted.length > 0) return { title: `Sent to ${result.alerted.join(", ")}`, status: "done" };
  const pushed = result.push !== undefined;
  if (config.devices.length === 0) return { title: pushed ? "No app connected: pushed" : "No app connected: nothing to send it to", status: pushed ? "done" : "idle" };
  const { escalateAfterS, escalateTo } = config.policy;
  const later = escalateAfterS > 0 ? `it goes to ${escalateTo === "all" ? "all devices" : "your phones"} after ${escalateLabel(escalateAfterS)} unseen` : "nothing is sent until you use a device";
  return { title: `No device in use: ${later}${pushed ? " (pushed)" : ""}`, status: "idle" };
}

/** The glyph of a listed device: the kind it reports (its settings may make a desktop a phone), else its platform. */
export function deviceGlyph(platform: string, device?: DeviceKind): "phone" | "desktop" | "web" {
  if (device) return device;
  const p = platform.toLowerCase();
  if (/android|ios|iphone|ipad|phone/.test(p)) return "phone";
  if (/web|browser/.test(p)) return "web";
  return "desktop";
}
