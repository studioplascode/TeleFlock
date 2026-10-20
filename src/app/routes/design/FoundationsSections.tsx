import { AgentGlyph, LogoMark, STATUS, STATUSES, StatusOrb, Tile, Wordmark, cn, z } from "@/design";
import { Demo, Section } from "./Showcase";

const SURFACES = [
  ["bg", "#0b0b10"],
  ["bg-deep", "#07070b"],
  ["chrome", "#0d0d13"],
  ["tile-1", "#15151d"],
  ["tile-2", "#1b1b25"],
  ["tile-3", "#232330"],
  ["tile-4", "#2c2c3b"],
  ["tile-5", "#383849"],
] as const;

const INKS = [
  ["ink", "text-ink"],
  ["ink-2", "text-ink-2"],
  ["mute", "text-mute"],
  ["mute-2", "text-mute-2"],
] as const;

const BRAND = [
  ["accent", "bg-accent", "#a35cf0 · primary, selection, focus"],
  ["accent-hi", "bg-accent-hi", "#b97cf6"],
  ["accent-lo", "bg-accent-lo", "#7d3fd0"],
  ["omp", "bg-omp", "#f053d0 → #a15eef → #7fa2e7"],
  ["sun", "bg-sun", "#ff7a18 → #ff3d77 · needs you"],
  ["run", "bg-run live-gradient", "#a35cf0 → #4f8bff · running (animated)"],
] as const;

const TYPE = [
  ["mega", "text-mega font-display font-extrabold", "$14.62"],
  ["hero", "text-hero font-display font-bold", "37% cpu"],
  ["display", "text-display font-display font-bold", "Flock"],
  ["3xl", "text-3xl font-display font-bold", "How should notifications reach your phone?"],
  ["2xl", "text-2xl font-display font-bold", "New worktree"],
  ["xl", "text-xl font-display font-bold", "Session · push"],
  ["lg", "text-lg font-display font-semibold", "Running"],
  ["md", "text-md font-semibold", "Android push notifications when an agent gets blocked"],
  ["base", "text-base", "Body copy on tiles — Manrope at 13px with tabular numerals 0123456789."],
  ["sm", "text-sm", "Secondary paragraphs and form text."],
  ["xs", "text-xs font-bold text-mute", "Meta · opus-5 · high · 41m"],
  ["2xs", "kicker", "Kicker / section label"],
  ["mono", "font-mono text-sm text-ink-2", "bun test src/board  ✓ 31/40 passing"],
] as const;

const SPACE = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16] as const;
const RADII = [
  ["xs", "rounded-xs", 6],
  ["sm", "rounded-sm", 10],
  ["md", "rounded-md", 14],
  ["lg", "rounded-lg", 18],
  ["xl", "rounded-xl", 22],
  ["tile", "rounded-tile", 28],
  ["sheet", "rounded-sheet", 34],
] as const;
const ELEVATIONS = [
  ["d1", "shadow-d1"],
  ["d2", "shadow-d2"],
  ["d3", "shadow-d3"],
  ["glow-accent", "shadow-glow-accent"],
  ["glow-sun", "shadow-glow-sun"],
  ["glow-run", "shadow-glow-run"],
] as const;

export function BrandSection() {
  return (
    <Section id="brand" kicker="01 · Brand" title="TeleFlock mark" description="The omp π whose crossbar is a gliding gull, trailed by its flock. Drawn in the omp gradient; app icons are generated from src/assets/logo/.">
      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <Tile className="flex min-h-56 items-center justify-center gap-8 overflow-hidden p-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_45%,rgb(163_92_240/0.28),transparent_70%)]" />
          <LogoMark size={132} animated className="relative drop-shadow-[0_10px_40px_rgb(163_92_240/0.5)]" />
          <div className="relative hidden flex-col gap-1 sm:flex">
            <span className="font-display text-display font-bold">TeleFlock</span>
            <span className="text-sm text-mute">Your agents, herded.</span>
          </div>
        </Tile>
        <div className="grid grid-cols-2 gap-4">
          <Demo label="Wordmark">
            <Wordmark size={26} />
          </Demo>
          <Demo label="Mono / sizes">
            <LogoMark size={16} mono className="text-mute" />
            <LogoMark size={24} />
            <LogoMark size={36} />
          </Demo>
          <Demo label="AgentGlyph (deterministic)" className="col-span-2">
            {["kanban", "push", "reconnect", "api-gateway", "hero", "ci", "docs", "flaky"].map((n, i) => (
              <AgentGlyph key={n} name={n} size={38} status={STATUSES[i % STATUSES.length]} />
            ))}
          </Demo>
        </div>
      </div>
    </Section>
  );
}

