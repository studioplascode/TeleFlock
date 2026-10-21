import { useEffect, useState } from "react";

/** Minimum viewport shrink (px) that counts as the on-screen keyboard rather than browser chrome. */
const KEYBOARD_MIN_PX = 120;

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.readOnly && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(el.type);
  return false;
}

/**
 * Tracks the phone's soft keyboard through `visualViewport` and publishes it for layout:
 * - `--kb-inset` on `<html>`: how far the keyboard overlaps the layout viewport (0 when the
 *   webview resizes the layout for it, as `interactive-widget=resizes-content` asks; non-zero on
 *   webviews that overlay the keyboard instead), so the shell can pad itself above it;
 * - returns whether the keyboard is up (an editable field is focused and the visible viewport is
 *   clearly shorter than the tallest one seen at this width), so the shell can hide the bottom nav
 *   and give the composer the room.
 */
export function useSoftKeyboard(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;
    let width = window.innerWidth;
    let tallest = window.innerHeight;
    let raf = 0;
    const update = () => {
      raf = 0;
      if (window.innerWidth !== width) {
        // Rotation / resize: start over (the keyboard can't be measured against another width).
        width = window.innerWidth;
        tallest = window.innerHeight;
      }
      const editing = isEditable(document.activeElement);
      if (!editing) tallest = Math.max(window.innerHeight, vv.height);
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      const up = editing && tallest - vv.height > KEYBOARD_MIN_PX;
      root.style.setProperty("--kb-inset", `${up ? inset : 0}px`);
      root.dataset.kb = up ? "open" : "closed";
      setOpen(up);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("focusin", schedule);
    window.addEventListener("focusout", schedule);
    schedule();
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("focusin", schedule);
      window.removeEventListener("focusout", schedule);
      cancelAnimationFrame(raf);
      root.style.removeProperty("--kb-inset");
      delete root.dataset.kb;
    };
  }, []);
  return open;
}
