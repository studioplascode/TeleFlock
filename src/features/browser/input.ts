/**
 * Pure mapping of the panel's DOM input to CDP `Input.*` commands, and which keys belong to the
 * page, to the browser's own chrome (tabs, address bar, zoom) or to the app.
 */
import type { KeyEventParams, MouseButtonName } from "./cdp/protocol";

export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function modifiersOf(e: ModifierState): number {
  return (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.metaKey ? MOD_META : 0) | (e.shiftKey ? MOD_SHIFT : 0);
}

/** DOM `MouseEvent.button` → CDP button name. */
export function buttonName(button: number): MouseButtonName {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}

/** DOM `MouseEvent.buttons` and CDP `buttons` share one bit layout (left 1, right 2, middle 4, back 8, forward 16). */
export function buttonsMask(buttons: number): number {
  return buttons & 31;
}

/** A rectangle in client (CSS) pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where an image of `imgW`×`imgH` sits inside a box when fitted whole (object-fit: contain), centred. */
export function containRect(box: Rect, imgW: number, imgH: number): Rect {
  if (imgW <= 0 || imgH <= 0 || box.width <= 0 || box.height <= 0) return { ...box };
  const scale = Math.min(box.width / imgW, box.height / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** What the panel shows: the page image's rectangle on screen and the page viewport it pictures (CSS px). */
export interface PageMap {
  image: Rect;
  page: { width: number; height: number };
}

/** A client point → page CSS pixels, clamped to the page; `inside` says whether it was on the image. */
export function toPagePoint(clientX: number, clientY: number, map: PageMap): { x: number; y: number; inside: boolean } {
  const { image, page } = map;
  const sx = image.width > 0 ? page.width / image.width : 1;
  const sy = image.height > 0 ? page.height / image.height : 1;
  const rx = (clientX - image.left) * sx;
  const ry = (clientY - image.top) * sy;
  const inside = rx >= 0 && ry >= 0 && rx < page.width && ry < page.height;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(max - 1, 0));
  return { x: Math.round(clamp(rx, page.width)), y: Math.round(clamp(ry, page.height)), inside };
}

/** Page pixels per client pixel (the page is drawn scaled when the panel is smaller or zoomed). */
export function pageScale(map: PageMap): number {
  return map.image.width > 0 ? map.page.width / map.image.width : 1;
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/** Chrome scrolls 40 px per wheel line on every desktop OS. */
export const LINE_PX = 40;

/**
 * A wheel event's deltas in page pixels: lines and pages become pixels, the panel's scale applies,
 * and outside macOS Shift+wheel scrolls sideways (the OS does that before Chrome sees a real wheel).
 */
export function wheelDelta(e: WheelLike, pageHeight: number, scale: number, mac: boolean): { deltaX: number; deltaY: number } {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? Math.max(pageHeight, 1) : scale;
  let dx = e.deltaX * unit;
  let dy = e.deltaY * unit;
  if (!mac && e.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  return { deltaX: dx, deltaY: dy };
}

export interface KeyLike extends ModifierState {
  key: string;
  code: string;
  /** Legacy `keyCode` (0 or 229 while an IME composes). */
  keyCode: number;
  location: number;
  repeat: boolean;
  isComposing: boolean;
  /** `getModifierState("AltGraph")`: Windows reports AltGr as Ctrl+Alt. */
  altGraph: boolean;
}

/** Windows virtual key codes for `code` values whose legacy `keyCode` a webview may leave 0. */
const CODE_KEYCODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17,
  AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35,
  Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46,
  MetaLeft: 91, MetaRight: 92, ContextMenu: 93, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109,
  NumpadDecimal: 110, NumpadDivide: 111, NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188,
  Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221,
  Quote: 222, IntlBackslash: 226,
};

export function virtualKeyCode(e: Pick<KeyLike, "keyCode" | "code" | "key">): number {
  if (e.keyCode > 0 && e.keyCode !== 229) return e.keyCode;
  const known = CODE_KEYCODES[e.code];
  if (known) return known;
  let m = /^Key([A-Z])$/.exec(e.code);
  if (m?.[1]) return m[1].charCodeAt(0);
  m = /^Digit(\d)$/.exec(e.code);
  if (m?.[1]) return 48 + Number(m[1]);
  m = /^Numpad(\d)$/.exec(e.code);
  if (m?.[1]) return 96 + Number(m[1]);
  m = /^F(\d{1,2})$/.exec(e.code);
  if (m?.[1]) return 111 + Number(m[1]);
  const k = e.key.length === 1 ? e.key.toUpperCase() : "";
  if (/^[A-Z0-9]$/.test(k)) return k.charCodeAt(0);
  return 0;
}

/** One user-perceived character that types (not a control character). */
function printable(key: string): boolean {
  if (key.length === 0) return false;
  const chars = [...key];
  if (chars.length !== 1) return false;
  const cp = key.codePointAt(0) ?? 0;
  return cp >= 0x20 && cp !== 0x7f;
}

/** The text a key types, or undefined for keys that type nothing (shortcuts, navigation, modifiers). */
export function keyText(e: KeyLike, mac: boolean): string | undefined {
  if (e.key === "Enter") return "\r";
  if (!printable(e.key)) return undefined;
  if (e.altGraph) return e.key;
  if (e.metaKey || e.ctrlKey) return undefined;
  // Option on a Mac types characters (å, ∑); Alt elsewhere is a modifier for shortcuts.
  if (e.altKey && !mac) return undefined;
  return e.key;
}

/**
 * macOS editing commands for key combinations (Chrome on a Mac runs these selectors instead of a
 * key's default action; the text-inserting ones are left out since the key's text inserts).
 * Keys: modifiers in the order Shift, Ctrl, Alt, Meta, then the `code` (letters) or `key`.
 */
const MAC_COMMANDS: Record<string, string[]> = {
  Backspace: ["deleteBackward"],
  Escape: ["cancelOperation"],
  ArrowUp: ["moveUp"],
  ArrowDown: ["moveDown"],
  ArrowLeft: ["moveLeft"],
  ArrowRight: ["moveRight"],
  Delete: ["deleteForward"],
  Home: ["scrollToBeginningOfDocument"],
  End: ["scrollToEndOfDocument"],
  PageUp: ["scrollPageUp"],
  PageDown: ["scrollPageDown"],
  "Shift+Backspace": ["deleteBackward"],
  "Shift+ArrowUp": ["moveUpAndModifySelection"],
  "Shift+ArrowDown": ["moveDownAndModifySelection"],
  "Shift+ArrowLeft": ["moveLeftAndModifySelection"],
  "Shift+ArrowRight": ["moveRightAndModifySelection"],
  "Shift+Delete": ["deleteForward"],
  "Shift+Home": ["moveToBeginningOfDocumentAndModifySelection"],
  "Shift+End": ["moveToEndOfDocumentAndModifySelection"],
  "Shift+PageUp": ["pageUpAndModifySelection"],
  "Shift+PageDown": ["pageDownAndModifySelection"],
  "Ctrl+KeyA": ["moveToBeginningOfParagraph"],
  "Ctrl+KeyB": ["moveBackward"],
  "Ctrl+KeyD": ["deleteForward"],
  "Ctrl+KeyE": ["moveToEndOfParagraph"],
  "Ctrl+KeyF": ["moveForward"],
  "Ctrl+KeyH": ["deleteBackward"],
  "Ctrl+KeyK": ["deleteToEndOfParagraph"],
  "Ctrl+KeyN": ["moveDown"],
  "Ctrl+KeyP": ["moveUp"],
  "Ctrl+KeyT": ["transpose"],
  "Ctrl+KeyV": ["pageDown"],
  "Ctrl+KeyY": ["yank"],
  "Shift+Ctrl+KeyA": ["moveToBeginningOfParagraphAndModifySelection"],
  "Shift+Ctrl+KeyB": ["moveBackwardAndModifySelection"],
  "Shift+Ctrl+KeyE": ["moveToEndOfParagraphAndModifySelection"],
  "Shift+Ctrl+KeyF": ["moveForwardAndModifySelection"],
  "Shift+Ctrl+KeyN": ["moveDownAndModifySelection"],
  "Shift+Ctrl+KeyP": ["moveUpAndModifySelection"],
  "Alt+Backspace": ["deleteWordBackward"],
  "Alt+ArrowUp": ["moveBackward", "moveToBeginningOfParagraph"],
  "Alt+ArrowDown": ["moveForward", "moveToEndOfParagraph"],
  "Alt+ArrowLeft": ["moveWordLeft"],
  "Alt+ArrowRight": ["moveWordRight"],
  "Alt+Delete": ["deleteWordForward"],
  "Shift+Alt+ArrowUp": ["moveParagraphBackwardAndModifySelection"],
  "Shift+Alt+ArrowDown": ["moveParagraphForwardAndModifySelection"],
  "Shift+Alt+ArrowLeft": ["moveWordLeftAndModifySelection"],
  "Shift+Alt+ArrowRight": ["moveWordRightAndModifySelection"],
  "Meta+Backspace": ["deleteToBeginningOfLine"],
  "Meta+ArrowUp": ["moveToBeginningOfDocument"],
  "Meta+ArrowDown": ["moveToEndOfDocument"],
  "Meta+ArrowLeft": ["moveToLeftEndOfLine"],
  "Meta+ArrowRight": ["moveToRightEndOfLine"],
  "Meta+Delete": ["deleteToEndOfLine"],
  "Shift+Meta+ArrowUp": ["moveToBeginningOfDocumentAndModifySelection"],
  "Shift+Meta+ArrowDown": ["moveToEndOfDocumentAndModifySelection"],
  "Shift+Meta+ArrowLeft": ["moveToLeftEndOfLineAndModifySelection"],
  "Shift+Meta+ArrowRight": ["moveToRightEndOfLineAndModifySelection"],
  "Meta+KeyA": ["selectAll"],
  "Meta+KeyC": ["copy"],
  "Meta+KeyX": ["cut"],
  "Meta+KeyV": ["paste"],
  "Meta+KeyZ": ["undo"],
  "Shift+Meta+KeyZ": ["redo"],
};

function comboName(e: KeyLike): string {
  const parts: string[] = [];
  if (e.shiftKey) parts.push("Shift");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  parts.push(/^Key[A-Z]$/.test(e.code) ? e.code : e.key);
  return parts.join("+");
}

export function macCommands(e: KeyLike): string[] | undefined {
  return MAC_COMMANDS[comboName(e)];
}

/** `Input.dispatchKeyEvent` params for a key going down or up. */
export function keyEventParams(e: KeyLike, phase: "down" | "up", mac: boolean): KeyEventParams {
  const code = virtualKeyCode(e);
  const text = phase === "down" ? keyText(e, mac) : undefined;
  let modifiers = modifiersOf(e);
  // AltGr typing a character is not a Ctrl+Alt shortcut.
  if (text && e.altGraph) modifiers &= ~(MOD_CTRL | MOD_ALT);
  const params: KeyEventParams = {
    type: phase === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
    modifiers,
    key: e.key,
    code: e.code,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    location: e.location,
    isKeypad: e.location === 3,
    autoRepeat: e.repeat,
  };
  if (text) {
    params.text = text;
    params.unmodifiedText = text;
  }
  if (mac && phase === "down") {
    const commands = macCommands(e);
    if (commands) params.commands = commands;
  }
  return params;
}

/** What the panel itself does for a key (Chrome's reserved shortcuts). */
export type ChromeAction =
  | "focusAddress"
  | "newTab"
  | "closeTab"
  | "reopenTab"
  | "nextTab"
  | "prevTab"
  | "reload"
  | "hardReload"
  | "back"
  | "forward"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "fullscreen"
  | "devtools";

export type KeyRoute =
  /** Composition (IME, dead keys): the hidden input's composition events carry the text. */
  | { kind: "ime" }
  /** The browser chrome's own shortcut: never reaches the page. */
  | { kind: "chrome"; action: ChromeAction }
  /** An app-wide shortcut (views, Answer next, split): left to the app's keyboard map. */
  | { kind: "app" }
  /** Paste: the webview's paste event brings the clipboard text, inserted into the page. */
  | { kind: "paste" }
  /** Copy or cut: goes to the page, and the page's selection is copied to the device's clipboard. */
  | { kind: "copy"; cut: boolean }
  | { kind: "page" };

/**
 * Where a keydown goes. The page gets everything a browser tab gets, except the shortcuts a
 * browser keeps for itself (address bar, tabs, reload, history, zoom) and the app's own Ctrl+1…8,
 * Ctrl+J and Ctrl+\ (the terminal leaves the same to the app).
 */
export function routeKey(e: KeyLike, mac: boolean): KeyRoute {
  if (e.isComposing || e.keyCode === 229 || e.key === "Dead" || e.key === "Process") return { kind: "ime" };
  const primary = mac ? e.metaKey : e.ctrlKey;
  const only = (mods: { shift?: boolean; alt?: boolean }) => !!e.shiftKey === !!mods.shift && !!e.altKey === !!mods.alt;
  const code = e.code;
  const chrome = (action: ChromeAction): KeyRoute => ({ kind: "chrome", action });

  // Address bar.
  if ((primary && only({}) && code === "KeyL") || (!mac && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && code === "KeyD") || e.key === "F6") {
    return chrome("focusAddress");
  }
  // Tabs.
  if (primary && only({}) && (code === "KeyT" || code === "KeyN")) return chrome("newTab");
  if (primary && only({ shift: true }) && code === "KeyT") return chrome("reopenTab");
  if ((primary && only({}) && code === "KeyW") || (!mac && e.ctrlKey && e.key === "F4")) return chrome("closeTab");
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") return chrome(e.shiftKey ? "prevTab" : "nextTab");
  if (!mac && e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "PageDown" || e.key === "PageUp")) return chrome(e.key === "PageDown" ? "nextTab" : "prevTab");
  if (mac && e.metaKey && e.altKey && !e.shiftKey && !e.ctrlKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) return chrome(e.key === "ArrowRight" ? "nextTab" : "prevTab");
  if (mac && e.metaKey && e.shiftKey && !e.altKey && (code === "BracketRight" || code === "BracketLeft")) return chrome(code === "BracketRight" ? "nextTab" : "prevTab");
  // Reload.
  if (e.key === "F5" && !e.altKey && !e.metaKey) return chrome(e.shiftKey || e.ctrlKey ? "hardReload" : "reload");
  if (primary && !e.altKey && code === "KeyR") return chrome(e.shiftKey ? "hardReload" : "reload");
  // History.
  if (e.key === "BrowserBack") return chrome("back");
  if (e.key === "BrowserForward") return chrome("forward");
  if (!mac && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return chrome(e.key === "ArrowLeft" ? "back" : "forward");
  if (mac && e.metaKey && only({}) && (code === "BracketLeft" || code === "BracketRight")) return chrome(code === "BracketLeft" ? "back" : "forward");
  // Zoom (Ctrl+= with or without Shift: "+" sits on "=" on US layouts).
  if (primary && !e.altKey) {
    if (code === "Equal" || code === "NumpadAdd" || e.key === "+" || e.key === "=") return chrome("zoomIn");
    if (code === "Minus" || code === "NumpadSubtract" || e.key === "-") return chrome("zoomOut");
    if (!e.shiftKey && (code === "Digit0" || code === "Numpad0" || e.key === "0")) return chrome("zoomReset");
  }
  // Fullscreen, developer tools.
  if ((!mac && e.key === "F11") || (mac && e.ctrlKey && e.metaKey && code === "KeyF")) return chrome("fullscreen");
  if (e.key === "F12" || (primary && e.shiftKey && !e.altKey && (code === "KeyI" || code === "KeyJ")) || (mac && e.metaKey && e.altKey && (code === "KeyI" || code === "KeyJ"))) {
    return chrome("devtools");
  }

  // The app's own shortcuts (its keyboard map treats Ctrl and Cmd alike).
  const appMod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  if (appMod && (/^Digit[1-8]$/.test(code) || /^[1-8]$/.test(e.key) || code === "KeyJ" || code === "Backslash" || e.key === "\\")) return { kind: "app" };

  // Clipboard.
  if ((primary && !e.altKey && code === "KeyV") || (!mac && e.shiftKey && !e.ctrlKey && e.key === "Insert")) return { kind: "paste" };
  if ((primary && !e.altKey && !e.shiftKey && code === "KeyC") || (!mac && e.ctrlKey && !e.shiftKey && e.key === "Insert")) return { kind: "copy", cut: false };
  if ((primary && !e.altKey && !e.shiftKey && code === "KeyX") || (!mac && e.shiftKey && !e.ctrlKey && e.key === "Delete")) return { kind: "copy", cut: true };

  return { kind: "page" };
}

/** Zoom steps Chrome offers (percent / 100). */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? current;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const z = ZOOM_STEPS[i];
    if (z != null && z < current - 0.001) return z;
  }
  return ZOOM_STEPS[0] ?? current;
}

/**
 * What the address bar's text opens: a URL as typed (scheme added when it looks like a host), or
 * a web search for anything else.
 */
export function addressToUrl(input: string, searchUrl = "https://duckduckgo.com/?q="): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^(https?|file|about|chrome|data|view-source):/i.test(text)) return text;
  if (/\s/.test(text)) return searchUrl + encodeURIComponent(text);
  // localhost[:port][/…], an IPv4 address, or a dotted host name, optionally with a path.
  const hostLike = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|([a-z0-9-]+\.)+[a-z][a-z0-9-]*)(:\d{1,5})?([/?#].*)?$/i;
  if (hostLike.test(text)) {
    const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.)/i.test(text);
    return `${local ? "http" : "https"}://${text}`;
  }
  return searchUrl + encodeURIComponent(text);
}
