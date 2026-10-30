import { type ClipboardEvent, type KeyboardEvent, type RefObject, useRef, useState } from "react";
import { useStore } from "zustand";
import { type DraftSetter, drafts, toApiError } from "@/core";
import { draftPastes, MAX_DRAFT_PASTES, useDraftPastes } from "@/core/draftPastes";
import {
  addPaste,
  DEFAULT_PASTE_MENU_THRESHOLD,
  type DraftPaste,
  deletionRange,
  expandPastes,
  isMarkerSized,
  keptPastes,
  lineCount,
  livePastes,
  MAX_ORPHAN_PASTES,
  MAX_PASTE_BYTES,
  markerSpans,
  missingPastes,
  nextPasteNumber,
  normalizePaste,
  offersMenu,
  pasteExpansion,
  pasteToken,
  reconcileTokens,
  snapCaret,
  type TokenSpan,
  tokenSpans,
  utf8Bytes,
  wholeTokens,
} from "@/core/pastes";
import { toast } from "@/design";
import { pasteThreshold, usePrefetchPasteThreshold } from "./pasteThreshold";

/** What the paste menu does: omp's three choices, plus editing and removing from a chip. */
export type PasteAction = "block" | "file" | "inline" | "edit" | "remove";

export interface PasteMenuItem {
  action: PasteAction;
  label: string;
  description: string;
  disabled?: boolean;
  /** The paste is sent this way now. */
  checked?: boolean;
}

export interface PasteMenuState {
  n: number;
  /** Opened by the paste itself (omp's menu: Esc pastes inline); else from its chip. */
  auto: boolean;
  /** Highlighted item. */
  sel: number;
}

/**
 * The menu of paste `p`: omp's three choices with omp's words (input-controller.ts
 * presentLargePasteMenu); opened from the chip also Edit as text and Remove. Without a session
 * (Dispatch) the file choice stays visible but off, with `fileOff` as its reason.
 */
export function pasteMenuItems(p: DraftPaste, auto: boolean, fileOff?: string): PasteMenuItem[] {
  const items: PasteMenuItem[] = [
    { action: "block", label: "Attach as a wrapped block", description: "Wrap the text in <attachment> tags, collapsed to a marker", checked: !auto && p.mode === "block" },
    { action: "file", label: "Attach as local file", description: fileOff ?? "Save the text to a local://paste file", disabled: !!fileOff },
    { action: "inline", label: "Paste inline", description: "Collapse the text to an inline paste marker", checked: !auto && p.mode === "inline" },
  ];
  if (auto) return items;
  return [
    ...items,
    { action: "edit", label: "Edit as text", description: "Put the text into the message to change it" },
    { action: "remove", label: "Remove", description: "Take the paste out of the message" },
  ];
}

/** The next enabled item from `sel` in direction `step` (wrapping). */
export function stepMenu(items: readonly PasteMenuItem[], sel: number, step: 1 | -1): number {
  for (let i = 1; i <= items.length; i++) {
    const at = (((sel + step * i) % items.length) + items.length) % items.length;
    if (!items[at]?.disabled) return at;
  }
  return sel;
}

export interface PasteAttachOptions {
  /** Key of the draft's text; its pastes live under the same key. */
  draftKey: string;
  /** The host whose omp settings say from how many lines the menu opens by itself. */
  hostId: string | undefined;
  text: string;
  setText: DraftSetter<string>;
  ta: RefObject<HTMLTextAreaElement | null>;
  /** Saves a paste as `local://paste-N.md` in the agent's session; absent: no session (Dispatch). */
  saveFile?: (text: string) => Promise<{ url: string }>;
  /** Why "Attach as local file" is off when there is no `saveFile`. */
  fileOff?: string;
}

/** The message as it goes to the agent, or why it can't go yet. */
export type PreparedMessage = { ok: true; text: string; carried: number[] } | { ok: false; title: string; hint: string };

