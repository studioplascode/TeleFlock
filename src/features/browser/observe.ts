/**
 * What the TeleFlock Browser panel lets other features watch: the user's input through the panel,
 * navigations, tabs, console errors and failed requests of the user's tabs, screencast frames,
 * screenshots, and a slot in the panel's toolbar. Session recording builds on this.
 */
import type { ComponentType } from "react";
import { create } from "zustand";

/** Who a tab belongs to (absent on an event: the user). */
export type ObservedOwner =
  | { kind: "user" }
  | { kind: "agent"; hostId: string; agentId: string; agentName: string; detached?: boolean; takenOver?: boolean };

/** CSS pixels of the tab's viewport. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementInfo {
  tag: string;
  id?: string;
  name?: string;
  role?: string;
  type?: string;
  /** aria-label, label text, placeholder, alt or title, else the text (≤ 80 characters). */
  label?: string;
  /** The label is the element's own text (not an attribute or a `<label>`). */
  textLabel?: boolean;
  href?: string;
  autocomplete?: string;
  /** How to find it; `>>>` steps into a shadow root or a frame (`#pay >>> #card`). */
  selector: string;
  /** A password, card or one-time-code field, or a frame of another origin (the panel can't see its fields: card and 3-D Secure forms). */
  sensitive: boolean;
  /** Where the tab's viewport (the screencast) shows it, cut to the frames it is inside. */
  rect?: ViewRect;
  /** The page's scroll offset when `rect` was measured, CSS pixels. */
  scroll?: { x: number; y: number };
  /** Names the element for `measureElements` while its page lasts. */
  ref?: string;
}

export type PointerButton = "left" | "middle" | "right" | "back" | "forward";
export type UiAction = "navigate" | "back" | "forward" | "reload" | "stop" | "newTab" | "closeTab" | "switchTab" | "zoom";

export type BrowserEvent = { at: number; tabId: string } & (
  | { type: "pointer"; action: "down" | "up"; x: number; y: number; button: PointerButton; clickCount: number; modifiers: number; element?: ElementInfo }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; key: string; code: string; modifiers: number; text?: string; element?: ElementInfo }
  | { type: "text"; text: string; via: "paste" | "ime" | "insert"; element?: ElementInfo }
  | { type: "navigation"; url: string; title?: string; sameDocument: boolean; transition?: string; owner?: ObservedOwner }
  | { type: "tab"; change: "opened" | "closed" | "activated" | "updated" | "owner"; url: string; title: string; openerId?: string; owner?: ObservedOwner }
  | { type: "console"; level: "error" | "warning"; text: string; source?: string; stack?: string[] }
  | { type: "exception"; text: string; source?: string; stack?: string[] }
  | { type: "requestFailed"; url: string; method: string; resourceType?: string; status?: number; statusText?: string; error?: string; body?: string }
  | { type: "dialog"; dialog: "alert" | "confirm" | "prompt" | "beforeunload"; message: string }
  | { type: "ui"; action: UiAction; url?: string }
);

export interface BrowserFrame {
  /** Epoch ms (the frame's own timestamp when Chrome sends one). */
  at: number;
  tabId: string;
  owner?: ObservedOwner;
  /** Base64 JPEG, as CDP sent it. */
  data: string;
  /** Pixel size of the image. */
  width: number;
  height: number;
  /** The page viewport the image shows, CSS pixels. */
  viewport: { width: number; height: number };
  /** The page's scroll offset the image shows, CSS pixels. */
  scroll?: { x: number; y: number };
}

export interface BrowserObserver {
  /** Console errors/warnings and exceptions of the user's tabs (turns on Runtime and Log there while registered). */
  console?: boolean;
  /** Failed requests of the user's tabs (turns on Network there while registered). */
  network?: boolean;
  /** Element info on pointer, key and text events (input waits for each lookup while one wants it). */
  elements?: boolean;
  /** Keep the shown tab's screencast running while no panel is visible (frames arrive at the last panel size). */
  frames?: boolean;
  event?(e: BrowserEvent): void;
  frame?(f: BrowserFrame): void;
}

