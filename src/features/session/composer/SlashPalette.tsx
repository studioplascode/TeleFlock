import { Slash } from "lucide-react";
import { motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, type RefObject, useState } from "react";
import type { CommandInfo } from "@/core/gen";
import type { OmpSubcommand } from "@/core/ompCommands";
import { cn, Kbd, spring } from "@/design";
import { MODE_BADGE, type SlashCommand, type SlashOffer, type SlashPopup, slashPopupAt } from "./slash";

/** A composer's popup over its text box (the `/` palette, `@` files): a header row, then the options. */
export function ComposerPopup({
  label,
  icon,
  title,
  busy,
  hint,
  mobile,
  children,
}: {
  label: string;
  icon: ReactNode;
  title: ReactNode;
  /** Shown after the title while the options load. */
  busy?: ReactNode;
  /** After the keyboard hints (desktop), e.g. "Enter sends as typed". */
  hint?: string;
  mobile: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: spring.snappy }}
      exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
      className="absolute inset-x-0 bottom-full z-popover mb-2 overflow-hidden rounded-lg bg-[linear-gradient(180deg,var(--color-pop-1),var(--color-pop-2))] shadow-[var(--shadow-d3),inset_0_0_0_1px_color-mix(in_srgb,var(--color-ink)_9%,transparent)]"
      role="listbox"
      aria-label={label}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-2xs font-bold text-mute-2">
        {icon}
        {title}
        {busy}
        {!mobile && (
          <span className="ml-auto flex items-center gap-1">
            <Kbd>↑↓</Kbd>
            <Kbd>Tab</Kbd>
            {hint && <span className="ml-1 font-semibold">{hint}</span>}
          </span>
        )}
      </div>
      <div className="max-h-[300px] overflow-y-auto p-1">{children}</div>
    </motion.div>
  );
}

export interface SlashPaletteOptions {
  /** The session's skills, prompt templates and extension commands (Dispatch: the new agent's, as far as known). */
  custom: readonly CommandInfo[];
  setText(text: string): void;
  ta: RefObject<HTMLTextAreaElement | null>;
  mobile: boolean;
  /**
   * Runs a picked command, or argument choice, that takes no arguments right away (the session
   * composer). Without it a pick only completes the text, which Enter then sends (Dispatch).
   */
  run?(command: string): void;
  /** Which commands and argument choices it offers (default: all). */
  offer?: SlashOffer;
  /** Greys a command out (a control this session doesn't expose right now). */
  unavailable?(c: SlashCommand): boolean;
  /** The badge after a command's description. Default: how it runs (`MODE_BADGE`), or a custom command's source. */
  badge?(c: SlashCommand): string | null;
}

export interface SlashPalette {
  open: boolean;
  /**
   * Follows the draft after each change (text and caret). False when the caret is in no command's
   * name or first argument: the palette closed, other popups may open.
   */
  update(value: string, caret: number): boolean;
  /** ↑↓ move, Tab (or Enter on a choice) picks, Esc closes. True when it took the key. */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean;
  close(): void;
  /** The palette, or null while closed (render it in an `AnimatePresence`). */
  element: ReactNode;
}

const defaultBadge = (c: SlashCommand): string | null => (c.source === "omp" || c.source === "teleflock" ? MODE_BADGE[c.mode] : c.source);

/**
 * The `/` command palette of a composer (session and Dispatch): omp's builtins and the
 * session's skills, prompt templates and extension commands with their argument hints, then a
 * command's argument choices once its name is typed; keyboard navigation.
 */
