import { motion } from "motion/react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
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

const ROW: (ExtraKey | { kind: "mod"; mod: keyof ModState })[] = [
  { kind: "named", key: "esc", label: "ESC", aria: "Escape" },
  { kind: "named", key: "tab", label: "TAB", aria: "Tab" },
  { kind: "mod", mod: "ctrl" },
  { kind: "mod", mod: "alt" },
  { kind: "named", key: "left", label: <ArrowLeft />, aria: "Left arrow", repeat: true },
  { kind: "named", key: "up", label: <ArrowUp />, aria: "Up arrow", repeat: true },
  { kind: "named", key: "down", label: <ArrowDown />, aria: "Down arrow", repeat: true },
  { kind: "named", key: "right", label: <ArrowRight />, aria: "Right arrow", repeat: true },
  { kind: "char", ch: "|" },
  { kind: "char", ch: "~" },
  { kind: "char", ch: "/" },
  { kind: "char", ch: "-" },
];

const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 55;

export interface ExtraKeysProps {
  mods: ModState;
  onKey(key: ExtraKey): void;
  onSetMod(mod: keyof ModState, latch: ModLatch): void;
  onPaste(): void;
  className?: string;
}

const keyCls =
  "relative grid h-10 min-w-11 shrink-0 place-items-center rounded-sm px-2 font-mono text-[13px] font-bold text-ink-2 select-none touch-manipulation shadow-key [&_svg]:size-4 bg-tile-3 active:bg-tile-5 active:text-ink focus-ring";

/**
 * Mobile extra-keys row (Termux-style). Buttons never take focus, so the soft keyboard stays up;
 * arrows auto-repeat while held; Ctrl/Alt latch for the next key (double-tap locks).
 */
export function ExtraKeys({ mods, onKey, onSetMod, onPaste, className }: ExtraKeysProps) {
  // `repeated` marks a hold that already auto-repeated, so the trailing click doesn't send once more.
  const repeat = useRef<{ delay?: number; every?: number; repeated?: boolean }>({});
  const lastModTap = useRef<{ mod: keyof ModState; at: number } | null>(null);

  const stopRepeat = () => {
    clearTimeout(repeat.current.delay);
    clearInterval(repeat.current.every);
    repeat.current = { repeated: repeat.current.repeated };
  };
  useEffect(() => stopRepeat, []);

  return (
    <div
      role="toolbar"
      aria-label="Extra keys"
      className={cn("flex gap-1.5 overflow-x-auto overscroll-x-contain px-2 py-1.5 [scrollbar-width:none]", className)}
      // Keep focus (and the soft keyboard) on the terminal.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {ROW.map((k) => {
        if (k.kind === "mod") {
          const state = mods[k.mod];
          return (
            <motion.button
              key={k.mod}
              type="button"
              tabIndex={-1}
              aria-pressed={state > 0}
              aria-label={`${k.mod === "ctrl" ? "Control" : "Alt"}${state === 2 ? " (locked)" : state === 1 ? " (next key)" : ""}`}
              whileTap={{ scale: 0.9 }}
              transition={spring.press}
              className={cn(
                keyCls,
                "min-w-13 text-[12px] tracking-wide",
                state === 1 && "bg-accent/22 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.7),0_0_18px_-4px_rgb(163_92_240/0.9)]",
                state === 2 && "bg-omp text-white shadow-glow-accent",
              )}
              onClick={() => {
                const now = performance.now();
                const prev = lastModTap.current;
                lastModTap.current = { mod: k.mod, at: now };
                // Tap: off → next key → off. Quick double tap: lock until tapped again.
                const quick = prev !== null && prev.mod === k.mod && now - prev.at < 320;
                const next: ModLatch = state === 0 ? 1 : state === 1 && quick ? 2 : 0;
                onSetMod(k.mod, next);
                haptic(next === 0 ? "tick" : "select");
              }}
            >
              {k.mod === "ctrl" ? "CTRL" : "ALT"}
              {state > 0 && (
                <motion.span
                  key={state}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={spring.bouncy}
                  className={cn("absolute bottom-1 h-[3px] rounded-full", state === 2 ? "w-5 bg-white" : "w-1.5 bg-accent-hi animate-breathe tf-loop")}
                  aria-hidden
                />
              )}
            </motion.button>
          );
        }
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
            className={cn(keyCls, k.kind === "named" && !k.repeat && "text-[11.5px] tracking-wide")}
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
      })}
      <motion.button
        type="button"
        tabIndex={-1}
        aria-label="Paste"
        whileTap={{ scale: 0.88 }}
        transition={spring.press}
        className={cn(keyCls, "text-mute [&_svg]:size-4")}
        onClick={() => {
          onPaste();
          haptic("tick");
        }}
      >
        <ClipboardPaste />
      </motion.button>
    </div>
  );
}
