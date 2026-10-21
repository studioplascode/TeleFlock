import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { AnimatePresence, motion } from "motion/react";
import { ClipboardCopy, ClipboardPaste, Cpu, Eye, Keyboard, Minus, Plus, RotateCcw, ScanLine, SquareMousePointer, Zap } from "lucide-react";
import { type CSSProperties, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { openLink, useHosts, useSettings } from "@/core";
import type { TermMode, TermOpened, TermTarget, TunnelInfo } from "@/core/gen";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  StatusOrb,
  type Status,
  cn,
  spring,
  toast,
  useActivity,
  useIsMobile,
  useMediaQuery,
} from "@/design";
import { PreviewSheet } from "@/features/preview/PreviewButton";
import { openExternal, openTunnel } from "@/features/preview/store";
import { haptic } from "@/features/shell/haptics";
import { PHASE_LABEL } from "@/features/shell/status";
import { localhostUrlRanges } from "./frames";
import { ExtraKeys, type ExtraKey, type ModLatch, type ModState } from "./ExtraKeys";
import { applyMods, encodeKey } from "./keys";
import { PaneOverlay, closedCopy } from "./PaneOverlay";
import { type TermPhase, TermSession } from "./session";
import { COMPACT_FONT_SIZE, DEFAULT_FONT_SIZE, TERM_FONT_FAMILY, clampFontSize, termTheme } from "./theme";
import { setTermRenderer, useTermRenderer } from "./renderer";
import { registerLiveTerm } from "./useLocalhostUrls";

/** Imperative control of a mounted `TerminalPane` (toolbars, palette commands). */
export interface TerminalHandle {
  /** Raw input bytes (ignored in observe mode or while detached). */
  send(data: string): void;
  focus(): void;
  fit(): void;
  reopen(takeover: boolean): void;
  readonly termId: string | null;
}

export interface TerminalPaneProps {
  hostId: string;
  target: TermTarget;
  /** `control` resizes the pane and owns input; `observe` is read-only and crops. */
  mode?: TermMode;
  /** Board tiles: tiny font, no chrome, no input. */
  compact?: boolean;
  /** Evict another client's input lease on the first open. */
  takeover?: boolean;
  autoFocus?: boolean;
  className?: string;
  onOpened?: (opened: TermOpened | null) => void;
  /** Phase changes (TerminalView renders its header state from this). */
  onPhase?: (phase: TermPhase) => void;
  handleRef?: Ref<TerminalHandle>;
  /**
   * Lets the pane switch modes itself: the busy/taken-over banner offers "Watch" (→ observe) and the
   * observe ribbon offers "Take control" (→ control). Omit to hide those actions.
   */
  onModeChange?: (mode: TermMode) => void;
}

const NO_MODS: ModState = { ctrl: 0, alt: 0 };
const RESIZE_DEBOUNCE_MS = 70;
const FLASH_MIN_GAP_MS = 90;
const SWIPE_SLOP_PX = 8;
/** The status chip shows its label this long after a state change, then collapses to its orb. */
const CHIP_PEEK_MS = 2600;

/**
 * A real terminal attached to a herdr pane (or agent, or a new shell): xterm.js with the WebGL
 * renderer, frames from `termBus`, input/resize/scroll back through hostd.
 */
