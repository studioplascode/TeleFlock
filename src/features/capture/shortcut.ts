/*
 * The Quick capture shortcut as the desktop shell registers it: an accelerator string
 * (`Ctrl+Alt+Space`, `Cmd+Shift+Space`) in the format of tauri-plugin-global-shortcut (global-hotkey:
 * modifiers first, one main key, names case-insensitive). Recording one from a key press, showing
 * it as key caps, and telling when it would take a combination away from TeleFlock itself or from
 * the system.
 */

export type DesktopPlatform = "windows" | "macos" | "linux";

/** The parts of a `KeyboardEvent` a recorder reads (structural, so tests pass plain objects). */
export interface KeyChord {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

type Mod = "ctrl" | "alt" | "shift" | "super";
const MOD_ORDER: readonly Mod[] = ["ctrl", "alt", "shift", "super"];

/** A parsed accelerator: its modifiers and its main key (global-hotkey's upper-case key name). */
export interface Accel {
  mods: ReadonlySet<Mod>;
  key: string;
}

/** `KeyboardEvent.code` of keys that are only modifiers. */
const MODIFIER_CODE = /^(Control|Alt|Shift|Meta|OS|AltGraph)(Left|Right)?$/;

const NAMED_CODES: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "Backquote",
  Minus: "Minus",
  Equal: "Equal",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backslash: "Backslash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  NumpadAdd: "NumAdd",
  NumpadSubtract: "NumSubtract",
  NumpadMultiply: "NumMultiply",
  NumpadDivide: "NumDivide",
  NumpadDecimal: "NumDecimal",
  NumpadEnter: "NumEnter",
};

/** Key caps for the keys whose name is not what is printed on them. */
const KEY_CAP: Record<string, string> = {
  BACKQUOTE: "`",
  MINUS: "-",
  EQUAL: "=",
  BRACKETLEFT: "[",
  BRACKETRIGHT: "]",
  BACKSLASH: "\\",
  SEMICOLON: ";",
  QUOTE: "'",
  COMMA: ",",
  PERIOD: ".",
  SLASH: "/",
  UP: "↑",
  DOWN: "↓",
  LEFT: "←",
  RIGHT: "→",
  SPACE: "Space",
  ENTER: "Enter",
  TAB: "Tab",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  INSERT: "Insert",
  HOME: "Home",
  END: "End",
  PAGEUP: "Page Up",
  PAGEDOWN: "Page Down",
  ESCAPE: "Esc",
};

/** Symbols an accelerator may use for a key, by their key name. */
const SYMBOL_KEY: Record<string, string> = {
  "`": "BACKQUOTE",
  "-": "MINUS",
  "=": "EQUAL",
  "[": "BRACKETLEFT",
  "]": "BRACKETRIGHT",
  "\\": "BACKSLASH",
  ";": "SEMICOLON",
  "'": "QUOTE",
  ",": "COMMA",
  ".": "PERIOD",
  "/": "SLASH",
};

/** The accelerator's name for a physical key, or null when it can't be a global shortcut's key. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const num = /^Numpad([0-9])$/.exec(code);
  if (num) return `Num${num[1]}`;
  return NAMED_CODES[code] ?? null;
}

const isFunctionKey = (key: string) => /^F([1-9]|1[0-9]|2[0-4])$/i.test(key);

/**
 * The accelerator a key press records (`Ctrl+Alt+Space`), or why it can't be a global shortcut.
 * `null` while only modifiers are held. A shortcut needs Ctrl, Alt or the Super/⌘ key (function
 * keys may stand alone): Shift alone would take a letter away from typing everywhere.
 */
export function chordToAccelerator(e: KeyChord, platform: DesktopPlatform): { accelerator: string } | { error: string } | null {
  if (MODIFIER_CODE.test(e.code)) return null;
  if (e.code === "Escape") return { error: "Esc can't be a shortcut: it closes things." };
  const key = keyName(e.code);
  if (!key) return { error: "That key can't be part of a system-wide shortcut. Try a letter, a number, Space or F1–F24." };
  const mac = platform === "macos";
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && (mac ? "Cmd" : "Super")].filter((m): m is string => !!m);
  if (!e.ctrlKey && !e.altKey && !e.metaKey && !isFunctionKey(key)) {
    return { error: `Add ${mac ? "⌃, ⌥ or ⌘" : "Ctrl, Alt or the Super key"}${e.shiftKey ? " (Shift alone would block typing it)" : ""}.` };
  }
  return { accelerator: [...mods, key].join("+") };
}

/** Parse an accelerator (any spelling global-hotkey accepts); null when it has no main key. */
export function parseAccelerator(s: string, platform: DesktopPlatform): Accel | null {
  const tokens = s.split("+").map((t) => t.trim());
  // `Ctrl++`: a plus key would split into empty tokens; not offered by the recorder.
  if (tokens.some((t) => !t)) return null;
  const mods = new Set<Mod>();
  let key: string | null = null;
  for (const raw of tokens) {
    const t = raw.toUpperCase();
    if (key) return null; // modifiers come first, one main key
    if (t === "CTRL" || t === "CONTROL") mods.add("ctrl");
    else if (t === "ALT" || t === "OPTION") mods.add("alt");
    else if (t === "SHIFT") mods.add("shift");
    else if (t === "SUPER" || t === "CMD" || t === "COMMAND" || t === "META" || t === "WIN") mods.add("super");
    else if (["CMDORCTRL", "CMDORCONTROL", "COMMANDORCTRL", "COMMANDORCONTROL"].includes(t)) mods.add(platform === "macos" ? "super" : "ctrl");
    else key = normalizeKey(raw);
  }
  return key ? { mods, key } : null;
}

