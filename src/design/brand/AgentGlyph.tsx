import type { CSSProperties } from "react";
import { hashString } from "../lib/hash";
import { cn } from "../lib/cn";
import { StatusOrb } from "../motion/StatusOrb";
import type { Status } from "../tokens";

/** Motifs drawn over the gradient (24×24 box, white, low alpha). */
const MOTIFS = [
  "M-2 18 L18 -2 M4 26 L26 4 M10 30 L30 10", // diagonal stripes
  "M12 24 A12 12 0 0 1 12 0", // half disc edge
  "M0 17 L6 11 L12 17 L18 11 L24 17", // chevron flight
  "M24 24 m-14 0 a14 14 0 0 1 14 -14 M24 24 m-8 0 a8 8 0 0 1 8 -8", // corner arcs
  "M4 4 h0 M12 4 h0 M20 4 h0 M4 12 h0 M20 12 h0 M4 20 h0 M12 20 h0 M20 20 h0", // dot ring
  "M0 8 Q6 2 12 8 T24 8 M0 16 Q6 10 12 16 T24 16", // waves
] as const;

export interface AgentGlyphTheme {
  from: string;
  to: string;
  angle: number;
  motif: string;
  glow: string;
}

/** Deterministic colours/motif for an agent name (exported for canvases and charts). */
export function agentGlyphTheme(name: string): AgentGlyphTheme {
  const h = hashString(name.trim().toLowerCase());
  const hue = h % 360;
  const spread = 38 + ((h >>> 9) % 50);
  const motif = MOTIFS[(h >>> 17) % MOTIFS.length] ?? MOTIFS[0];
  return {
    from: `oklch(0.74 0.16 ${hue})`,
    to: `oklch(0.58 0.2 ${(hue + spread) % 360})`,
    angle: 120 + ((h >>> 4) % 6) * 15,
    motif,
    glow: `oklch(0.62 0.2 ${hue} / 0.55)`,
  };
}

/** One or two initials: "kanban" → "K", "api-gateway" → "AG", "ssh reconnect" → "SR". */
function initials(name: string): string {
  const parts = name.trim().split(/[\s\-_/.:]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return (parts[0]?.[0] ?? "?").toUpperCase();
}

export interface AgentGlyphProps {
  /** Agent / session name; the same name always gets the same glyph. */
  name: string;
  /** px (default 36). */
  size?: number;
  /** Corner status orb. */
  status?: Status;
  className?: string;
}

/** Deterministic gradient identity mark for an agent (squircle, initials, motif). */
export function AgentGlyph({ name, size = 36, status, className }: AgentGlyphProps) {
  const t = agentGlyphTheme(name);
  const letters = initials(name);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: size * 0.32,
    backgroundImage: `linear-gradient(${t.angle}deg, ${t.from}, ${t.to})`,
    boxShadow: `inset 0 1px 0 rgb(255 255 255 / 0.3), 0 6px 16px -6px ${t.glow}`,
    fontSize: size * (letters.length > 1 ? 0.36 : 0.44),
  };
  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", className)} style={style} role="img" aria-label={name}>
      <svg viewBox="0 0 24 24" className="absolute inset-0 size-full overflow-hidden" style={{ borderRadius: "inherit" }} aria-hidden>
        <path d={t.motif} fill="none" stroke="#fff" strokeOpacity="0.2" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <span className="relative font-display leading-none font-bold tracking-[-0.03em] text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.25)]">
        {letters}
      </span>
      {status && (
        <StatusOrb
          status={status}
          size={Math.max(8, Math.round(size * 0.28))}
          label={null}
          className="absolute -right-0.5 -bottom-0.5 rounded-full shadow-[0_0_0_2.5px_var(--color-tile-2)]"
        />
      )}
    </span>
  );
}
