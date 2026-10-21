import * as RadixDialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { type ButtonHTMLAttributes, type MouseEvent, type PointerEvent, type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useIsMobile } from "../lib/hooks";
import { clampPan, clampScale, fitView, isZoomed, pinchView, type Point, type Size, toggleZoom, type View, wheelFactor, zoomBy, zoomLimits, type ZoomLimits, zoomTo } from "../lib/zoom";
import { IconButton } from "./Button";

export interface LightboxImage {
  src: string;
  alt?: string;
  /** Intrinsic size, if known (used until the image has loaded). */
  width?: number;
  height?: number;
}

export interface LightboxProps {
  /** The group the viewer pages through (one message's attachments, one tool card's images …). */
  images: readonly LightboxImage[];
  /** Open image; `null` = closed. */
  index: number | null;
  /** Paging (number) and closing (`null`). */
  onIndexChange: (index: number | null) => void;
}

/** Toolbar / keyboard zoom step. */
const ZOOM_STEP = 1.5;
/** Arrow-key pan distance (px). */
const PAN_STEP = 120;
/** Pointer travel (px) before a press is a drag, not a click/tap. */
const SLOP = 6;
const SWIPE_NAV = 60;
const SWIPE_CLOSE = 110;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 32;
/** Desktop breathing room around the fitted image for the side arrows and toolbars. */
const DESKTOP_PAD = 72;

const glass = "bg-[rgb(24_24_34/0.72)] text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] backdrop-blur-xl hover:bg-[rgb(44_44_60/0.85)] hover:text-ink";

/**
 * Full-screen image viewer: fit to screen, wheel / pinch / double-click zoom around the pointer,
 * drag to pan (clamped), toolbar + keyboard (+ − 0 1, arrows, Esc), paging through `images`
 * (buttons, ←/→, swipe), swipe down to close on touch. Controlled: `index` opens it.
 */
