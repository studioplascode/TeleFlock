import { useEffect, useRef, useState } from "react";
import { cn } from "@/design";
import { isMac } from "@/design/lib/platform";
import { browserController, type Frame, useBrowserUi } from "./controller";
import { decodeFrame } from "./frames";
import { buttonName, buttonsMask, type ChromeAction, containRect, keyEventParams, type KeyLike, modifiersOf, type PageMap, pageScale, routeKey, toPagePoint, wheelDelta } from "./input";

/** Two clicks this close in time and space are a double click (Chrome's defaults). */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;

function keyLike(e: KeyboardEvent): KeyLike {
  return {
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    location: e.location,
    repeat: e.repeat,
    isComposing: e.isComposing,
    altGraph: e.getModifierState?.("AltGraph") ?? false,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
  };
}

interface ViewportProps {
  tabId: string;
  /** The user may drive this tab (their own, or an agent's they took over). */
  drives: boolean;
  /** The browser chrome's own shortcuts (address bar, tabs, reload, zoom). */
  onChrome(action: ChromeAction): void;
  /** Size of the drawing area, CSS px (the controller lays the user's pages out for it). */
  onSize(size: { width: number; height: number; dpr: number }): void;
  /** The picture is from before the page changed: the loading state until a new frame comes. */
  stale?: boolean;
  className?: string;
}

/**
 * The shown tab: its screencast drawn into a canvas, and the user's mouse, wheel, keys, text,
 * composition and paste forwarded to the page. A hidden textarea holds keyboard focus (so IME
 * and paste work as in any text field) at the last click, where an IME draws its candidates.
 */