export function ColorSection() {
  return (
    <Section id="color" kicker="02 · Color" title="Surfaces, ink, brand & status" description="Dark only. Every status exposes --st-1/--st-2/--st-solid/--st-rgb/--st-grad/--st-glow under data-status, plus st-* utilities.">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {SURFACES.map(([name, hex]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className="h-14 rounded-md shadow-[inset_0_0_0_1px_var(--color-line-2)]" style={{ background: hex }} />
              <span className="font-mono text-2xs text-mute">{name}</span>
              <span className="font-mono text-[10px] text-mute-2">{hex}</span>
            </div>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {BRAND.map(([name, cls, note]) => (
            <div key={name} className="flex items-center gap-3 rounded-lg well p-2.5">
              <div data-status="running" className={cn("h-11 w-16 shrink-0 rounded-sm", cls)} />
              <div className="min-w-0">
                <div className="text-sm font-bold">{name}</div>
                <div className="truncate font-mono text-2xs text-mute-2">{note}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {STATUSES.map((s) => (
            <div key={s} data-status={s} className="flex flex-col gap-2 rounded-lg well p-3">
              <div className={cn("h-12 rounded-sm st-bg st-glow", s === "running" && "live-gradient")} />
              <div className="flex items-center gap-2">
                <StatusOrb status={s} size={8} label={null} />
                <span className="text-sm font-bold st-text">{STATUS[s].label}</span>
              </div>
              <span className="font-mono text-[10px] text-mute-2">
                {STATUS[s].c1} → {STATUS[s].c2}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-5 rounded-lg well p-3">
          {INKS.map(([name, cls]) => (
            <span key={name} className={cn("text-md font-semibold", cls)}>
              {name}
            </span>
          ))}
          <span className="text-md font-semibold text-omp">text-omp</span>
          <span data-status="needs-you" className="text-md font-semibold text-st-grad">
            text-st-grad
          </span>
          <span className="text-md font-semibold text-add">+412</span>
          <span className="text-md font-semibold text-del">−38</span>
          <span className="font-mono text-md font-semibold text-tool">bash</span>
        </div>
      </div>
    </Section>
  );
}

export function TypeSection() {
  return (
    <Section id="type" kicker="03 · Type" title="Sora · Manrope · JetBrains Mono" description="Bundled locally via @fontsource-variable (offline). Display sizes carry their own negative tracking.">
      <Tile className="flex flex-col divide-y divide-line overflow-hidden p-0">
        {TYPE.map(([name, cls, sample]) => (
          <div key={name} className="flex items-baseline gap-4 px-5 py-3">
            <span className="w-16 shrink-0 font-mono text-2xs text-mute-2">{name}</span>
            <span className={cn("min-w-0 truncate", cls)}>{sample}</span>
          </div>
        ))}
      </Tile>
    </Section>
  );
}

export function SpaceSection() {
  return (
    <Section id="space" kicker="04 · Space & depth" title="4px grid, radii, elevation, z-layers">
      <div className="grid gap-4 lg:grid-cols-2">
        <Demo label="spacing (1 unit = 4px)" className="items-start">
          <div className="flex w-full flex-col gap-1.5">
            {SPACE.map((n) => (
              <div key={n} className="flex items-center gap-3">
                <span className="w-10 font-mono text-2xs text-mute-2">{n}</span>
                <div className="h-2.5 rounded-full bg-omp" style={{ width: n * 4 * 2 }} />
                <span className="font-mono text-2xs text-mute">{n * 4}px</span>
              </div>
            ))}
          </div>
        </Demo>
        <Demo label="radii">
          {RADII.map(([name, cls, px]) => (
            <div key={name} className="flex flex-col items-center gap-1.5">
              <div className={cn("size-14 bg-tile-3 shadow-[inset_0_0_0_1px_var(--color-line-2)]", cls)} />
              <span className="font-mono text-2xs text-mute">
                {name} · {px}
              </span>
            </div>
          ))}
        </Demo>
        <Demo label="elevation">
          {ELEVATIONS.map(([name, cls]) => (
            <div key={name} className="flex flex-col items-center gap-2">
              <div className={cn("size-16 rounded-lg bg-[linear-gradient(180deg,var(--color-tile-2),var(--color-tile-1))]", cls)} />
              <span className="font-mono text-2xs text-mute">{name}</span>
            </div>
          ))}
        </Demo>
        <Demo label="z-layers (utilities z-*)" className="items-start">
          <div className="grid w-full grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            {Object.entries(z).map(([name, value]) => (
              <div key={name} className="flex justify-between font-mono text-xs">
                <span className="text-ink-2">z-{name}</span>
                <span className="text-mute-2">{value}</span>
              </div>
            ))}
          </div>
        </Demo>
      </div>
    </Section>
  );
}