const observers = new Set<BrowserObserver>();
const changeListeners = new Set<() => void>();
const snapshotters = new Set<(o: BrowserObserver) => void>();

function changed(): void {
  for (const l of [...changeListeners]) l();
}

/**
 * Starts observing the browser. The new observer first gets the open tabs (`opened` for each
 * other tab, then `activated` for the shown one), then everything as it happens.
 */
export function observeBrowser(o: BrowserObserver): () => void {
  observers.add(o);
  for (const s of snapshotters) s(o);
  changed();
  return () => {
    if (observers.delete(o)) changed();
  };
}

/** The controller: the current observers, and a call whenever they change. */
export function browserObservers(): readonly BrowserObserver[] {
  return [...observers];
}

export function onObserversChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

/** The controller sends each new observer the tabs it has (`observeBrowser`'s snapshot). */
export function onObserverAdded(snapshot: (o: BrowserObserver) => void): () => void {
  snapshotters.add(snapshot);
  return () => {
    snapshotters.delete(snapshot);
  };
}

function deliver(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error("[browser] observer failed", err);
  }
}

export function emitBrowserEvent(e: BrowserEvent): void {
  for (const o of observers) if (o.event) deliver(() => o.event?.(e));
}

export function emitBrowserFrame(f: BrowserFrame): void {
  for (const o of observers) if (o.frame) deliver(() => o.frame?.(f));
}

/** Does any observer want this? */
export function observersWant(flag: "console" | "network" | "elements" | "frames"): boolean {
  for (const o of observers) if (o[flag]) return true;
  return false;
}

export type CaptureFormat = { format?: "png" | "jpeg"; quality?: number };
type Capture = (tabId: string | undefined, opts: CaptureFormat) => Promise<{ at: number; data: string } | null>;
let capture: Capture | null = null;

/** The controller provides screenshots. */
export function setCaptureImpl(fn: Capture | null): void {
  capture = fn;
}

/** A screenshot of a tab (default: the shown one); null without a connected browser. */
export function captureTab(tabId?: string, opts: CaptureFormat = {}): Promise<{ at: number; data: string } | null> {
  return capture ? capture(tabId, opts) : Promise.resolve(null);
}

/** Where elements of earlier lookups are now (`ElementInfo.ref`, in order; null: gone), at the page's scroll offset. */
export interface Measured {
  scroll: { x: number; y: number };
  rects: (ViewRect | null)[];
}
type Measure = (tabId: string, refs: readonly string[]) => Promise<Measured | null>;
let measure: Measure | null = null;

/** The controller measures elements. */
export function setMeasureImpl(fn: Measure | null): void {
  measure = fn;
}

/** Where the elements of earlier lookups in a tab are now; null without a connected browser or an answer. */
export function measureElements(tabId: string, refs: readonly string[]): Promise<Measured | null> {
  return measure ? measure(tabId, refs) : Promise.resolve(null);
}

export interface ToolbarItemProps {
  /** The tab the panel shows. */
  tabId: string | null;
  /** The panel is narrow (beside a session). */
  compact: boolean;
}

interface ToolbarItems {
  items: { id: string; component: ComponentType<ToolbarItemProps> }[];
}

export const useToolbarItems = create<ToolbarItems>(() => ({ items: [] }));

/** Renders `component` in the panel's toolbar (split view, Browser page and fullscreen) until the returned function runs. */
export function registerBrowserToolbarItem(id: string, component: ComponentType<ToolbarItemProps>): () => void {
  useToolbarItems.setState((s) => ({ items: [...s.items.filter((x) => x.id !== id), { id, component }] }));
  return () => useToolbarItems.setState((s) => ({ items: s.items.filter((x) => x.id !== id || x.component !== component) }));
}
