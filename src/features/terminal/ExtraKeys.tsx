import { motion } from "motion/react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Lock } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { cn, spring } from "@/design";
import { haptic } from "@/features/shell/haptics";
import type { NamedKey } from "./keys";

/** 0 = off, 1 = latched for the next key, 2 = locked until tapped again. */
export type ModLatch = 0 | 1 | 2;
export interface ModState {
  ctrl: ModLatch;
  alt: ModLatch;
}

export type ExtraKey = { kind: "named"; key: NamedKey; label: ReactNode; aria: string; repeat?: boolean } | { kind: "char"; ch: string };

/** Always reachable: Esc and the sticky modifiers never scroll away. */
const PINNED: (ExtraKey | { kind: "mod"; mod: keyof ModState })[] = [
  { kind: "named", key: "esc", label: "ESC", aria: "Escape" },
  { kind: "mod", mod: "ctrl" },
  { kind: "mod", mod: "alt" },
];

const SCROLLING: ExtraKey[] = [
  { kind: "named", key: "tab", label: "TAB", aria: "Tab" },
  { kind: "named", key: "left", label: <ArrowLeft />, aria: "Left arrow", repeat: true },
  { kind: "named", key: "up", label: <ArrowUp />, aria: "Up arrow", repeat: true },
  { kind: "named", key: "down", label: <ArrowDown />, aria: "Down arrow", repeat: true },
  { kind: "named", key: "right", label: <ArrowRight />, aria: "Right arrow", repeat: true },
  { kind: "char", ch: "|" },
  { kind: "char", ch: "~" },
  { kind: "char", ch: "/" },
  { kind: "char", ch: "-" },
  { kind: "char", ch: "_" },
  { kind: "char", ch: ":" },
  { kind: "named", key: "home", label: "HOME", aria: "Home" },
  { kind: "named", key: "end", label: "END", aria: "End" },
  { kind: "named", key: "pgup", label: "PGUP", aria: "Page up", repeat: true },
  { kind: "named", key: "pgdn", label: "PGDN", aria: "Page down", repeat: true },
];

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 55;
const DOUBLE_TAP_MS = 320;
const LOCK_HOLD_MS = 420;
const FADE_PX = 28;

export interface ExtraKeysProps {
  mods: ModState;
  onKey(key: ExtraKey): void;
  onSetMod(mod: keyof ModState, latch: ModLatch): void;
  onPaste(): void;
  className?: string;
}

const keyCls =
  "relative grid h-10 min-w-10 shrink-0 place-items-center rounded-sm px-2 font-mono text-[13px] font-bold text-ink-2 select-none touch-manipulation shadow-key [&_svg]:size-[18px] bg-tile-3 transition-colors active:bg-tile-5 active:text-ink [-webkit-tap-highlight-color:transparent]";

/**
 * Mobile extra-keys row (Termux-style). Esc/Ctrl/Alt are pinned on the left; the rest scrolls with
 * edge fades showing there's more. Buttons never take focus, so the soft keyboard stays up; arrows
 * and paging auto-repeat while held; Ctrl/Alt latch for the next key, and lock with a double tap or
 * a long press.
 */