export function useSlashPalette(o: SlashPaletteOptions): SlashPalette {
  const [popup, setPopup] = useState<SlashPopup | null>(null);
  const [sel, setSel] = useState(0);

  const update = (value: string, caret: number): boolean => {
    const at = slashPopupAt(value, caret, o.custom, o.offer);
    setPopup(at?.popup ?? null);
    if (at) setSel(at.sel);
    return at !== undefined;
  };

  /** Puts `v` in the box with the caret at its end. */
  const complete = (v: string) => {
    o.setText(v);
    requestAnimationFrame(() => {
      o.ta.current?.focus();
      o.ta.current?.setSelectionRange(v.length, v.length);
    });
  };

  const pickCommand = (c: SlashCommand) => {
    if (c.instant && !c.subs && o.run) {
      o.setText("");
      setPopup(null);
      o.run(`/${c.name}`);
      return;
    }
    const subs = (c.subs ?? []).filter((s) => !o.offer || o.offer.sub(c, s));
    // `/skill:` goes on with the skill's name, no space.
    complete(c.name.endsWith(":") ? `/${c.name}` : `/${c.name} `);
    setPopup(subs.length ? { kind: "sub", cmd: c, items: subs } : null);
    setSel(-1);
  };

  /** A choice without arguments runs right away (with `run`); one with arguments is completed for typing. */
  const pickSub = (cmd: SlashCommand, s: OmpSubcommand) => {
    setPopup(null);
    if (!s.args && o.run) {
      o.setText("");
      o.run(`/${cmd.name} ${s.name}`);
      return;
    }
    complete(`/${cmd.name} ${s.name}${s.args ? " " : ""}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!popup) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPopup(null);
      return true;
    }
    const count = popup.items.length;
    if (count === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (s + 1) % count);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (s <= 0 ? count - 1 : s - 1));
      return true;
    }
    // Argument choices start unselected: Enter sends the command as typed (e.g. bare `/jobs`).
    const choosing = popup.kind !== "sub" || sel >= 0;
    if (e.key === "Tab" || (choosing && e.key === "Enter" && !e.shiftKey && !e.altKey)) {
      e.preventDefault();
      if (popup.kind === "slash") {
        const c = popup.items[sel];
        if (c) pickCommand(c);
      } else {
        const s = popup.items[Math.max(sel, 0)];
        if (s) pickSub(popup.cmd, s);
      }
      return true;
    }
    return false;
  };

  const badgeOf = o.badge ?? defaultBadge;
  const element =
    popup && popup.items.length > 0 ? (
      <ComposerPopup
        key={popup.kind}
        label={popup.kind === "slash" ? "Commands" : `/${popup.cmd.name} arguments`}
        icon={<Slash className="size-3" />}
        title={popup.kind === "slash" ? "Commands" : `/${popup.cmd.name} · pick an argument or keep typing`}
        hint={popup.kind === "sub" && sel < 0 ? "Enter sends as typed" : undefined}
        mobile={o.mobile}
      >
        {popup.kind === "slash"
          ? popup.items.map((c, i) => {
              const badge = badgeOf(c);
              return (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickCommand(c)}
                  title={c.mode === "terminal" ? "Opens omp's own UI in the agent's terminal" : c.mode === "report" ? "omp prints the result in its terminal; TeleFlock opens it for you" : undefined}
                  className={cn("flex w-full items-baseline gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px]", i === sel ? "bg-accent/18 text-ink" : "text-ink-2", o.unavailable?.(c) && "opacity-45")}
                >
                  <span className="shrink-0 font-mono font-bold whitespace-nowrap text-accent-hi">/{c.name}</span>
                  {c.args && !o.mobile && <span className="truncate font-mono text-[11px] text-mute-2">{c.args}</span>}
                  <span className="ml-auto truncate pl-3 text-xs text-mute">{c.description}</span>
                  {badge && (
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-1.5 text-[9.5px] font-bold tracking-wider whitespace-nowrap uppercase",
                        c.mode === "terminal" || c.mode === "report" ? "bg-accent/14 text-accent-hi" : "bg-ink/6 text-mute-2",
                      )}
                    >
                      {badge}
                    </span>
                  )}
                </button>
              );
            })
          : popup.items.map((s, i) => {
              const mode = popup.cmd.modeFor(s.name);
              const badge = MODE_BADGE[mode];
              return (
                <button
                  key={s.name}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSub(popup.cmd, s)}
                  className={cn("flex w-full items-baseline gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px]", i === sel ? "bg-accent/18 text-ink" : "text-ink-2")}
                >
                  <span className="font-mono font-bold text-accent-hi">{s.name}</span>
                  {s.args && !o.mobile && <span className="truncate font-mono text-[11px] text-mute-2">{s.args}</span>}
                  <span className="ml-auto truncate pl-3 text-xs text-mute">{s.description}</span>
                  {badge && mode !== "direct" && <span className="shrink-0 rounded-full bg-accent/14 px-1.5 text-[9.5px] font-bold tracking-wider whitespace-nowrap text-accent-hi uppercase">{badge}</span>}
                </button>
              );
            })}
      </ComposerPopup>
    ) : null;

  return { open: popup !== null, update, onKeyDown, close: () => setPopup(null), element };
}