/** A composer's large pastes (`usePasteAttach`). */
export interface PasteAttach {
  /** Pastes whose token is in the text, in its order. */
  pastes: DraftPaste[];
  /** Token numbers in the text whose paste this device no longer has. */
  missing: number[];
  /** Pastes being saved as files. */
  saving: readonly number[];
  menu: PasteMenuState | null;
  menuPaste: DraftPaste | undefined;
  menuItems: PasteMenuItem[];
  open(n: number): void;
  close(): void;
  highlight(sel: number): void;
  choose(action: PasteAction): void;
  remove(n: number): void;
  /** Takes out the markers of a paste this device no longer has. */
  removeMissing(n: number): void;
  /** Text pastes: true when it was taken (the composer does nothing more). Images and videos go first. */
  onPaste(e: ClipboardEvent<HTMLTextAreaElement>): boolean;
  /** The textarea's new value (`onChange`): tokens a stray edit cut into are repaired. Sets the draft; returns the text and caret that stand. */
  change(next: string, caret: number, composing?: boolean): { text: string; caret: number };
  /** Menu keys while it is open, Backspace / Delete over tokens. True: handled. */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** The caret never rests inside a token (`onSelect`). */
  onSelect(el: HTMLTextAreaElement): void;
  /** Copy and cut carry the text the tokens stand for, whole tokens only. */
  onCopy(e: ClipboardEvent<HTMLTextAreaElement>, cut?: boolean): void;
  /**
   * The message to send (`message`: the draft as the composer would send it) with every token
   * expanded; refused while a paste is being saved or when a token's paste is gone. Waits for the
   * draft's stored pastes.
   */
  prepare(message: string): Promise<PreparedMessage>;
  /** After a send: forget the pastes it carried unless their token is still in the draft. */
  sent(carried: readonly number[]): void;
}

/**
 * Large pastes in a composer's textarea, as omp's editor takes them (`@/core/pastes`): a
 * marker-sized paste becomes a token (one undoable edit, so Ctrl+Z takes it out again) and a chip;
 * from the host's `paste.largeMenuThreshold` lines on, omp's menu opens. Tokens edit as one unit:
 * Backspace / Delete take a whole token, the caret steps over one, copy and cut carry the text
 * the token stands for, and any other edit that cuts into one (word deletion, typing over a
 * selection, a phone keyboard's corrections) takes all of it. Send through `prepare`, then `sent`.
 */