function normalizeKey(raw: string): string {
  const sym = SYMBOL_KEY[raw];
  if (sym) return sym;
  const t = raw.toUpperCase();
  if (/^KEY[A-Z]$/.test(t)) return t.slice(3);
  if (/^DIGIT[0-9]$/.test(t)) return t.slice(5);
  if (/^ARROW(UP|DOWN|LEFT|RIGHT)$/.test(t)) return t.slice(5);
  if (/^NUMPAD/.test(t)) return `NUM${t.slice(6)}`;
  if (t === "ESC") return "ESCAPE";
  return t;
}

/** One identity per combination (`ctrl+alt+SPACE`), whatever the spelling. */
function accelId(a: Accel): string {
  return [...MOD_ORDER.filter((m) => a.mods.has(m)), a.key].join("+");
}

/** The same combination, however each is spelled. */
export function sameAccelerator(a: string, b: string, platform: DesktopPlatform): boolean {
  const x = parseAccelerator(a, platform);
  const y = parseAccelerator(b, platform);
  return !!x && !!y && accelId(x) === accelId(y);
}

/** Key caps for an accelerator (`["Ctrl", "Alt", "Space"]`, macOS `["⌃", "⌥", "Space"]`). */
export function acceleratorCaps(s: string, platform: DesktopPlatform): string[] {
  const a = parseAccelerator(s, platform);
  if (!a) return [s];
  const mac = platform === "macos";
  const name: Record<Mod, string> = mac
    ? { ctrl: "⌃", alt: "⌥", shift: "⇧", super: "⌘" }
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: platform === "windows" ? "Win" : "Super" };
  // macOS writes ⌃⌥⇧⌘ in this order too.
  const key = KEY_CAP[a.key] ?? (/^NUM(\d)$/.test(a.key) ? `Num ${a.key.slice(3)}` : a.key.length === 1 ? a.key : a.key[0] + a.key.slice(1).toLowerCase());
  return [...MOD_ORDER.filter((m) => a.mods.has(m)).map((m) => name[m]), isFunctionKey(a.key) ? a.key : key];
}

/** The `?` sheet's shape (`@/features/shell/keyboard`): key caps per shortcut. */
export interface AppShortcut {
  keys: readonly string[];
  label: string;
}

/**
 * The TeleFlock shortcut a global one would take over: inside the app the system-wide grab wins,
 * so that one would stop working. The app reads Ctrl as Ctrl or ⌘.
 */
export function appClash(accelerator: string, shortcuts: readonly AppShortcut[], platform: DesktopPlatform): string | null {
  const mine = parseAccelerator(accelerator, platform);
  if (!mine) return null;
  for (const s of shortcuts) {
    if (!s.keys.some((k) => k === "Ctrl" || k === "Alt" || k === "Shift")) continue;
    const theirs = parseAccelerator(s.keys.join("+"), platform);
    if (!theirs) continue;
    const variants = theirs.mods.has("ctrl") ? [theirs, { mods: new Set<Mod>([...theirs.mods].map((m) => (m === "ctrl" ? "super" : m))), key: theirs.key }] : [theirs];
    if (variants.some((v) => accelId(v) === accelId(mine))) return s.label;
  }
  return null;
}

/** Combinations the desktop itself usually owns, per platform, and what they do there. */
const SYSTEM: Record<DesktopPlatform, Record<string, string>> = {
  windows: {
    "alt+SPACE": "opens the window menu",
    "alt+TAB": "switches windows",
    "alt+F4": "closes the window",
    "ctrl+alt+DELETE": "opens the security screen",
    "ctrl+shift+ESCAPE": "opens Task Manager",
    "super+SPACE": "switches the keyboard layout",
    "super+L": "locks the PC",
    "super+D": "shows the desktop",
    "super+E": "opens File Explorer",
    "super+R": "opens Run",
    "super+TAB": "opens Task View",
    "super+V": "opens clipboard history",
    "super+PERIOD": "opens the emoji panel",
    "super+shift+S": "takes a screenshot",
  },
  macos: {
    "super+SPACE": "opens Spotlight",
    "alt+super+SPACE": "opens a Finder search window",
    "ctrl+SPACE": "selects the previous input source",
    "ctrl+alt+SPACE": "selects the next input source",
    "ctrl+super+SPACE": "opens the Character Viewer",
    "super+TAB": "switches apps",
    "super+Q": "quits the app in front",
    "super+W": "closes the window",
    "super+H": "hides the app in front",
    "super+M": "minimizes the window",
    "shift+super+3": "takes a screenshot",
    "shift+super+4": "takes a screenshot",
    "shift+super+5": "opens the screenshot toolbar",
    "ctrl+super+Q": "locks the Mac",
  },
  linux: {
    "alt+TAB": "switches windows",
    "alt+F4": "closes the window",
    "alt+F2": "runs a command on GNOME and KDE",
    "alt+SPACE": "opens the window menu or KRunner",
    "super+SPACE": "switches the input source on GNOME",
    "ctrl+alt+T": "opens a terminal on Ubuntu",
    "ctrl+alt+DELETE": "logs out on many desktops",
    "ctrl+alt+L": "locks the screen on many desktops",
    "super+L": "locks the screen",
    "ctrl+alt+UP": "switches workspaces",
    "ctrl+alt+DOWN": "switches workspaces",
    "ctrl+alt+LEFT": "switches workspaces",
    "ctrl+alt+RIGHT": "switches workspaces",
    PRINTSCREEN: "takes a screenshot",
  },
};

/** What the desktop usually does with this combination (a hint: registering it is the real test). */
export function systemClash(accelerator: string, platform: DesktopPlatform): string | null {
  const a = parseAccelerator(accelerator, platform);
  return a ? (SYSTEM[platform][accelId(a)] ?? null) : null;
}
