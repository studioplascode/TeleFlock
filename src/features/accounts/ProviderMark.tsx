import { cn } from "@/design";
import { providerLook } from "./providers";

/** Drawn glyphs for marks that letters don't carry (abstract shapes, not the providers' logos). */
function Glyph({ kind }: { kind: "burst" | "sparkle" | "x" }) {
  if (kind === "burst")
    return (
      <svg viewBox="0 0 24 24" className="size-[58%]" aria-hidden>
        {[0, 45, 90, 135].map((deg) => (
          <rect key={deg} x="10.6" y="2.5" width="2.8" height="19" rx="1.4" fill="currentColor" transform={`rotate(${deg} 12 12)`} />
        ))}
      </svg>
    );
  if (kind === "sparkle")
    return (
      <svg viewBox="0 0 24 24" className="size-[62%]" aria-hidden>
        <path d="M12 1.5c.9 5.6 4.9 9.6 10.5 10.5-5.6.9-9.6 4.9-10.5 10.5C11.1 16.9 7.1 12.9 1.5 12 7.1 11.1 11.1 7.1 12 1.5Z" fill="currentColor" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className="size-[52%]" aria-hidden>
      <path d="M4 3.5h3.6l12.4 17h-3.6z" fill="currentColor" />
      <path d="M17.8 3.5h2.4l-6.7 7.6-1.3-1.7zM6.2 20.5H3.8l6.8-7.8 1.3 1.7z" fill="currentColor" />
    </svg>
  );
}

/** A provider's mark: its color with a short glyph (`GPT`, a burst for Claude, …). */
export function ProviderMark({ id, ompName, size = 36, className }: { id: string; ompName?: string; size?: number; className?: string }) {
  const look = providerLook(id, ompName);
  const drawn = look.glyph === "burst" || look.glyph === "sparkle" || look.glyph === "x";
  const letters = drawn ? 0 : look.glyph.length;
  return (
    <span
      aria-hidden
      className={cn("relative grid shrink-0 place-items-center rounded-[28%] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14),0_6px_16px_-8px_rgb(0_0_0/0.8)]", className)}
      style={{ width: size, height: size, background: look.bg }}
    >
      {drawn ? (
        <Glyph kind={look.glyph as "burst" | "sparkle" | "x"} />
      ) : (
        <span className="font-display leading-none font-extrabold tracking-[-0.03em]" style={{ fontSize: size * (letters >= 3 ? 0.3 : letters === 2 ? 0.36 : 0.46) }}>
          {look.glyph}
        </span>
      )}
    </span>
  );
}