export function TerminalPane({
  hostId,
  target,
  mode = "control",
  compact = false,
  takeover = false,
  autoFocus,
  className,
  onOpened,
  onPhase,
  handleRef,
  onModeChange,
}: TerminalPaneProps) {
  const targetKey = JSON.stringify(target);
  const interactive = mode === "control" && !compact;
  const coarse = useMediaQuery("(pointer: coarse)");
  const isMobile = useIsMobile();
  const mobileRef = useRef(isMobile);
  mobileRef.current = isMobile;
  // Phone layout or a touch screen: extra-keys row and soft-keyboard handling.
  const touchUi = isMobile || coarse;
  const renderer = useTermRenderer();
  const terminalFontSize = useSettings((s) => s.terminalFontSize);
  const conn = useHosts((h) => h.status[hostId]);
  // Unknown status (e.g. a profile not loaded yet) is treated as reachable; term.open reports errors.
  const hostOnline = conn ? conn.phase === "online" : true;

  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TermSession | null>(null);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<TermPhase>({ k: "idle" });
  const [gotFrame, setGotFrame] = useState(false);
  const [beat, setBeat] = useState(0);
  const [mods, setMods] = useState<ModState>(NO_MODS);
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const [pinchFont, setPinchFont] = useState<number | null>(null);
  const [badge, setBadge] = useState<{ text: string; n: number } | null>(null);
  const [focused, setFocused] = useState(false);
  const [previewTunnel, setPreviewTunnel] = useState<TunnelInfo | null>(null);
  const { tier } = useActivity(beat);

  const savedFont = clampFontSize(terminalFontSize || DEFAULT_FONT_SIZE);
  const fontSize = compact ? COMPACT_FONT_SIZE : (pinchFont ?? savedFont);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  const cbRef = useRef({ onOpened, onPhase, takeover, hostOnline });
  cbRef.current = { onOpened, onPhase, takeover, hostOnline };

  const showBadge = useCallback((text: string) => setBadge((b) => ({ text, n: (b?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!badge) return;
    const t = window.setTimeout(() => setBadge(null), 1100);
    return () => clearTimeout(t);
  }, [badge]);

  const setFont = useCallback(
    (px: number) => {
      const next = clampFontSize(px);
      showBadge(`${next}px`);
      void useSettings.getState().update({ terminalFontSize: next });
    },
    [showBadge],
  );

  /* ---------- xterm instance ---------- */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let disposed = false;
    const term = new Terminal({
      scrollback: 0, // herdr re-renders the viewport; history comes from term.scroll
      fontFamily: TERM_FONT_FAMILY,
      fontSize: fontSizeRef.current,
      lineHeight: 1.12,
      theme: termTheme,
      cursorBlink: interactive,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      disableStdin: !interactive,
      allowProposedApi: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      // OSC 8 hyperlinks are program-controlled: http(s) only, opened outside the webview.
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (e, uri) => {
          e.preventDefault();
          openLink(uri);
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    void document.fonts
      .load(`${fontSizeRef.current}px "JetBrains Mono Variable"`)
      .catch(() => [])
      .then(() => {
        if (disposed) return;
        term.open(el);
        fit.fit();
        setReady(true);
      });

    return () => {
      disposed = true;
      setReady(false);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, [interactive, compact]);

  /* ---------- renderer: WebGL unless the user opted out (board tiles stay on DOM: browsers cap live WebGL contexts) ---------- */
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || compact || renderer !== "webgl") return;
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // Falls back to the DOM renderer until the pane remounts.
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      // No WebGL2: xterm's DOM renderer stays active.
      webgl = null;
    }
    return () => {
      try {
        webgl?.dispose();
      } catch {
        // already disposed together with the terminal
      }
    };
  }, [ready, compact, renderer]);

  /* ---------- localhost links → preview tunnels ---------- */
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || compact) return;
    const openPreview = async (port: number) => {
      haptic("select");
      const tunnel = await openTunnel(hostId, port);
      if (!tunnel) return;
      if (mobileRef.current) setPreviewTunnel(tunnel);
      else openExternal(tunnel);
    };
    const sub = term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        const found = line ? localhostUrlRanges(line.translateToString(true)) : [];
        if (!line || found.length === 0) return callback(undefined);
        // String offset → cell column: wide glyphs span two cells (the second one is empty).
        const col: number[] = [];
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || " ";
          for (let i = 0; i < chars.length; i++) col.push(x);
        }
        callback(
          found.map((u) => ({
            range: { start: { x: (col[u.start] ?? u.start) + 1, y }, end: { x: (col[u.end - 1] ?? u.end - 1) + 1, y } },
            text: u.url,
            decorations: { pointerCursor: true, underline: true },
            activate: (e: MouseEvent) => {
              e.preventDefault();
              void openPreview(u.port);
            },
          })),
        );
      },
    });
    return () => sub.dispose();
  }, [ready, compact, hostId]);

  /* ---------- observe-mode scaling ---------- */
  const applyObserveScale = useCallback(() => {
    const frame = frameRef.current;
    const inner = hostRef.current;
    const screen = inner?.querySelector<HTMLElement>(".xterm-screen");
    if (!frame || !screen || !inner) return;
    if (mode !== "observe") {
      inner.style.transform = "";
      return;
    }
    const s = Math.min(frame.clientWidth / Math.max(1, screen.offsetWidth), frame.clientHeight / Math.max(1, screen.offsetHeight), compact ? 1.6 : 1);
    inner.style.transform = s < 0.999 || s > 1.001 ? `scale(${s})` : "";
  }, [mode, compact]);

  /* ---------- session (open / frames / close) ---------- */
  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    term.reset();
    setGotFrame(false);
    let frames = 0;
    let lastFlash = 0;
    let beatTimer: number | undefined;
    let prev: TermPhase = { k: "idle" };
    let unregister: (() => void) | null = null;
    const parsedTarget: TermTarget = JSON.parse(targetKey);
    const session = new TermSession({
      hostId,
      target: parsedTarget,
      mode,
      term,
      onPhase: (p) => {
        setPhase(p);
        cbRef.current.onPhase?.(p);
        const wasLive = prev.k === "live" ? prev.termId : null;
        const nowLive = p.k === "live" ? p.termId : null;
        prev = p;
        if (wasLive === nowLive) return;
        unregister?.();
        unregister = null;
        if (p.k === "live") {
          unregister = registerLiveTerm(hostId, p.termId, term);
          cbRef.current.onOpened?.({ termId: p.termId, paneId: p.paneId, title: p.title });
        } else cbRef.current.onOpened?.(null);
      },
      onFrame: (ev) => {
        frames++;
        if (frames === 1) setGotFrame(true);
        beatTimer ??= window.setTimeout(() => {
          beatTimer = undefined;
          setBeat(frames);
        }, 250);
        // Observe mode: frames are authoritative for size; scale the grid to fit the tile.
        if (mode === "observe" && (ev.cols !== term.cols || ev.rows !== term.rows) && ev.cols > 0 && ev.rows > 0) {
          term.resize(ev.cols, ev.rows);
          requestAnimationFrame(applyObserveScale);
        }
        const now = performance.now();
        // Frame flash: a light sweep along the top edge per repaint (skipped with reduced motion).
        if (now - lastFlash > FLASH_MIN_GAP_MS && flashRef.current && document.documentElement.dataset.motion !== "reduced") {
          lastFlash = now;
          flashRef.current.animate(
            [
              { opacity: 0.95, transform: "scaleX(0.35)" },
              { opacity: 0, transform: "scaleX(1)" },
            ],
            { duration: 650, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
          );
        }
      },
    });
    sessionRef.current = session;
    if (cbRef.current.hostOnline) void session.open(cbRef.current.takeover);

    const dataSub = term.onData((data) => {
      const m = modsRef.current;
      if (m.ctrl || m.alt) {
        session.input(applyMods(data, { ctrl: m.ctrl > 0, alt: m.alt > 0 }));
        setMods((cur) => ({ ctrl: cur.ctrl === 1 ? 0 : cur.ctrl, alt: cur.alt === 1 ? 0 : cur.alt }));
        return;
      }
      session.input(data);
    });
    const binSub = term.onBinary((data) => session.input(data));
    let resizeTimer: number | undefined;
    const resizeSub = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => session.resize(cols, rows), RESIZE_DEBOUNCE_MS);
    });

    return () => {
      clearTimeout(beatTimer);
      clearTimeout(resizeTimer);
      dataSub.dispose();
      binSub.dispose();
      resizeSub.dispose();
      unregister?.();
      if (prev.k === "live") cbRef.current.onOpened?.(null);
      session.dispose();
      sessionRef.current = null;
      setPhase({ k: "idle" });
    };
  }, [ready, hostId, targetKey, mode, applyObserveScale]);

  /* ---------- host reconnect ---------- */
  const prevOnline = useRef(hostOnline);
  useEffect(() => {
    const was = prevOnline.current;
    prevOnline.current = hostOnline;
    const s = sessionRef.current;
    if (!s || was === hostOnline) return;
    if (!hostOnline) {
      s.hostLost();
      return;
    }
    const p = s.phase;
    // Don't fight a client that explicitly took the terminal from us.
    if ((p.k === "closed" && p.takenOver) || (p.k === "error" && p.error.code === "busy")) return;
    // We held the lease before the drop (a `closed` here is the drop itself, e.g. "connection lost"):
    // reclaim it, in case hostd still holds the stale attachment.
    void s.open(mode === "control" && (p.k === "live" || p.k === "opening" || p.k === "closed"));
  }, [hostOnline, mode]);

  /* ---------- sizing ---------- */
  const observeReopen = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(observeReopen.current), []);
  const refit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !term.element) return;
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const cols = Math.max(2, dims.cols);
    const rows = Math.max(1, dims.rows);
    const s = sessionRef.current;
    if (mode === "observe" && s?.openedSize && s.phase.k === "live") {
      // Observers can't resize; their crop is fixed at open. Re-attach at the new size once it settles.
      clearTimeout(observeReopen.current);
      if (cols !== s.openedSize.cols || rows !== s.openedSize.rows) {
        observeReopen.current = window.setTimeout(() => {
          term.resize(cols, rows);
          void s.open(false);
        }, 450);
      }
    } else if (cols !== term.cols || rows !== term.rows) {
      term.resize(cols, rows);
      if (!compact) showBadge(`${cols}×${rows}`);
    }
    requestAnimationFrame(applyObserveScale);
  }, [mode, compact, showBadge, applyObserveScale]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!ready || !frame) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refit);
    });
    ro.observe(frame);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ready, refit]);

  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    refit();
  }, [ready, fontSize, refit]);

  /* ---------- keyboard, wheel, clipboard ---------- */
  const copySelection = useCallback(async () => {
    const term = termRef.current;
    const text = term?.getSelection() ?? "";
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: `${text.length} characters`, duration: 1600 });
    } catch {
      toast({ title: "Copy failed", description: "Clipboard access was denied.", status: "error" });
    }
    term?.clearSelection();
    return true;
  }, []);

  const paste = useCallback(async () => {
    const term = termRef.current;
    if (!term || !interactive) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      toast({ title: "Paste unavailable", description: "Allow clipboard access, or use Ctrl+V.", status: "error" });
    }
    term.focus();
  }, [interactive]);

  const scrollQueue = useRef({ lines: 0, raf: 0 });
  const queueScroll = useCallback((lines: number) => {
    const q = scrollQueue.current;
    q.lines += lines;
    if (q.raf) return;
    q.raf = requestAnimationFrame(() => {
      q.raf = 0;
      const n = q.lines;
      q.lines = 0;
      if (n !== 0) sessionRef.current?.scroll(n < 0 ? "up" : "down", Math.abs(n));
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(scrollQueue.current.raf), []);

  const cellHeight = useCallback(() => {
    const term = termRef.current;
    const screen = hostRef.current?.querySelector<HTMLElement>(".xterm-screen");
    if (term && screen && term.rows > 0 && screen.offsetHeight > 0) return screen.offsetHeight / term.rows;
    return fontSizeRef.current * 1.3;
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!ready || !term) return;
    let acc = 0;
    term.attachCustomWheelEventHandler((e) => {
      if (e.ctrlKey && !compact) {
        e.preventDefault();
        acc = 0;
        setFont(fontSizeRef.current + (e.deltaY < 0 ? 1 : -1));
        return false;
      }
      const ch = cellHeight();
      acc += e.deltaMode === 1 ? e.deltaY * ch : e.deltaMode === 2 ? e.deltaY * term.rows * ch : e.deltaY;
      const lines = Math.trunc(acc / ch);
      if (lines !== 0) {
        acc -= lines * ch;
        queueScroll(lines);
      }
      e.preventDefault();
      return false;
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && k === "c" && (e.shiftKey || term.hasSelection())) {
        e.preventDefault();
        void copySelection();
        return false;
      }
      // Ctrl+V / Ctrl+Shift+V: let the browser fire `paste` on xterm's textarea (bracketed paste aware).
      if (ctrl && k === "v") return false;
      if (ctrl && !e.shiftKey && !e.altKey && (k === "=" || k === "+" || k === "-" || k === "0") && !compact) {
        e.preventDefault();
        setFont(k === "0" ? DEFAULT_FONT_SIZE : fontSizeRef.current + (k === "-" ? -1 : 1));
        return false;
      }
      // App shortcuts that must stay reachable from inside the terminal (palette, views).
      if (ctrl && (k === "k" || /^[1-6]$/.test(k))) return false;
      if (ctrl && e.shiftKey) return false;
      if ((e.key === "PageUp" || e.key === "PageDown") && !ctrl && !e.altKey) {
        e.preventDefault();
        queueScroll((e.key === "PageUp" ? -1 : 1) * Math.max(1, term.rows - 1));
        return false;
      }
      e.stopPropagation();
      return true;
    });
  }, [ready, compact, setFont, copySelection, queueScroll, cellHeight]);

  /* ---------- touch: swipe to scroll, pinch to zoom ---------- */
  useEffect(() => {
    const el = frameRef.current;
    if (!ready || !el || compact) return;
    let mode2: "none" | "swipe" | "pinch" | "pending" = "none";
    let startY = 0;
    let startX = 0;
    let lastY = 0;
    let acc = 0;
    let d0 = 0;
    let font0 = 0;
    let lastFont = 0;
    const dist = (t: TouchList) => {
      const a = t[0];
      const b = t[1];
      return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        mode2 = "pinch";
        d0 = dist(e.touches);
        font0 = fontSizeRef.current;
        lastFont = font0;
        return;
      }
      if (e.touches.length === 1 && e.touches[0]) {
        mode2 = "pending";
        startY = lastY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        acc = 0;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (mode2 === "pinch" && e.touches.length === 2 && d0 > 0) {
        e.preventDefault();
        const next = clampFontSize(font0 * (dist(e.touches) / d0));
        if (next !== lastFont) {
          if (Math.floor(next) !== Math.floor(lastFont)) haptic("tick");
          lastFont = next;
          setPinchFont(next);
          showBadge(`${next}px`);
        }
        return;
      }
      const t = e.touches[0];
      if (!t || e.touches.length !== 1) return;
      if (mode2 === "pending") {
        const dy = t.clientY - startY;
        const dx = t.clientX - startX;
        if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) > Math.abs(dx)) mode2 = "swipe";
        else if (Math.abs(dx) > SWIPE_SLOP_PX) mode2 = "none";
      }
      if (mode2 !== "swipe") return;
      e.preventDefault();
      const ch = cellHeight();
      acc += t.clientY - lastY;
      lastY = t.clientY;
      const lines = Math.trunc(acc / ch);
      if (lines !== 0) {
        acc -= lines * ch;
        // Finger down reveals earlier output (natural scrolling).
        queueScroll(-lines);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (mode2 === "pinch" && e.touches.length < 2) {
        if (lastFont && lastFont !== font0) {
          void useSettings.getState().update({ terminalFontSize: lastFont }).finally(() => setPinchFont(null));
        } else setPinchFont(null);
        mode2 = "none";
      } else if (e.touches.length === 0) mode2 = "none";
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ready, compact, queueScroll, cellHeight, showBadge]);

  /* ---------- soft keyboard (visualViewport) ---------- */
  useEffect(() => {
    const wrap = wrapRef.current;
    const vv = window.visualViewport;
    if (!wrap || !vv || compact || !touchUi) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const rect = wrap.getBoundingClientRect();
      const overlap = Math.max(0, Math.round(rect.bottom - (vv.offsetTop + vv.height)));
      wrap.style.paddingBottom = overlap > 0 ? `${overlap}px` : "";
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    schedule();
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      cancelAnimationFrame(raf);
      wrap.style.paddingBottom = "";
    };
  }, [compact, touchUi]);

  /* ---------- focus ---------- */
  const shouldFocus = autoFocus ?? interactive;
  useEffect(() => {
    if (ready && shouldFocus && phase.k === "live" && !coarse) termRef.current?.focus();
  }, [ready, shouldFocus, phase.k, coarse]);

  /* ---------- extra keys ---------- */
  const onExtraKey = useCallback((k: ExtraKey) => {
    const s = sessionRef.current;
    if (!s) return;
    const m = modsRef.current;
    const latched = { ctrl: m.ctrl > 0, alt: m.alt > 0 };
    s.input(k.kind === "named" ? encodeKey(k.key, latched) : applyMods(k.ch, latched));
    if (m.ctrl === 1 || m.alt === 1) setMods((cur) => ({ ctrl: cur.ctrl === 1 ? 0 : cur.ctrl, alt: cur.alt === 1 ? 0 : cur.alt }));
  }, []);
  const onSetMod = useCallback((mod: keyof ModState, latch: ModLatch) => setMods((cur) => ({ ...cur, [mod]: latch })), []);

  /* ---------- handle ---------- */
  const reopen = useCallback((tk: boolean) => {
    void sessionRef.current?.open(tk);
  }, []);
  useImperativeHandle(
    handleRef,
    () => ({
      send: (data) => sessionRef.current?.input(data),
      focus: () => termRef.current?.focus(),
      fit: refit,
      reopen,
      get termId() {
        return sessionRef.current?.currentTermId ?? null;
      },
    }),
    [refit, reopen],
  );

  const offline = !hostOnline;
  const live = phase.k === "live" && hostOnline;
  const dim = offline || phase.k === "closed" || phase.k === "error";
  const showExtraKeys = interactive && touchUi;
  const busy = phase.k === "error" && phase.error.code === "busy";
  const chip: { status: Status; label: string } = offline
    ? { status: "idle", label: conn ? PHASE_LABEL[conn.phase] : "Reconnecting" }
    : phase.k === "live"
      ? { status: mode === "observe" ? "review" : "running", label: mode === "observe" ? "Observing" : "Live" }
      : phase.k === "opening"
        ? { status: "running", label: phase.takeover ? "Taking over" : "Attaching" }
        : phase.k === "closed"
          ? { status: phase.takenOver ? "needs-you" : "idle", label: closedCopy(phase.reason, phase.takenOver).title }
          : phase.k === "error"
            ? { status: busy ? "needs-you" : "error", label: busy ? "In use" : "Error" }
            : { status: "idle", label: "Idle" };

  // While live the chip collapses to its orb so it never covers output; it re-expands on every
  // state change (and on hover) so transitions are still announced.
  const [peek, setPeek] = useState(true);
  useEffect(() => {
    setPeek(true);
    const t = window.setTimeout(() => setPeek(false), CHIP_PEEK_MS);
    return () => clearTimeout(t);
  }, [chip.label]);
  const chipOpen = !live || peek;

  const frameStyle = useMemo<CSSProperties>(() => ({ backgroundColor: termTheme.background }), []);

  const body = (
    <div
      ref={frameRef}
      className={cn("relative min-h-0 flex-1 overflow-hidden", compact ? "p-1" : "px-2.5 pt-2 pb-1")}
      style={frameStyle}
      onClick={() => interactive && termRef.current?.focus()}
    >
      <div
        ref={hostRef}
        className={cn(
          "absolute origin-top-left transition-[filter,opacity] duration-500",
          compact ? "inset-1" : "inset-x-2.5 top-2 bottom-1",
          dim && "opacity-60 saturate-[0.15]",
        )}
      />
      {/* frame flash: every repaint sweeps a gradient line across the top edge */}
      <div
        ref={flashRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-[2px] origin-center opacity-0",
          mode === "observe"
            ? "bg-[linear-gradient(90deg,transparent,var(--color-review),transparent)] shadow-[0_0_14px_rgb(34_211_238/0.8)]"
            : "bg-omp shadow-[0_0_14px_rgb(163_92_240/0.9)]",
        )}
      />
      <PaneOverlay
        phase={phase}
        compact={compact}
        mode={mode}
        offline={offline}
        conn={conn}
        gotFrame={gotFrame}
        onReattach={() => reopen(false)}
        onTakeover={() => reopen(true)}
        onObserve={
          onModeChange
            ? () => {
                haptic("select");
                onModeChange("observe");
              }
            : undefined
        }
      />
      {!compact && (
        <div className="pointer-events-none absolute top-2 right-3 flex items-center gap-1.5">
          <AnimatePresence>
            {badge && (
              <motion.span
                key={badge.n}
                initial={{ opacity: 0, y: -4, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={spring.snappy}
                className="rounded-full bg-[rgb(38_36_50/0.9)] px-2 py-0.5 font-mono text-2xs font-bold text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] backdrop-blur"
              >
                {badge.text}
              </motion.span>
            )}
          </AnimatePresence>
          <span
            className={cn(
              "flex items-center rounded-full bg-[rgb(20_20_28/0.82)] py-[5px] pr-[5px] pl-[5px] text-2xs font-extrabold tracking-wide uppercase shadow-[inset_0_0_0_1px_var(--color-line-2)] backdrop-blur transition-colors",
              live ? (mode === "observe" ? "text-review" : "text-accent-ink") : "text-mute",
            )}
            aria-live="polite"
          >
            <StatusOrb status={chip.status} activity={live ? tier : "silent"} size={7} label={null} />
            <span
              className={cn(
                "grid transition-[grid-template-columns,opacity] duration-300 ease-out",
                chipOpen ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0 group-hover/term:grid-cols-[1fr] group-hover/term:opacity-100",
              )}
            >
              <span className="min-w-0 overflow-hidden">
                <span className="block pr-1 pl-1.5 leading-none whitespace-nowrap">{chip.label}</span>
              </span>
            </span>
          </span>
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={wrapRef}
      data-tf-terminal=""
      data-mode={mode}
      className={cn("tf-terminal group/term relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[inherit]", className)}
      style={frameStyle}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {compact ? (
        body
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem icon={<ClipboardCopy />} shortcut="Ctrl Shift C" onSelect={() => void copySelection()}>
              Copy
            </ContextMenuItem>
            <ContextMenuItem icon={<ClipboardPaste />} shortcut="Ctrl V" disabled={!interactive} onSelect={() => void paste()}>
              Paste
            </ContextMenuItem>
            <ContextMenuItem icon={<SquareMousePointer />} onSelect={() => termRef.current?.selectAll()}>
              Select all
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem icon={<Plus />} shortcut="Ctrl +" onSelect={() => setFont(fontSize + 1)}>
              Larger text
            </ContextMenuItem>
            <ContextMenuItem icon={<Minus />} shortcut="Ctrl -" onSelect={() => setFont(fontSize - 1)}>
              Smaller text
            </ContextMenuItem>
            <ContextMenuItem icon={<ScanLine />} shortcut="Ctrl 0" onSelect={() => setFont(DEFAULT_FONT_SIZE)}>
              Reset text size
            </ContextMenuItem>
            <ContextMenuItem
              icon={<Cpu />}
              onSelect={() => setTermRenderer(renderer === "webgl" ? "dom" : "webgl")}
            >
              {renderer === "webgl" ? "Use compatibility renderer" : "Use GPU renderer"}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem icon={<RotateCcw />} onSelect={() => reopen(false)}>
              Reattach
            </ContextMenuItem>
            {mode === "control" && (
              <ContextMenuItem icon={<Zap />} onSelect={() => reopen(true)}>
                Take over
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
      )}
      {mode === "observe" && !compact && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-[rgb(34_211_238/0.22)] bg-[linear-gradient(90deg,rgb(34_211_238/0.14),rgb(34_211_238/0.03)_70%)] py-1.5 pr-1.5 pl-3 text-xs"
        >
          <Eye className="size-3.5 shrink-0 text-review" aria-hidden />
          <span className="shrink-0 font-extrabold text-review">Read-only</span>
          <span className="min-w-0 truncate text-mute">
            {isMobile ? "watching, no input" : "watching at the driver's size · keys and resizes stay with them"}
          </span>
          {onModeChange ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Keyboard />}
              className="ml-auto shrink-0"
              onClick={() => {
                haptic("select");
                onModeChange("control");
              }}
            >
              Take control
            </Button>
          ) : (
            <span className="h-8" aria-hidden />
          )}
        </div>
      )}
      {showExtraKeys && (
        <ExtraKeys
          mods={mods}
          onKey={onExtraKey}
          onSetMod={onSetMod}
          onPaste={() => void paste()}
          className={cn(
            "shrink-0 border-t border-line bg-[linear-gradient(180deg,var(--color-tile-1),var(--color-chrome))] transition-opacity duration-300",
            !live && "pointer-events-none opacity-45",
          )}
        />
      )}
      {/* keyboard focus: typing goes to this pane */}
      {interactive && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 z-raised rounded-[inherit] shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.75),inset_0_0_28px_-10px_rgb(163_92_240/0.55)] transition-opacity duration-300",
            focused && live ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {isMobile && !compact && <PreviewSheet tunnel={previewTunnel} onClose={() => setPreviewTunnel(null)} />}
    </div>
  );
}
