import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { AnimatePresence, motion } from "motion/react";
import { ClipboardCopy, ClipboardPaste, Cpu, Search, Eye, ImageUp, Keyboard, Minus, Plus, RotateCcw, ScanLine, SquareMousePointer, Zap } from "lucide-react";
import { type CSSProperties, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { draftKey, openLink, useHosts, useSettings } from "@/core";
import { dragHasFiles, mediaFiles } from "@/core/clipboardImages";
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
import { useHerdrHealth, useHostName } from "@/features/hosts/HerdrControls";
import { herdrDown } from "@/features/hosts/herdrHealth";
import { haptic } from "@/features/shell/haptics";
import { PHASE_LABEL } from "@/features/shell/status";
import { localhostUrlRanges } from "./frames";
import { pastePathsInput, pastedMedia, pasteTextInput, pathsText, readClipboard } from "./mediaPaste";
import { ExtraKeys, type ExtraKey, type ModLatch, type ModState } from "./ExtraKeys";
import { applyMods, encodeKey } from "./keys";
import { observeTransform } from "./observeScale";
import { PaneOverlay, closedCopy } from "./PaneOverlay";
import { type TermPhase, TermSession } from "./session";
import { COMPACT_FONT_SIZE, DEFAULT_FONT_SIZE, TERM_FONT_FAMILY, clampFontSize, isTermFontFace, loadTermFonts, termTheme } from "./theme";
import { setTermRenderer, useTermRenderer } from "./renderer";
import { SearchBar } from "./SearchBar";
import { TermUploads } from "./termUploads";
import { UploadPill } from "./UploadPill";
import { registerLiveTerm } from "./useLocalhostUrls";

/** Imperative control of a mounted `TerminalPane` (toolbars, palette commands). */
export interface TerminalHandle {
  /** Raw input bytes (ignored in observe mode or while detached). */
  send(data: string): void;
  focus(): void;
  fit(): void;
  reopen(takeover: boolean): void;
  /** Open the Ctrl+F search bar (no-op for compact tiles). */
  openSearch(): void;
  readonly termId: string | null;
}

export interface TerminalPaneProps {
  hostId: string;
  target: TermTarget;
  /** `control` resizes the pane and owns input; `observe` is read-only and shows the driver's grid, scaled to the box. */
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
/** How long an empty first screen keeps the "Attaching…" overlay before it is taken at face value. */
const BLANK_GRACE_MS = 2500;
const SWIPE_SLOP_PX = 8;
/** Longest the first paint waits for the terminal fonts (it re-measures when they land later). */
const FONT_WAIT_MS = 120;
/**
 * Smallest grid a pane's box can mean. Less is the box collapsing, not a layout: a closing split
 * squeezes its terminal to zero width for the exit animation. Applying that would resize the real
 * PTY, and herdr keeps the size after we let go, so the agent would re-wrap at 2 columns for every
 * later viewer (the board's live tile shows the pane at its driver's size).
 */
const MIN_COLS = 10;
const MIN_ROWS = 2;

/** The fit addon's grid for the current box; `null` while the box is collapsed or unmeasurable. */
function proposeGrid(fit: FitAddon): { cols: number; rows: number } | null {
  const dims = fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return null;
  return dims.cols >= MIN_COLS && dims.rows >= MIN_ROWS ? dims : null;
}

/** Set once WebGL proved to draw nothing on this device; later panes go straight to the DOM renderer. */
let webglBroken = false;

/**
 * Does the WebGL canvas show any glyph pixels? `null` while the screen has no text yet (nothing to
 * judge). Runs inside xterm's render callback, before the drawing buffer is cleared.
 */
function webglHasInk(term: Terminal): boolean | null {
  const buf = term.buffer.active;
  let hasText = false;
  for (let y = 0; y < term.rows && !hasText; y++) hasText = (buf.getLine(buf.viewportY + y)?.translateToString(true).trim().length ?? 0) > 0;
  if (!hasText) return null;
  const canvases = [...(term.element?.querySelectorAll<HTMLCanvasElement>("canvas:not(.xterm-link-layer)") ?? [])];
  const gl = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!gl || gl.width === 0 || gl.height === 0) return null;
  const probe = document.createElement("canvas");
  probe.width = gl.width;
  probe.height = gl.height;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(gl, 0, 0);
  const px = ctx.getImageData(0, 0, probe.width, probe.height).data;
  // Any reasonably bright pixel is ink (the theme background is near-black).
  for (let i = 0; i < px.length; i += 16) if ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0) > 180) return true;
  return false;
}
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
  const herdr = useHerdrHealth(hostId);
  const hostName = useHostName(hostId);

  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const sessionRef = useRef<TermSession | null>(null);
  const [inst, setInst] = useState<Terminal | null>(null);
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
  // Files dragged over a control terminal (drop overlay).
  const [dragging, setDragging] = useState(false);
  const [uploads] = useState(() => new TermUploads());
  const pickRef = useRef<HTMLInputElement>(null);
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
      allowProposedApi: true, // search match decorations
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      // WebGL: squeeze fallback-font symbols wider than a cell (Nerd Font icons and emoji are exempt).
      rescaleOverlappingGlyphs: true,
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
    const search = new SearchAddon({ highlightLimit: 500 });
    term.loadAddon(search);
    searchRef.current = search;
    termRef.current = term;
    fitRef.current = fit;

    // Wait briefly for the fonts so the first cell measurement is right, but never hold the first
    // paint on them: a slow font fetch must not delay the terminal by seconds.
    const fontLoad = loadTermFonts();
    // Late font (any Fira Code subset or the icon font): re-measure cells (a changed family string
    // forces xterm to), drop glyphs the WebGL atlas rasterized with a fallback font (tofu) and re-fit.
    const onFontsLoaded = (e: FontFaceSetLoadEvent) => {
      if (disposed || !term.element || !e.fontfaces.some(isTermFontFace)) return;
      term.options.fontFamily = term.options.fontFamily === TERM_FONT_FAMILY ? `${TERM_FONT_FAMILY} ` : TERM_FONT_FAMILY;
      term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
      refitRef.current();
    };
    document.fonts.addEventListener("loadingdone", onFontsLoaded);
    // (Promise.withResolvers is ES2024; the Windows webview target is chrome105.)
    let fontTimer: number | undefined;
    const fontWait = new Promise<void>((resolve) => {
      fontTimer = window.setTimeout(resolve, FONT_WAIT_MS);
    });
    void Promise.race([fontLoad, fontWait]).then(() => {
      clearTimeout(fontTimer);
      if (disposed) return;
      term.open(el);
      const grid = proposeGrid(fit);
      if (grid) term.resize(grid.cols, grid.rows);
      setInst(term);
    });

    return () => {
      disposed = true;
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
      // Release the attachment before its terminal goes away (the session effect only re-runs
      // once the new instance is published).
      sessionRef.current?.dispose();
      setInst(null);
      setSearchOpen(false);
      searchRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // A fresh xterm per attachment (target / mode / host): retargeting a live instance with
    // `reset()` left the WebGL renderer drawing nothing for the new pane.
  }, [interactive, compact, hostId, targetKey, mode]);

  /* ---------- renderer: WebGL unless the user opted out (board tiles stay on DOM: browsers cap live WebGL contexts) ---------- */
  useEffect(() => {
    const term = termRef.current;
    if (!inst || !term || compact || renderer !== "webgl" || webglBroken) return;
    let webgl: WebglAddon | null = null;
    let canvas: HTMLCanvasElement | undefined;
    const drop = () => {
      try {
        webgl?.dispose();
      } catch {
        // already disposed together with the terminal
      }
      webgl = null;
      // Hand the GPU context back now instead of whenever the canvas is collected: browsers cap live
      // contexts (~16) and drop the oldest, and a terminal opened again soon must not hit that cap.
      canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas = undefined;
    };
    try {
      const before = new Set(term.element?.querySelectorAll("canvas"));
      webgl = new WebglAddon();
      // Falls back to the DOM renderer until the pane remounts.
      webgl.onContextLoss(drop);
      term.loadAddon(webgl);
      canvas = [...(term.element?.querySelectorAll("canvas") ?? [])].find((c) => !before.has(c));
    } catch {
      // No WebGL2: xterm's DOM renderer stays active.
      webgl = null;
    }
    // Some GPUs/drivers (and headless Chromium) accept WebGL2 but draw nothing. Once the first
    // non-empty screen is rendered, check the canvas has ink; if not, fall back to the DOM renderer
    // for the rest of this app session.
    let checked = !webgl;
    const renderSub = term.onRender(() => {
      if (checked || !webgl) return;
      const verdict = webglHasInk(term);
      if (verdict === null) return;
      checked = true;
      if (!verdict) {
        webglBroken = true;
        drop();
        term.refresh(0, term.rows - 1);
      }
    });
    return () => {
      renderSub.dispose();
      drop();
    };
  }, [inst, compact, renderer]);

  /* ---------- localhost links → preview tunnels ---------- */
  useEffect(() => {
    const term = termRef.current;
    if (!inst || !term || compact) return;
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
  }, [inst, compact, hostId]);

  /* ---------- observe-mode scaling ---------- */
  // An observer's grid is the driver's (frames set it): scale it uniformly to the box. Board tiles
  // fill their width at any window size and keep the bottom rows; full views show the whole grid,
  // shrunk when it is bigger than the view, centred when smaller.
  const applyObserveScale = useCallback(() => {
    const inner = hostRef.current;
    const screen = inner?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !inner) return;
    if (mode !== "observe") {
      inner.style.transform = "";
      return;
    }
    inner.style.transform = observeTransform(
      { width: inner.clientWidth, height: inner.clientHeight },
      { width: screen.offsetWidth, height: screen.offsetHeight },
      compact ? Number.POSITIVE_INFINITY : 1,
      compact ? "tail" : "contain",
    );
  }, [mode, compact]);

  /* ---------- session (open / frames / close) ---------- */
  // Keyed on the instance only: every target/mode/host change creates a new instance first.
  useEffect(() => {
    const term = inst;
    if (!term) return;
    setGotFrame(false);
    let frames = 0;
    // A first frame can be an empty screen with the output still on its way: keep "Attaching…" up
    // until something is drawn, or BLANK_GRACE_MS has passed (a screen that really is empty).
    let shown = false;
    let blankTimer: number | undefined;
    const reveal = () => {
      if (shown) return;
      shown = true;
      clearTimeout(blankTimer);
      setGotFrame(true);
    };
    const screenHasText = () => {
      const buf = term.buffer.active;
      for (let y = 0; y < term.rows; y++) if (buf.getLine(buf.viewportY + y)?.translateToString(true).trim()) return true;
      return false;
    };
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
      onFrame: () => {
        frames++;
        if (!shown) {
          blankTimer ??= window.setTimeout(reveal, BLANK_GRACE_MS);
          // the frame is parsed asynchronously: look once it has been drawn
          requestAnimationFrame(() => {
            if (screenHasText()) reveal();
          });
        }
        beatTimer ??= window.setTimeout(() => {
          beatTimer = undefined;
          setBeat(frames);
        }, 250);
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
      clearTimeout(blankTimer);
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
  }, [inst]);

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

  /* ---------- herdr back up ---------- */
  // A server instance answers again (restart, start after a crash, live handoff): attach again instead of waiting for Retry.
  const herdrEpoch = herdr?.state === "up" ? herdr.epoch : null;
  const prevEpoch = useRef(herdrEpoch);
  useEffect(() => {
    const was = prevEpoch.current;
    prevEpoch.current = herdrEpoch;
    const s = sessionRef.current;
    if (!s || herdrEpoch === null || was === herdrEpoch || !hostOnline) return;
    const p = s.phase;
    if ((p.k === "closed" && p.takenOver) || (p.k === "error" && p.error.code === "busy")) return;
    void s.open(mode === "control" && (p.k === "live" || p.k === "opening" || p.k === "closed"));
  }, [herdrEpoch, hostOnline, mode]);

  /* ---------- sizing ---------- */
  // Control: the box decides the grid (and so the pane's PTY). Observe: the driver's grid comes with
  // the frames and the box only rescales it, so a resize never reaches herdr.
  const refit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !term.element) return;
    if (mode === "control") {
      const grid = proposeGrid(fit);
      if (grid && (grid.cols !== term.cols || grid.rows !== term.rows)) {
        term.resize(grid.cols, grid.rows);
        if (!compact) showBadge(`${grid.cols}×${grid.rows}`);
      }
    }
    applyObserveScale();
  }, [mode, compact, showBadge, applyObserveScale]);
  const refitRef = useRef(refit);
  refitRef.current = refit;

  // The box (window, sidebar, split drag) and the drawn grid (new observer size, late font, DPR
  // change re-measuring the cells): either one changing re-fits once per animation frame.
  useEffect(() => {
    const frame = frameRef.current;
    const screen = hostRef.current?.querySelector<HTMLElement>(".xterm-screen");
    if (!inst || !frame) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refit);
    });
    ro.observe(frame);
    if (screen) ro.observe(screen);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [inst, refit]);

  useEffect(() => {
    const term = termRef.current;
    if (!inst || !term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    refit();
  }, [inst, fontSize, refit]);

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

  /**
   * Images / videos pasted, dropped or picked: upload them to the host, then paste their host paths
   * into the pane (omp attaches them; a shell gets the path). Control mode only.
   */
  const sendMedia = useCallback(
    async (files: readonly Blob[]) => {
      const attached = () => {
        const s = sessionRef.current;
        return s !== null && s.phase.k === "live" && s.currentTermId !== null && cbRef.current.hostOnline;
      };
      if (!interactive) return;
      if (!attached()) {
        toast({ title: "Not attached", description: "Reattach the terminal, then try again.", status: "error" });
        return;
      }
      const res = await uploads.run(hostId, files);
      for (const s of res.skipped) toast({ title: `Not uploaded: ${s.name}`, description: s.reason, status: "error" });
      if (res.cancelled) return;
      if (res.paths.length > 0) {
        if (attached()) sessionRef.current?.input(pastePathsInput(res.paths));
        else {
          const text = pathsText(res.paths);
          toast({
            title: "Not pasted: the terminal detached",
            description: `The upload is on the host: ${text}`,
            status: "error",
            action: { label: "Copy path", onClick: () => void navigator.clipboard.writeText(text).catch(() => {}) },
          });
        }
      }
      if (res.failed) {
        const { name, error } = res.failed;
        toast({ title: `Couldn't upload ${name}`, description: error.hint ? `${error.message} ${error.hint}` : error.message, status: "error" });
      }
    },
    [interactive, hostId, uploads],
  );

  /** Clipboard text, as one bracketed paste so its line breaks stay text (`pasteTextInput`). */
  const sendText = useCallback(
    (text: string) => {
      if (interactive && text) sessionRef.current?.input(pasteTextInput(text));
    },
    [interactive],
  );

  const paste = useCallback(async () => {
    const term = termRef.current;
    if (!term || !interactive) return;
    try {
      const clip = await readClipboard();
      if (clip.media.length > 0) void sendMedia(clip.media);
      else if (clip.text) sendText(clip.text);
    } catch {
      toast({ title: "Paste unavailable", description: "Allow clipboard access, or use Ctrl+V.", status: "error" });
    }
    term.focus();
  }, [interactive, sendMedia, sendText]);

  // Ctrl+V / the webview's own Paste. Capture phase on an ancestor, so it runs before xterm's paste
  // listener: images or videos with no text are uploaded, text goes in as one bracketed paste.
  useEffect(() => {
    const wrap = wrapRef.current;
    const term = termRef.current;
    if (!inst || !wrap || !term || !interactive) return;
    const onPaste = (e: ClipboardEvent) => {
      if (!(e.target instanceof Node) || !term.element?.contains(e.target)) return;
      const files = pastedMedia(e.clipboardData);
      const text = files.length === 0 ? (e.clipboardData?.getData("text/plain") ?? "") : "";
      if (files.length === 0 && !text) return;
      e.preventDefault();
      e.stopPropagation();
      if (files.length > 0) void sendMedia(files);
      else sendText(text);
    };
    wrap.addEventListener("paste", onPaste, true);
    return () => wrap.removeEventListener("paste", onPaste, true);
  }, [inst, interactive, sendMedia, sendText]);
  // Another attachment (pane, mode, host) or unmount: drop what was on its way to this one.
  useEffect(() => () => uploads.cancel(), [uploads, inst]);

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
    if (!inst || !term) return;
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
      if (ctrl && !e.shiftKey && !e.altKey && k === "f" && !compact) {
        e.preventDefault();
        setSearchOpen(true);
        return false;
      }
      // Ctrl+V / Ctrl+Shift+V: let the browser fire `paste`; the capture listener above sends it.
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
  }, [inst, compact, setFont, copySelection, queueScroll, cellHeight]);

  /* ---------- touch: swipe to scroll, pinch to zoom ---------- */
  useEffect(() => {
    const el = frameRef.current;
    if (!inst || !el || compact) return;
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
  }, [inst, compact, queueScroll, cellHeight, showBadge]);

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
    if (inst && shouldFocus && phase.k === "live" && !coarse) termRef.current?.focus();
  }, [inst, shouldFocus, phase.k, coarse]);

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
      openSearch: () => !compact && setSearchOpen(true),
      get termId() {
        return sessionRef.current?.currentTermId ?? null;
      },
    }),
    [refit, reopen, compact],
  );

  const offline = !hostOnline;
  // herdr's server is not there: the pane is a stale screen (the overlay says why)
  const herdrOut = hostOnline && herdrDown(herdr) && !(herdr.state === "unresponsive" && phase.k === "live");
  const live = phase.k === "live" && hostOnline && !herdrOut;
  const dim = offline || herdrOut || phase.k === "closed" || phase.k === "error";
  const showExtraKeys = interactive && touchUi;
  const busy = phase.k === "error" && phase.error.code === "busy";
  const chip: { status: Status; label: string } = offline
    ? { status: "idle", label: conn ? PHASE_LABEL[conn.phase] : "Reconnecting" }
    : herdrOut
      ? { status: "error", label: "herdr down" }
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
      // Dropped images / videos: uploaded, then their host paths are pasted (control mode). Other
      // files are refused, and no drop ever navigates the webview to the file.
      onDragOver={(e) => {
        if (compact || !dragHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = interactive ? "copy" : "none";
        if (interactive) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (compact || (!dragHasFiles(e.dataTransfer) && e.dataTransfer.files.length === 0)) return;
        e.preventDefault();
        if (!interactive) return;
        const files = mediaFiles(e.dataTransfer);
        if (files.length === 0) {
          toast({ title: "Only images and videos", description: "Drop an image or a video to paste its path on the host.", status: "error" });
          return;
        }
        termRef.current?.focus();
        void sendMedia(files);
      }}
    >
      <div
        ref={hostRef}
        className={cn(
          // Fira Code ligatures off: the WebGL renderer draws cell by cell, so the DOM renderer matches it.
          "absolute origin-top-left transition-[filter,opacity] duration-500 [font-variant-ligatures:none]",
          // DOM renderer: glyphs wider than their cell (Nerd Font icons are 1 em) get a negative letter-spacing
          // and overflow into the next cell, like WebGL draws them; keep the next cell's background from covering them.
          "[&_.xterm-rows_span[style*='letter-spacing:_-']]:relative",
          compact ? "inset-1" : "inset-x-2.5 top-2 bottom-1",
          dim && "opacity-60 saturate-[0.15]",
        )}
      />
      <AnimatePresence>
        {searchOpen && inst && searchRef.current && (
          <SearchBar
            search={searchRef.current}
            frameTick={beat}
            draftKey={draftKey("terminal.search", hostId, targetKey)}
            onClose={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {dragging && (
          <motion.div
            key="drop"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute inset-0 z-raised grid place-items-center bg-[rgb(12_10_20/0.62)] shadow-[inset_0_0_0_2px_var(--color-accent),inset_0_0_36px_-8px_rgb(163_92_240/0.6)]"
          >
            <span className="flex items-center gap-2 rounded-full bg-[rgb(20_20_28/0.92)] px-3.5 py-2 text-xs font-bold text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]">
              <ImageUp className="size-4 text-accent-hi" />
              Drop to upload · its host path is pasted
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      <PaneOverlay
        phase={phase}
        compact={compact}
        mode={mode}
        offline={offline}
        conn={conn}
        herdr={herdrDown(herdr) && hostOnline ? herdr : undefined}
        hostId={hostId}
        hostName={hostName}
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
        <div className="pointer-events-none absolute top-2 right-3 flex min-w-0 items-center gap-1.5">
          <UploadPill uploads={uploads} touch={touchUi} />
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
            <ContextMenuItem icon={<Search />} shortcut="Ctrl F" onSelect={() => setSearchOpen(true)}>
              Find…
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
          data-toast-anchor
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
        <>
          <input
            ref={pickRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              if (files.length > 0) void sendMedia(files);
            }}
          />
          <ExtraKeys
            mods={mods}
            onKey={onExtraKey}
            onSetMod={onSetMod}
            onPaste={() => void paste()}
            onPickMedia={() => pickRef.current?.click()}
            className={cn(
              "shrink-0 border-t border-line bg-[linear-gradient(180deg,var(--color-tile-1),var(--color-chrome))] transition-opacity duration-300",
              !live && "pointer-events-none opacity-45",
            )}
          />
        </>
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