export function Lightbox({ images, index, onIndexChange }: LightboxProps) {
  // Keep rendering the last image while the close animation runs.
  const [shown, setShown] = useState(index ?? 0);
  if (index != null && index !== shown) setShown(index);
  const i = Math.max(0, Math.min(shown, images.length - 1));
  const image = images[i];
  const go = (delta: number) => {
    const next = i + delta;
    if (next >= 0 && next < images.length) onIndexChange(next);
  };
  const opener = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root
      open={index != null && images.length > 0}
      onOpenChange={(open) => {
        if (!open) onIndexChange(null);
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="tf-fade fixed inset-0 z-modal bg-[rgb(5_5_9/0.9)] backdrop-blur-xl" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className="tf-fade fixed inset-0 z-modal overflow-hidden outline-none"
          onOpenAutoFocus={(e) => {
            // Keys work from the start without a focus ring on the first toolbar button.
            e.preventDefault();
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Controlled (no Radix Trigger): Radix would drop focus on <body>; hand it back to the thumbnail.
            e.preventDefault();
            opener.current?.focus({ preventScroll: true });
            opener.current = null;
          }}
        >
          <RadixDialog.Title className="sr-only">{image?.alt || "Image"}</RadixDialog.Title>
          {image && <Frame key={i} image={image} index={i} count={images.length} go={go} close={() => onIndexChange(null)} />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Image views at the fit scale are stored as `null`, so resizing the stage re-fits them. */
function settle(next: View, limits: ZoomLimits): View | null {
  return isZoomed(next, limits) || next.scale < limits.fit ? next : null;
}

type Gesture =
  | { kind: "pan"; id: number; from: Point; start: View }
  | { kind: "pinch"; start: View; mid: Point; dist: number }
  | { kind: "swipe"; id: number; from: Point; touch: boolean };

interface FrameProps {
  image: LightboxImage;
  index: number;
  count: number;
  go: (delta: number) => void;
  close: () => void;
}

function Frame({ image, index, count, go, close }: FrameProps) {
  const mobile = useIsMobile();
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [stage, setStage] = useState<Size>(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [natural, setNatural] = useState<Size | null>(null);
  const [stored, setStored] = useState<{ view: View | null; animate: boolean }>({ view: null, animate: false });
  const [grabbing, setGrabbing] = useState(false);
  const [swipe, setSwipe] = useState<Point | null>(null);

  const size = natural ?? (image.width && image.height ? { w: image.width, h: image.height } : { w: 1, h: 1 });
  const limits = zoomLimits(size, stage, mobile ? 0 : DESKTOP_PAD);
  const view = stored.view ? clampPan({ ...stored.view, scale: clampScale(stored.view.scale, limits) }, size, stage) : fitView(limits);
  const zoomed = isZoomed(view, limits);

  // Gesture bookkeeping lives in refs: pointer events can outrun renders.
  const live = useRef({ view, limits, size, stage });
  useLayoutEffect(() => {
    live.current = { view, limits, size, stage };
  });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const swipeOffset = useRef<Point | null>(null);
  const lastTap = useRef<{ at: number; p: Point } | null>(null);
  const lastPointerType = useRef("mouse");

  const commit = (next: View, animate: boolean) => {
    live.current = { ...live.current, view: next };
    setStored({ view: settle(next, live.current.limits), animate });
  };

  const toStage = (clientX: number, clientY: number): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 } : { x: 0, y: 0 };
  };

  // Stage size (full-screen, but the window can resize and phones rotate).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setStage((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The reported size wins: an SVG with only a viewBox has no real intrinsic size (Chrome makes one up).
  const measure = (img: HTMLImageElement) => {
    const reported = image.width && image.height;
    const w = (reported ? image.width : img.naturalWidth) || 800;
    const h = (reported ? image.height : img.naturalHeight) || 600;
    setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  };
  // Cached images can finish before React attaches onLoad.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) measure(img);
  });

  // Wheel / trackpad pinch (ctrl+wheel). Native listener: React's wheel handler is passive.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, limits, size, stage } = live.current;
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (isZoomed(view, limits)) {
          const next = clampPan({ ...view, x: view.x - e.deltaX }, size, stage);
          live.current = { ...live.current, view: next };
          setStored({ view: settle(next, limits), animate: false });
        }
        return;
      }
      const r = el.getBoundingClientRect();
      const at = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
      const next = zoomBy(view, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), at, size, stage, limits);
      live.current = { ...live.current, view: next };
      setStored({ view: settle(next, limits), animate: false });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomStep = (factor: number) => commit(zoomBy(live.current.view, factor, { x: 0, y: 0 }, size, stage, limits), true);
  const fit = () => commit(fitView(limits), true);
  const actual = () => commit(zoomTo(live.current.view, 1, { x: 0, y: 0 }, size, stage, limits), true);

  // Keyboard (Esc is Radix's). Window-level so it works whichever control inside has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = live.current.view;
      const isZoomedNow = isZoomed(v, live.current.limits);
      const pan = (dx: number, dy: number) => commit(clampPan({ ...v, x: v.x + dx, y: v.y + dy }, live.current.size, live.current.stage), true);
      switch (e.key) {
        case "+":
        case "=":
          zoomStep(ZOOM_STEP);
          break;
        case "-":
        case "_":
          zoomStep(1 / ZOOM_STEP);
          break;
        case "0":
          fit();
          break;
        case "1":
          actual();
          break;
        case "ArrowLeft":
          if (isZoomedNow) pan(PAN_STEP, 0);
          else go(-1);
          break;
        case "ArrowRight":
          if (isZoomedNow) pan(-PAN_STEP, 0);
          else go(1);
          break;
        case "ArrowUp":
          if (!isZoomedNow) return;
          pan(0, PAN_STEP);
          break;
        case "ArrowDown":
          if (!isZoomedNow) return;
          pan(0, -PAN_STEP);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const beginGesture = () => {
    const entries = [...pointers.current.entries()];
    const v = live.current.view;
    if (entries.length >= 2) {
      const [a, b] = [entries[0]![1], entries[1]![1]];
      gesture.current = { kind: "pinch", start: v, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
      swipeOffset.current = null;
      setSwipe(null);
      setGrabbing(false);
    } else if (entries.length === 1) {
      const [id, from] = entries[0]!;
      if (isZoomed(v, live.current.limits)) {
        gesture.current = { kind: "pan", id, from, start: v };
        setGrabbing(true);
      } else {
        gesture.current = { kind: "swipe", id, from, touch: lastPointerType.current !== "mouse" };
      }
    } else {
      gesture.current = null;
      setGrabbing(false);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    lastPointerType.current = e.pointerType;
    e.currentTarget.setPointerCapture(e.pointerId);
    // A primary pointer starts a fresh gesture; drop any pointer whose up/cancel never arrived.
    if (e.isPrimary || pointers.current.size === 0) {
      pointers.current.clear();
      moved.current = false;
    }
    pointers.current.set(e.pointerId, toStage(e.clientX, e.clientY));
    if (pointers.current.size <= 2) beginGesture();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = toStage(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    const { size, stage, limits } = live.current;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      if (Math.abs(dist - g.dist) > SLOP || Math.hypot(mid.x - g.mid.x, mid.y - g.mid.y) > SLOP) moved.current = true;
      commit(pinchView(g.start, g.mid, mid, dist / g.dist, size, stage, limits), false);
      return;
    }
    if (g.id !== e.pointerId) return;
    const dx = p.x - g.from.x;
    const dy = p.y - g.from.y;
    if (!moved.current && Math.hypot(dx, dy) < SLOP) return;
    moved.current = true;
    if (g.kind === "pan") {
      commit(clampPan({ scale: g.start.scale, x: g.start.x + dx, y: g.start.y + dy }, size, stage), false);
      return;
    }
    // Not zoomed: horizontal swipe pages, downward swipe (touch) closes.
    const offset = Math.abs(dx) >= Math.abs(dy) ? { x: count > 1 ? dx : dx / 4, y: 0 } : { x: 0, y: g.touch ? Math.max(0, dy) : 0 };
    swipeOffset.current = offset;
    setSwipe(offset);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === "swipe" && g.id === e.pointerId) {
      const off = swipeOffset.current;
      swipeOffset.current = null;
      setSwipe(null);
      if (off && e.type === "pointerup") {
        if (count > 1 && Math.abs(off.x) > SWIPE_NAV) go(off.x < 0 ? 1 : -1);
        else if (off.y > SWIPE_CLOSE) close();
      }
    }
    // Lifting one finger of a pinch hands over to a pan with the other (no jump).
    beginGesture();
    // Double-tap (touch / pen); mouse uses dblclick.
    if (e.type !== "pointerup" || e.pointerType === "mouse" || moved.current || pointers.current.size > 0 || g?.kind === "pinch") return;
    const p = toStage(e.clientX, e.clientY);
    const prev = lastTap.current;
    if (prev && e.timeStamp - prev.at < DOUBLE_TAP_MS && Math.hypot(p.x - prev.p.x, p.y - prev.p.y) < DOUBLE_TAP_PX) {
      lastTap.current = null;
      const { view, size, stage, limits } = live.current;
      commit(toggleZoom(view, p, size, stage, limits), true);
    } else {
      lastTap.current = { at: e.timeStamp, p };
    }
  };

  // A click on the backdrop (outside the image, not the end of a drag) closes.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (moved.current) return;
    const p = toStage(e.clientX, e.clientY);
    const { view, size } = live.current;
    if (Math.abs(p.x - view.x) > (size.w * view.scale) / 2 || Math.abs(p.y - view.y) > (size.h * view.scale) / 2) close();
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (lastPointerType.current !== "mouse") return;
    const { view, size, stage, limits } = live.current;
    commit(toggleZoom(view, toStage(e.clientX, e.clientY), size, stage, limits), true);
  };

  const hasPrev = index > 0;
  const hasNext = index < count - 1;
  const btnSize = mobile ? "lg" : "md";
  const swipeDim = swipe?.y ? 1 - Math.min(swipe.y / 500, 0.6) : 1;

  return (
    <>
      <div
        ref={stageRef}
        className={cn("absolute inset-0 touch-none select-none", zoomed && (grabbing ? "cursor-grabbing" : "cursor-grab"))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <div
          className="absolute inset-0"
          style={{
            transform: swipe ? `translate3d(${swipe.x}px, ${swipe.y}px, 0)` : undefined,
            opacity: swipeDim,
            transition: swipe ? "none" : "transform 0.3s var(--ease-out-expo), opacity 0.3s",
          }}
        >
          <div className="absolute inset-0 animate-[tf-dialog-in_0.34s_var(--ease-out-expo)]">
            <img
              ref={imgRef}
              src={image.src}
              alt={image.alt ?? ""}
              draggable={false}
              onLoad={(e) => measure(e.currentTarget)}
              className="pointer-events-none absolute top-1/2 left-1/2 max-w-none rounded-[2px] shadow-[0_24px_80px_-12px_rgb(0_0_0/0.7)] select-none"
              style={{
                width: size.w,
                height: size.h,
                opacity: natural ? 1 : 0,
                transform: `translate(-50%, -50%) translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
                transition: stored.animate ? "transform 0.28s var(--ease-out-expo)" : undefined,
              }}
            />
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-3 bg-[linear-gradient(rgb(0_0_0/0.45),transparent)] px-4 pt-[max(12px,env(safe-area-inset-top))] pb-6 max-md:px-3">
        {count > 1 && (
          <span className="shrink-0 rounded-full bg-[rgb(24_24_34/0.72)] px-3 py-1 text-xs font-bold text-ink-2 tabular shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] backdrop-blur-xl" aria-live="polite">
            {index + 1} / {count}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-2">{image.alt}</span>
        <RadixDialog.Close asChild>
          <IconButton label="Close" size={btnSize} className={cn("pointer-events-auto rounded-full", glass)}>
            <X />
          </IconButton>
        </RadixDialog.Close>
      </div>

      {!mobile && count > 1 && (
        <>
          {hasPrev && (
            <IconButton label="Previous image" size="lg" className={cn("absolute top-1/2 left-4 -translate-y-1/2 rounded-full", glass)} onClick={() => go(-1)}>
              <ChevronLeft />
            </IconButton>
          )}
          {hasNext && (
            <IconButton label="Next image" size="lg" className={cn("absolute top-1/2 right-4 -translate-y-1/2 rounded-full", glass)} onClick={() => go(1)}>
              <ChevronRight />
            </IconButton>
          )}
        </>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-3 pb-[max(16px,env(safe-area-inset-bottom))]">
        <div className={cn("pointer-events-auto flex items-center gap-1 rounded-full p-1.5", glass, "hover:bg-[rgb(24_24_34/0.72)]")} role="toolbar" aria-label="Image zoom">
          {mobile && count > 1 && (
            <IconButton label="Previous image" size={btnSize} className="rounded-full" disabled={!hasPrev} onClick={() => go(-1)}>
              <ChevronLeft />
            </IconButton>
          )}
          <IconButton label="Zoom out" size={btnSize} className="rounded-full" disabled={view.scale <= limits.min + 1e-6} onClick={() => zoomStep(1 / ZOOM_STEP)}>
            <ZoomOut />
          </IconButton>
          <span className="min-w-[52px] text-center text-xs font-bold text-ink-2 tabular" aria-live="polite">
            {Math.round(view.scale * 100)}%
          </span>
          <IconButton label="Zoom in" size={btnSize} className="rounded-full" disabled={view.scale >= limits.max - 1e-6} onClick={() => zoomStep(ZOOM_STEP)}>
            <ZoomIn />
          </IconButton>
          <span className="mx-0.5 h-5 w-px bg-white/12" />
          <IconButton label="Fit to screen" size={btnSize} className="rounded-full" disabled={stored.view === null} onClick={fit}>
            <Maximize />
          </IconButton>
          <IconButton label="Actual size" size={btnSize} className="rounded-full text-xs font-extrabold" disabled={Math.abs(view.scale - 1) < 1e-3} onClick={actual}>
            1:1
          </IconButton>
          {mobile && count > 1 && (
            <IconButton label="Next image" size={btnSize} className="rounded-full" disabled={!hasNext} onClick={() => go(1)}>
              <ChevronRight />
            </IconButton>
          )}
        </div>
      </div>
    </>
  );
}

export interface LightboxTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (default "Open image"). */
  label?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** Wraps a thumbnail: zoom-in cursor, keyboard focus ring, opens the lightbox on click. */
export function LightboxTrigger({ label = "Open image", className, type, ...rest }: LightboxTriggerProps) {
  return <button type={type ?? "button"} aria-label={label} className={cn("block cursor-zoom-in rounded-md focus-ring", className)} {...rest} />;
}
