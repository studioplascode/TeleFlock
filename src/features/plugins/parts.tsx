import { ArrowUpCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn, Spinner } from "@/design";

/** What a plugin brings, as omp and the catalogs name it. */
const PROVIDES: Record<string, string> = {
  skills: "Skills",
  commands: "Commands",
  agents: "Agents",
  hooks: "Hooks",
  mcpServers: "MCP servers",
  lspServers: "LSP servers",
  extensions: "Extensions",
  tools: "Tools",
};

export function GroupHeader({ title, detail, count, action }: { title: string; detail?: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-1 pt-1">
      <h2 className="kicker shrink-0">{title}</h2>
      {count !== undefined && <span className="text-2xs font-bold text-mute-2 tabular">{count}</span>}
      {detail && <span className="ml-auto min-w-0 truncate text-2xs text-mute-2">{detail}</span>}
      {action && <span className={cn("shrink-0 self-center", !detail && "ml-auto")}>{action}</span>}
    </div>
  );
}

/** The icon tile at the start of a row. */
export function Glyph({ children, dim, className }: { children: ReactNode; dim?: boolean; className?: string }) {
  return <span className={cn("grid size-9 shrink-0 place-items-center rounded-md bg-white/[0.045] text-mute shadow-hairline [&_svg]:size-4", dim && "opacity-60", className)}>{children}</span>;
}

const TAG_TONE = {
  neutral: "bg-white/6 text-mute",
  project: "bg-review/12 text-review",
  warn: "bg-warn/12 text-warn",
  error: "bg-error/14 text-[#ff8aa5]",
  accent: "bg-accent/14 text-accent-ink",
} as const;

/** A small pill after a name: Project, Linked, Hidden, Deprecated… */
export function Tag({ tone = "neutral", title, children, className }: { tone?: keyof typeof TAG_TONE; title?: string; children: ReactNode; className?: string }) {
  return (
    <span title={title} className={cn("shrink-0 rounded-full px-2 py-px text-[10px] font-bold whitespace-nowrap", TAG_TONE[tone], className)}>
      {children}
    </span>
  );
}

/** "→ 1.3.0": a newer version that an update installs. */
export function UpdateBadge({ to, title }: { to: string; title?: string }) {
  return (
    <span
      title={title ?? `${to} is available`}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent/14 px-2 text-[11px] font-bold whitespace-nowrap text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]"
    >
      <ArrowUpCircle className="size-3" aria-hidden />
      {to}
    </span>
  );
}

/** A version as omp lists it. */
export function Version({ v }: { v: string }) {
  return <span className="shrink-0 font-mono text-2xs text-mute-2 tabular">{v}</span>;
}

/** What a plugin brings: commands, agents, hooks, MCP servers… */
export function ProvidesChips({ provides, className }: { provides: readonly string[]; className?: string }) {
  if (provides.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap gap-1", className)}>
      {provides.map((p) => (
        <span key={p} className="rounded-full bg-white/[0.05] px-1.5 py-px text-[10px] font-semibold text-mute shadow-hairline">
          {PROVIDES[p] ?? p}
        </span>
      ))}
    </span>
  );
}

/** A row's change in progress ("Updating…"): replaces its badges until it ends. */
export function BusyLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-2xs font-semibold whitespace-nowrap text-accent-ink" aria-live="polite">
      <Spinner size={12} />
      {label}
    </span>
  );
}

/** Label / value rows of an expanded row (`Fact`s). */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5", className)}>{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-2xs font-bold text-mute-2">{label}</dt>
      <dd className="min-w-0 text-xs break-words text-ink-2">{children}</dd>
    </>
  );
}
