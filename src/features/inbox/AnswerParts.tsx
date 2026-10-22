import { Check, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { NeedsOption, OptionTone } from "@/core/gen";
import { Spinner, cn, spring } from "@/design";

/*
 * One option model for every answer surface: board cards and the lane hero, Inbox, the HUD,
 * Dispatch replies, phone Flock cards (`QuickAnswer`) and the session's ask card (`AskCard`).
 * Number badges 1…N where number keys work, "Other…" is N+1, recommended is an outline plus
 * "★ recommended" (never a fill: a filled tile means "picked"), the description sits inside the
 * button as a muted second line, and "Skip (answer nothing)" is a quiet text button.
 */

/** Where an option is drawn: board card chip, roomy desktop tile (Inbox/HUD), sunset hero, phone, session ask card. */
export type OptionSkin = "card" | "panel" | "hero" | "big" | "sun";

/** Key events from a field the user types in never answer (1–9, Enter). */
export function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

interface SkinStyle {
  tile: string;
  label: string;
  desc: string;
  idle: string;
  primary: string;
  danger: string;
  recommended: string;
  rec: string;
  on: string;
  badge: string;
  badgeOn: string;
}

const DARK = {
  idle: "bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] hover:bg-tile-5",
  primary: "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.34)]",
  danger: "text-[#ff8aa5] shadow-[inset_0_0_0_1px_rgb(255_77_94/0.42)] hover:bg-error/15",
  recommended: "shadow-[inset_0_0_0_1.5px_rgb(255_122_24/0.9)]",
  rec: "text-[#ffb08a]",
  on: "bg-accent text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)] hover:bg-accent",
  badge: "bg-tile-2 text-mute shadow-key",
  badgeOn: "bg-white/25 text-white",
};

const SUNSET = {
  primary: "shadow-[inset_0_0_0_1px_rgb(255_255_255/0.45)]",
  recommended: "shadow-[inset_0_0_0_2px_rgb(255_255_255/0.88)]",
  rec: "text-white",
  badge: "bg-white/15 text-white",
  badgeOn: "bg-sun text-white",
};

const SKIN: Record<OptionSkin, SkinStyle> = {
  card: { ...DARK, tile: "rounded-sm px-2.5 py-1.5 gap-1.5", label: "text-2xs font-bold", desc: "text-[10.5px] font-medium text-mute" },
  panel: { ...DARK, tile: "rounded-md px-3 py-2 gap-2", label: "text-xs font-bold", desc: "text-2xs font-medium leading-snug text-mute" },
  big: {
    ...DARK,
    idle: "bg-tile-4 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] active:bg-tile-5",
    tile: "min-h-11 rounded-lg px-3.5 py-2.5 gap-2.5",
    label: "text-sm font-bold",
    desc: "text-xs font-medium text-mute",
  },
  hero: {
    ...SUNSET,
    tile: "rounded-md px-3 py-1.5 gap-2",
    label: "text-xs font-bold",
    desc: "text-[10.5px] font-medium text-white/75",
    idle: "bg-[rgb(40_0_20/0.24)] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)] hover:bg-[rgb(40_0_20/0.36)]",
    danger: "bg-[rgb(40_0_20/0.42)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.3)] hover:bg-[rgb(60_0_20/0.6)]",
    on: "bg-white text-[#d21a5a] hover:bg-white",
  },
  sun: {
    ...SUNSET,
    tile: "rounded-lg px-3 py-2.5 gap-2.5",
    label: "text-[13.5px] font-extrabold",
    desc: "text-[11.5px] leading-[1.35] opacity-[0.88]",
    idle: "bg-[rgb(45_0_22/0.22)] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] hover:bg-[rgb(45_0_22/0.34)]",
    danger: "bg-[rgb(45_0_22/0.4)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.28)] hover:bg-[rgb(45_0_22/0.52)]",
    on: "bg-white text-[#2a0b16] shadow-[0_12px_26px_-8px_rgb(80_0_30/0.55)] hover:bg-white",
  },
};

/** Frame classes of an option tile (for custom tiles such as an open "Other…" field). */
export function optionFrame(skin: OptionSkin, state: { tone?: OptionTone; recommended?: boolean; on?: boolean } = {}): string {
  const s = SKIN[skin];
  return cn(
    "flex min-w-0 items-start text-left transition-colors duration-150",
    s.tile,
    s.idle,
    state.tone === "primary" && s.primary,
    state.tone === "danger" && s.danger,
    state.recommended && s.recommended,
    state.on && s.on,
  );
}

/** Number / checkbox badge at the start of a tile. */
function OptionBadge({ skin, number, multi, on }: { skin: OptionSkin; number?: number; multi: boolean; on: boolean }) {
  const s = SKIN[skin];
  if (number === undefined && !multi) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "mt-px grid h-[18px] min-w-[18px] shrink-0 place-items-center px-1 font-mono text-[10px] leading-none font-bold",
        multi ? "rounded-[5px]" : "rounded-full",
        on ? s.badgeOn : s.badge,
      )}
    >
      {multi && on ? <Check className="size-3" strokeWidth={3.5} /> : number}
    </span>
  );
}