export function usePasteAttach(o: PasteAttachOptions): PasteAttach {
  const { draftKey, text, setText, ta } = o;
  const [all] = useDraftPastes(draftKey);
  const loaded = useStore(draftPastes.api, (s) => !!s.loaded[draftKey]);
  const [menu, setMenu] = useState<PasteMenuState | null>(null);
  const [saving, setSaving] = useState<readonly number[]>([]);
  /** The caret before the latest selection change (which way it moved into a token). */
  const lastCaret = useRef(0);
  /** Set while an edit of ours runs: its input event needs no repair. */
  const ours = useRef(false);
  usePrefetchPasteThreshold(o.hostId);

  const live = livePastes(text, all);
  const missing = loaded ? missingPastes(text, all) : [];
  const menuPaste = menu ? all.find((p) => p.n === menu.n) : undefined;
  const menuItems = menu && menuPaste ? pasteMenuItems(menuPaste, menu.auto, o.saveFile ? undefined : (o.fileOff ?? "Needs the agent's session")) : [];

  /**
   * Replaces `[start, end)` with `by`. With the textarea focused it is an edit the browser can
   * undo (`insertText` / `delete`, which fire the usual input event); else through the draft.
   */
  const replace = (start: number, end: number, by: string) => {
    const el = ta.current;
    if (el && document.activeElement === el) {
      el.setSelectionRange(start, end);
      ours.current = true;
      let done = false;
      try {
        done = by ? document.execCommand("insertText", false, by) : document.execCommand("delete");
      } catch {
        done = false;
      } finally {
        ours.current = false;
      }
      if (done) return;
    }
    setText((cur) => cur.slice(0, start) + by + cur.slice(end));
  };

  /** The current text: the textarea's while it shows the draft, else the draft's. */
  const current = () => ta.current?.value ?? drafts.get(draftKey);

  /** Replaces every token of `p` with `by` (removing also takes the space after each), last one first. */
  const replaceTokens = (spans: readonly TokenSpan[], by: string) => {
    const value = current();
    for (const s of [...spans].sort((a, b) => b.start - a.start)) replace(s.start, by === "" && value[s.end] === " " ? s.end + 1 : s.end, by);
  };
  const spansOf = (p: DraftPaste) => tokenSpans(current(), [p]);

  const update = (n: number, patch: Partial<DraftPaste>) => draftPastes.update(draftKey, (list) => list.map((p) => (p.n === n ? { ...p, ...patch } : p)));

  const saveAsFile = async (p: DraftPaste) => {
    if (!o.saveFile || saving.includes(p.n)) return;
    setSaving((s) => [...s, p.n]);
    try {
      const { url } = await o.saveFile(p.text);
      // The token stays a deleted paste for a while: undo brings it back with its text.
      replaceTokens(spansOf(p), url);
      toast({ title: `Saved ${lineCount(p.text)} pasted lines to ${url}`, status: "done", duration: 3200 });
    } catch (e) {
      const err = toApiError(e);
      const why =
        err.code === "unknown_method" ? "This host's TeleFlock is too old to save pastes as files; it updates when an updated app reconnects" : err.hint ? `${err.message} — ${err.hint}` : err.message;
      toast({ title: "Couldn't save the paste as a file", description: `${why}. It stays in the message as a paste.`, status: "error" });
    } finally {
      setSaving((s) => s.filter((n) => n !== p.n));
    }
  };

  const choose = (action: PasteAction) => {
    const p = menuPaste;
    const auto = menu?.auto;
    setMenu(null);
    if (!p) return;
    switch (action) {
      case "block":
      case "inline":
        update(p.n, { mode: action });
        break;
      case "file":
        void saveAsFile(p);
        break;
      case "edit":
        ta.current?.focus();
        replaceTokens(spansOf(p), pasteExpansion(p));
        break;
      case "remove":
        replaceTokens(spansOf(p), "");
        break;
    }
    if (auto) ta.current?.focus();
  };

  return {
    pastes: live,
    missing,
    saving,
    menu,
    menuPaste,
    menuItems,
    open: (n: number) => setMenu({ n, auto: false, sel: 0 }),
    close: () => setMenu(null),
    highlight: (sel: number) => setMenu((m) => (m ? { ...m, sel } : m)),
    choose,
    remove: (n: number) => {
      const p = all.find((x) => x.n === n);
      if (p) replaceTokens(spansOf(p), "");
    },
    removeMissing: (n: number) => replaceTokens(markerSpans(current()).filter((s) => s.n === n), ""),

    onPaste(e: ClipboardEvent<HTMLTextAreaElement>): boolean {
      const raw = e.clipboardData.getData("text/plain");
      if (!raw) return false;
      const pasted = normalizePaste(raw);
      if (!isMarkerSized(pasted)) return false;
      e.preventDefault();
      const bytes = utf8Bytes(pasted);
      if (bytes > MAX_PASTE_BYTES) {
        toast({ title: "Paste too large", description: `It is ${(bytes / 1024 / 1024).toFixed(1)} MB; a pasted text can be at most ${MAX_PASTE_BYTES / 1024 / 1024} MB.`, status: "error" });
        return true;
      }
      const el = e.currentTarget;
      const at = { start: el.selectionStart, end: el.selectionEnd };
      const insert = () => {
        const paste: DraftPaste = { n: nextPasteNumber(draftPastes.get(draftKey), current()), text: pasted, mode: "inline", at: Date.now() };
        // Never at the cost of a paste still in the draft: the newest is refused instead.
        const next = addPaste(current(), draftPastes.get(draftKey), paste, MAX_DRAFT_PASTES);
        if (!next) {
          toast({ title: `At most ${MAX_DRAFT_PASTES} pastes in one message`, description: "Send it, or remove a paste (its chip), before pasting more. Your clipboard is untouched.", status: "error" });
          return;
        }
        draftPastes.update(draftKey, () => next);
        // omp inserts its marker and one space (the space survives the trim on send only inside the message).
        replace(at.start, at.end, `${pasteToken(paste)} `);
        const ask = o.hostId ? pasteThreshold(o.hostId) : Promise.resolve(DEFAULT_PASTE_MENU_THRESHOLD);
        void ask.then((threshold) => {
          if (offersMenu(pasted, threshold) && tokenSpans(current(), [paste]).length > 0) setMenu({ n: paste.n, auto: true, sel: 0 });
        });
      };
      if (loaded) insert();
      else void draftPastes.hydrate(draftKey).then(insert);
      return true;
    },

    change(next: string, caret: number, composing = false): { text: string; caret: number } {
      let out = { text: next, caret };
      if (!ours.current && !composing && all.length > 0) {
        const fixed = reconcileTokens(text, next, caret, all);
        if (fixed) {
          out = fixed;
          requestAnimationFrame(() => ta.current?.setSelectionRange(fixed.caret, fixed.caret));
        }
      }
      setText(out.text);
      // Typing while omp's menu waits keeps the paste inline (omp's Esc).
      if (menu?.auto && !ours.current) setMenu(null);
      // Deleted pastes beyond the few undo may still want back are forgotten (judged on the
      // store's list: a paste added in this event is not in this render's yet).
      if (draftPastes.get(draftKey).length > MAX_ORPHAN_PASTES) {
        draftPastes.update(draftKey, (list) => {
          const kept = keptPastes(out.text, list);
          return kept.length < list.length ? kept : list;
        });
      }
      return out;
    },

    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (e.nativeEvent.isComposing) return false;
      if (menu && menuItems.length) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setMenu({ ...menu, sel: stepMenu(menuItems, menu.sel, e.key === "ArrowDown" ? 1 : -1) });
          return true;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          const item = menuItems[menu.sel];
          if (item && !item.disabled) choose(item.action);
          return true;
        }
        if (e.key === "Escape") {
          // omp: Esc pastes inline, which is how the paste already sits.
          e.preventDefault();
          e.stopPropagation();
          setMenu(null);
          return true;
        }
      }
      if (e.key !== "Backspace" && e.key !== "Delete") return false;
      const el = e.currentTarget;
      const spans = tokenSpans(el.value, all);
      const range = spans.length ? deletionRange(spans, el.selectionStart, el.selectionEnd, e.key) : null;
      if (!range) return false;
      e.preventDefault();
      replace(range.start, range.end, "");
      return true;
    },

    onSelect(el: HTMLTextAreaElement): void {
      const { selectionStart: a, selectionEnd: b } = el;
      if (a === b && all.length > 0) {
        const to = snapCaret(tokenSpans(el.value, all), a, lastCaret.current);
        if (to !== null) {
          lastCaret.current = to;
          el.setSelectionRange(to, to);
          return;
        }
      }
      lastCaret.current = b;
    },

    onCopy(e: ClipboardEvent<HTMLTextAreaElement>, cut = false): void {
      const el = e.currentTarget;
      if (el.selectionStart === el.selectionEnd || !all.length) return;
      const spans = tokenSpans(el.value, all);
      const range = wholeTokens(spans, el.selectionStart, el.selectionEnd) ?? { start: el.selectionStart, end: el.selectionEnd };
      if (!spans.some((s) => s.start < range.end && s.end > range.start)) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", expandPastes(el.value.slice(range.start, range.end), all));
      if (cut) replace(range.start, range.end, "");
    },

    async prepare(message: string): Promise<PreparedMessage> {
      await draftPastes.hydrate(draftKey);
      const list = draftPastes.get(draftKey);
      if (saving.length > 0) return { ok: false, title: "Saving the paste as a file…", hint: "Send it once the paste is saved." };
      const lost = missingPastes(message, list);
      if (lost.length > 0) {
        return { ok: false, title: `Paste #${lost[0]} is no longer on this device`, hint: "Remove its marker from the message, or paste the text again." };
      }
      return { ok: true, text: expandPastes(message, list), carried: livePastes(message, list).map((p) => p.n) };
    },

    sent(carried: readonly number[]): void {
      if (!carried.length) return;
      const remaining = drafts.get(draftKey);
      draftPastes.update(draftKey, (list) => list.filter((p) => !carried.includes(p.n) || tokenSpans(remaining, [p]).length > 0));
    },
  };
}