export function ExtraKeys({ mods, onKey, onSetMod, onPaste, className }: ExtraKeysProps) {
  // `repeated` marks a hold that already auto-repeated, so the trailing click doesn't send once more.
  const repeat = useRef<{ delay?: number; every?: number; repeated?: boolean }>({});
  const lastModTap = useRef<{ mod: keyof ModState; at: number } | null>(null);
  const modHold = useRef<{ timer?: number; locked?: boolean }>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const stopRepeat = () => {
    clearTimeout(repeat.current.delay);
    clearInterval(repeat.current.every);
    repeat.current = { repeated: repeat.current.repeated };
  };
  useEffect(
    () => () => {
      stopRepeat();
      clearTimeout(modHold.current.timer);
    },
    [],
  );

  // Edge fades only where there is more to scroll to (imperative: no React state per scroll frame).
  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const start = el.scrollLeft > 2 ? FADE_PX : 0;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? FADE_PX : 0;
    const mask = `linear-gradient(to right, transparent, #000 ${start}px, #000 calc(100% - ${end}px), transparent)`;
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateFade();
    const ro = new ResizeObserver(updateFade);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFade]);

  const renderKey = (k: ExtraKey) => {
    const label = k.kind === "char" ? k.ch : k.label;
    const aria = k.kind === "char" ? k.ch : k.aria;
    const fire = () => {
      onKey(k);
      haptic("tick");
    };
    return (
      <motion.button
        key={k.kind === "char" ? k.ch : k.key}
        type="button"
        tabIndex={-1}
        aria-label={aria}
        whileTap={{ scale: 0.88, y: 1 }}
        transition={spring.press}
        className={cn(keyCls, k.kind === "named" && typeof k.label === "string" && "text-[11.5px] tracking-wide", k.kind === "char" && "text-[15px]")}
        onPointerDown={() => {
          repeat.current.repeated = false;
          if (k.kind !== "named" || !k.repeat) return;
          stopRepeat();
          repeat.current.delay = window.setTimeout(() => {
            repeat.current.repeated = true;
            fire();
            repeat.current.every = window.setInterval(() => onKey(k), REPEAT_EVERY_MS);
          }, REPEAT_DELAY_MS);
        }}
        onPointerUp={stopRepeat}
        onPointerCancel={stopRepeat}
        onPointerLeave={stopRepeat}
        // Fire on click (not pointerdown) so swiping the row sideways never sends keys.
        onClick={() => {
          if (repeat.current.repeated) {
            repeat.current.repeated = false;
            return;
          }
          fire();
        }}
      >
        {label}
      </motion.button>
    );
  };

  const renderMod = (mod: keyof ModState) => {
    const state = mods[mod];
    const name = mod === "ctrl" ? "Control" : "Alt";
    const cancelHold = () => clearTimeout(modHold.current.timer);
    return (
      <motion.button
        key={mod}
        type="button"
        tabIndex={-1}
        aria-pressed={state > 0}
        aria-label={`${name}${state === 2 ? " (locked)" : state === 1 ? " (next key)" : ""}`}
        title={state === 2 ? `${name} locked: tap to release` : state === 1 ? `${name} applies to the next key` : `${name}: tap for the next key, double-tap or hold to lock`}
        whileTap={{ scale: 0.9 }}
        transition={spring.press}
        className={cn(
          keyCls,
          "min-w-12 text-[11.5px] tracking-wide",
          state === 1 && "bg-accent/22 text-accent-ink shadow-[inset_0_0_0_1.5px_rgb(163_92_240/0.75),0_0_18px_-4px_rgb(163_92_240/0.9)] active:bg-accent/30",
          state === 2 && "bg-omp text-white shadow-glow-accent active:bg-omp",
        )}
        onPointerDown={() => {
          modHold.current.locked = false;
          cancelHold();
          if (state === 2) return;
          modHold.current.timer = window.setTimeout(() => {
            modHold.current.locked = true;
            onSetMod(mod, 2);
            haptic("heavy");
          }, LOCK_HOLD_MS);
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onClick={() => {
          if (modHold.current.locked) {
            modHold.current.locked = false;
            return;
          }
          const now = performance.now();
          const prev = lastModTap.current;
          lastModTap.current = { mod, at: now };
          // Tap: off → next key → off. Quick double tap: lock until tapped again.
          const quick = prev !== null && prev.mod === mod && now - prev.at < DOUBLE_TAP_MS;
          const next: ModLatch = state === 0 ? 1 : state === 1 && quick ? 2 : 0;
          onSetMod(mod, next);
          haptic(next === 0 ? "tick" : next === 2 ? "heavy" : "select");
        }}
      >
        <span className="flex items-center gap-1">
          {state === 2 && <Lock className="size-3!" aria-hidden />}
          {mod === "ctrl" ? "CTRL" : "ALT"}
        </span>
        {state === 1 && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={spring.bouncy}
            className="tf-loop absolute bottom-1 h-[3px] w-1.5 animate-breathe rounded-full bg-accent-hi"
            aria-hidden
          />
        )}
      </motion.button>
    );
  };

  return (
    <div
      role="toolbar"
      aria-label="Extra keys"
      className={cn(
        "flex items-center gap-1 py-1 pr-[max(0.25rem,env(safe-area-inset-right))] pl-[max(0.375rem,env(safe-area-inset-left))]",
        className,
      )}
      // Keep focus (and the soft keyboard) on the terminal.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {PINNED.map((k) => (k.kind === "mod" ? renderMod(k.mod) : renderKey(k)))}
      <span aria-hidden className="mx-0.5 h-6 w-px shrink-0 bg-line-2" />
      <div
        ref={scrollRef}
        onScroll={updateFade}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto overscroll-x-contain py-0.5 pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SCROLLING.map(renderKey)}
        <motion.button
          type="button"
          tabIndex={-1}
          aria-label="Paste"
          whileTap={{ scale: 0.88 }}
          transition={spring.press}
          className={cn(keyCls, "text-mute")}
          onClick={() => {
            onPaste();
            haptic("tick");
          }}
        >
          <ClipboardPaste />
        </motion.button>
      </div>
    </div>
  );
}