export function Viewport({ tabId, drives, onChrome, onSize, stale, className }: ViewportProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const cursor = useBrowserUi((s) => s.cursor);
  const [hasFrame, setHasFrame] = useState(false);
  const [focused, setFocused] = useState(false);
  const live = useRef({ tabId, drives, onChrome, onSize });
  /** Client point → page mapping of the frame on screen (null before the first frame). */
  const mapRef = useRef<() => PageMap | null>(() => null);
  useEffect(() => {
    live.current = { tabId, drives, onChrome, onSize };
  });

  // Frames: decode the newest, draw it when the display paints, then let the browser send the next.
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    let pending: Frame | null = null;
    let drawing = false;
    let disposed = false;
    let raf = 0;
    let last: { img: ImageBitmap | HTMLImageElement; w: number; h: number } | null = null;
    let map: PageMap | null = null;

    const layout = () => {
      const rect = box.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return { rect, dpr };
    };

    const paint = () => {
      const { rect, dpr } = layout();
      ctx.fillStyle = getComputedStyle(box).backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!last) return;
      const fit = containRect({ left: 0, top: 0, width: rect.width, height: rect.height }, last.w, last.h);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(last.img, Math.round(fit.left * dpr), Math.round(fit.top * dpr), Math.round(fit.width * dpr), Math.round(fit.height * dpr));
    };

    const draw = () => {
      raf = 0;
      const frame = pending;
      pending = null;
      if (!frame || drawing) return;
      drawing = true;
      decodeFrame(frame.data)
        .then((img) => {
          if (disposed) {
            if ("close" in img) img.close();
            return;
          }
          if (last && "close" in last.img) last.img.close();
          const w = "naturalWidth" in img ? img.naturalWidth : img.width;
          const h = "naturalHeight" in img ? img.naturalHeight : img.height;
          last = { img, w, h };
          // The image shows the page viewport scaled; input maps through the same rectangle.
          const rect = box.getBoundingClientRect();
          const fit = containRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, frame.meta.deviceWidth, frame.meta.deviceHeight);
          map = { image: fit, page: { width: frame.meta.deviceWidth, height: frame.meta.deviceHeight } };
          paint();
          setHasFrame(true);
        })
        .catch(() => {})
        .finally(() => {
          drawing = false;
          frame.ack();
          if (pending && !raf) raf = requestAnimationFrame(draw);
        });
    };

    const unsubscribe = browserController().onFrame((f) => {
      if (f.tabId !== live.current.tabId) {
        f.ack();
        return;
      }
      // A newer frame replaces one not drawn yet: that one is done with.
      pending?.ack();
      pending = f;
      if (!raf && !drawing) raf = requestAnimationFrame(draw);
    });

    const ro = new ResizeObserver(() => {
      const { rect, dpr } = layout();
      live.current.onSize({ width: Math.round(rect.width), height: Math.round(rect.height), dpr });
      if (last && map) {
        const r = box.getBoundingClientRect();
        map = { ...map, image: containRect({ left: r.left, top: r.top, width: r.width, height: r.height }, map.page.width, map.page.height) };
      }
      paint();
    });
    ro.observe(box);
    mapRef.current = () => {
      if (!map) return null;
      // Scrolling or moving panels change the box's place without a resize.
      const r = box.getBoundingClientRect();
      return { ...map, image: containRect({ left: r.left, top: r.top, width: r.width, height: r.height }, map.page.width, map.page.height) };
    };
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      pending?.ack();
      unsubscribe();
      ro.disconnect();
      mapRef.current = () => null;
      if (last && "close" in last.img) last.img.close();
    };
  }, []);

  // A new tab shows nothing until its first frame.
  useEffect(() => {
    setHasFrame(false);
  }, [tabId]);

  // Mouse and wheel.
  useEffect(() => {
    const box = boxRef.current;
    const keys = keysRef.current;
    if (!box || !keys) return;
    const ctl = browserController();
    let move: { x: number; y: number; buttons: number; modifiers: number } | null = null;
    let raf = 0;
    let wheel: { x: number; y: number; dx: number; dy: number; modifiers: number } | null = null;
    let lastDown = { at: 0, x: 0, y: 0, button: -1, count: 0 };
    let down = 0;

    const point = (e: MouseEvent) => {
      const map = mapRef.current();
      return map ? toPagePoint(e.clientX, e.clientY, map) : null;
    };
    const flush = () => {
      raf = 0;
      const { tabId: id } = live.current;
      if (move) {
        ctl.mouse(id, { type: "mouseMoved", x: move.x, y: move.y, modifiers: move.modifiers, button: "none", buttons: move.buttons, clickCount: 0 });
        move = null;
      }
      if (wheel) {
        ctl.mouse(id, { type: "mouseWheel", x: wheel.x, y: wheel.y, modifiers: wheel.modifiers, button: "none", buttons: 0, clickCount: 0, deltaX: wheel.dx, deltaY: wheel.dy });
        wheel = null;
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const onDown = (e: PointerEvent) => {
      if (!live.current.drives) return;
      const p = point(e);
      if (!p?.inside) return;
      e.preventDefault();
      keys.style.left = `${e.clientX - box.getBoundingClientRect().left}px`;
      keys.style.top = `${e.clientY - box.getBoundingClientRect().top}px`;
      keys.focus({ preventScroll: true });
      box.setPointerCapture(e.pointerId);
      flush();
      const now = performance.now();
      const near = Math.abs(e.clientX - lastDown.x) <= MULTI_CLICK_PX && Math.abs(e.clientY - lastDown.y) <= MULTI_CLICK_PX;
      const count = now - lastDown.at < MULTI_CLICK_MS && near && lastDown.button === e.button ? lastDown.count + 1 : 1;
      lastDown = { at: now, x: e.clientX, y: e.clientY, button: e.button, count };
      down = buttonsMask(e.buttons);
      ctl.mouse(live.current.tabId, { type: "mousePressed", x: p.x, y: p.y, modifiers: modifiersOf(e), button: buttonName(e.button), buttons: down, clickCount: count });
    };
    const onMove = (e: PointerEvent) => {
      if (!live.current.drives) return;
      const p = point(e);
      if (!p) return;
      move = { x: p.x, y: p.y, buttons: buttonsMask(e.buttons), modifiers: modifiersOf(e) };
      schedule();
    };
    const onUp = (e: PointerEvent) => {
      if (!live.current.drives || down === 0) return;
      const p = point(e);
      if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
      flush();
      down = buttonsMask(e.buttons);
      if (!p) return;
      ctl.mouse(live.current.tabId, { type: "mouseReleased", x: p.x, y: p.y, modifiers: modifiersOf(e), button: buttonName(e.button), buttons: down, clickCount: lastDown.count });
    };
    const onWheel = (e: WheelEvent) => {
      if (!live.current.drives) return;
      const map = mapRef.current();
      const p = map ? toPagePoint(e.clientX, e.clientY, map) : null;
      if (!map || !p?.inside) return;
      e.preventDefault();
      const d = wheelDelta(e, map.page.height, pageScale(map), isMac);
      wheel = wheel ? { ...wheel, x: p.x, y: p.y, dx: wheel.dx + d.deltaX, dy: wheel.dy + d.deltaY } : { x: p.x, y: p.y, dx: d.deltaX, dy: d.deltaY, modifiers: modifiersOf(e) };
      schedule();
    };
    const onContext = (e: MouseEvent) => {
      if (live.current.drives) e.preventDefault();
    };
    box.addEventListener("pointerdown", onDown);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
    box.addEventListener("pointercancel", onUp);
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("contextmenu", onContext);
    return () => {
      cancelAnimationFrame(raf);
      box.removeEventListener("pointerdown", onDown);
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointercancel", onUp);
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("contextmenu", onContext);
    };
  }, []);

  // Keys, text, composition and paste, through the hidden textarea.
  useEffect(() => {
    const keys = keysRef.current;
    if (!keys) return;
    const ctl = browserController();
    const pressed = new Map<string, KeyLike>();
    let composing = false;

    const clear = () => {
      keys.value = "";
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const { tabId: id, drives } = live.current;
      const k = keyLike(e);
      const route = routeKey(k, isMac);
      if (route.kind === "ime") return;
      if (route.kind === "app") return;
      if (route.kind === "chrome") {
        e.preventDefault();
        e.stopPropagation();
        live.current.onChrome(route.action);
        return;
      }
      if (!drives) return;
      if (route.kind === "paste") {
        // The webview's own paste event brings the clipboard (no permission prompt).
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (route.kind === "copy") {
        void ctl.copySelection(id).then(() => {
          ctl.key(id, keyEventParams(k, "down", isMac));
          ctl.key(id, keyEventParams(k, "up", isMac));
        });
        return;
      }
      pressed.set(e.code || e.key, k);
      ctl.key(id, keyEventParams(k, "down", isMac));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = pressed.get(e.code || e.key);
      if (!k) return;
      pressed.delete(e.code || e.key);
      e.preventDefault();
      e.stopPropagation();
      ctl.key(live.current.tabId, keyEventParams(keyLike(e), "up", isMac));
    };
    const onCompStart = () => {
      composing = true;
    };
    const onCompUpdate = (e: CompositionEvent) => {
      if (!live.current.drives) return;
      ctl.compose(live.current.tabId, e.data, e.data.length, e.data.length);
    };
    const onCompEnd = (e: CompositionEvent) => {
      composing = false;
      if (live.current.drives && e.data) ctl.insertText(live.current.tabId, e.data, "ime");
      else if (live.current.drives) ctl.compose(live.current.tabId, "", 0, 0);
      clear();
    };
    const onInput = (e: Event) => {
      // Text that arrived without a key we forwarded (dead keys, some IMEs, emoji pickers).
      if (composing) return;
      const data = e instanceof InputEvent ? e.data : null;
      if (data && live.current.drives) ctl.insertText(live.current.tabId, data, "insert");
      clear();
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text && live.current.drives) ctl.insertText(live.current.tabId, text.replace(/\r\n?/g, "\n"), "paste");
    };
    const release = () => {
      setFocused(false);
      // Keys held when focus leaves would stay down in the page.
      for (const k of pressed.values()) ctl.key(live.current.tabId, keyEventParams(k, "up", isMac));
      pressed.clear();
      composing = false;
      clear();
    };
    const onFocus = () => setFocused(true);
    keys.addEventListener("keydown", onKeyDown);
    keys.addEventListener("keyup", onKeyUp);
    keys.addEventListener("compositionstart", onCompStart);
    keys.addEventListener("compositionupdate", onCompUpdate);
    keys.addEventListener("compositionend", onCompEnd);
    keys.addEventListener("input", onInput);
    keys.addEventListener("paste", onPaste);
    keys.addEventListener("blur", release);
    keys.addEventListener("focus", onFocus);
    return () => {
      keys.removeEventListener("keydown", onKeyDown);
      keys.removeEventListener("keyup", onKeyUp);
      keys.removeEventListener("compositionstart", onCompStart);
      keys.removeEventListener("compositionupdate", onCompUpdate);
      keys.removeEventListener("compositionend", onCompEnd);
      keys.removeEventListener("input", onInput);
      keys.removeEventListener("paste", onPaste);
      keys.removeEventListener("blur", release);
      keys.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <div
      ref={boxRef}
      data-browser-viewport=""
      className={cn("relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden bg-bg-deep select-none", focused && drives && "shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]", className)}
      style={{ cursor: drives ? cursor : "default" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" aria-hidden />
      <textarea
        ref={keysRef}
        aria-label="Type into the page"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={drives ? 0 : -1}
        className="pointer-events-none absolute size-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
        style={{ left: 0, top: 0 }}
      />
      {(!hasFrame || stale) && <div className="absolute inset-0 grid place-items-center bg-tile-1 text-sm text-mute">Loading the page…</div>}
    </div>
  );
}