export interface OptionTileProps {
  skin: OptionSkin;
  option: Pick<NeedsOption, "label" | "description"> & Partial<Pick<NeedsOption, "recommended" | "tone">>;
  /** Number-key badge (only where 1–9 work). */
  number?: number;
  /** Multi-select: a checkbox badge and `aria-pressed`. */
  multi?: boolean;
  /** Picked (multi) or the answer that was sent. */
  on?: boolean;
  pending?: boolean;
  disabled?: boolean;
  /** Description: one line (cards, phone), all of it (Inbox, HUD, session), or none. */
  describe?: "clamp" | "full";
  /** Leading icon instead of a badge ("Other…", "Chat about this"). */
  icon?: ReactNode;
  /** Stagger index for the entrance animation (session ask card). */
  enter?: number;
  onClick(): void;
  className?: string;
}

/** One answer option: badge, label, "★ recommended", the description as a muted second line. */
export function OptionTile({ skin, option, number, multi = false, on = false, pending = false, disabled, describe = "clamp", icon, enter, onClick, className }: OptionTileProps) {
  const s = SKIN[skin];
  const props = {
    type: "button" as const,
    disabled,
    onClick,
    "aria-pressed": multi ? on : undefined,
    className: cn(
      optionFrame(skin, { tone: option.tone, recommended: option.recommended, on }),
      "focus-ring disabled:cursor-default disabled:opacity-60",
      enter === undefined && "pressable",
      on && "disabled:opacity-100",
      className,
    ),
  };
  const content = (
    <>
      {icon ? <span className="mt-px grid shrink-0 place-items-center [&_svg]:size-[1.15em]">{icon}</span> : <OptionBadge skin={skin} number={number} multi={multi} on={on} />}
      <span className="min-w-0 flex-1">
        <span className={cn("flex flex-wrap items-baseline gap-x-1.5", s.label)}>
          <span className="min-w-0 break-words">{option.label}</span>
          {option.recommended && (
            <span className={cn("text-[0.82em] font-extrabold whitespace-nowrap", on ? "opacity-80" : s.rec)}>
              <span aria-hidden>★ </span>recommended
            </span>
          )}
        </span>
        {option.description && (
          <span className={cn("mt-0.5 block", s.desc, describe === "clamp" && "line-clamp-1", on && "text-current opacity-80")}>{option.description}</span>
        )}
      </span>
      {pending && <Spinner size={12} label="Sending" className="mt-px shrink-0" />}
    </>
  );
  // The session card staggers its options in; everywhere else they just sit there (CSS press feedback).
  if (enter === undefined) return <button {...props}>{content}</button>;
  return (
    <motion.button
      {...props}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, delay: 0.03 * enter } }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
    >
      {content}
    </motion.button>
  );
}

/** "Skip (answer nothing)": cancels the request without choosing; quieter than any option (Deny is an option). */
export function SkipButton({ onClick, disabled, sunset = false, className }: { onClick(): void; disabled?: boolean; sunset?: boolean; className?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pressable focus-ring inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-bold disabled:opacity-50",
        sunset ? "text-white/85 hover:bg-black/20 hover:text-white" : "text-mute hover:bg-white/5 hover:text-ink",
        className,
      )}
    >
      <X className="size-3.5" aria-hidden />
      Skip <span className="font-semibold opacity-70">(answer nothing)</span>
    </button>
  );
}
