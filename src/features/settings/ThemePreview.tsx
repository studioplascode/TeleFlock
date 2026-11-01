import type { ReactNode } from "react";
import { cn, PREVIEW_STYLE_ATTR, previewCss, readThemeDefaults, StatusOrb } from "@/design";

let defaultsCache: Map<string, string> | undefined;

/** The default theme's variables (tokens.css), read once: the stylesheet doesn't change while the app runs. */
export function themeDefaults(): Map<string, string> {
  defaultsCache ??= readThemeDefaults();
  return defaultsCache;
}

/**
 * Renders `children` in theme `css` (the default theme under it), whatever theme the app shows:
 * the theme's rules are scoped to this element (`previewCss`), so a broken theme can't reach the
 * rest of the page. `id` must be unique on the page and safe in an attribute.
 */
export function ThemeScope({ id, css, className, children }: { id: string; css: string; className?: string; children: ReactNode }) {
  const scope = `[data-theme-preview="${id}"]`;
  const style = previewCss(css, scope, themeDefaults());
  return (
    <div data-theme-preview={id} className={cn("tf-theme-scope bg-bg text-ink", className)}>
      <style {...{ [PREVIEW_STYLE_ATTR]: "" }}>{style}</style>
      {children}
    </div>
  );
}

/** The picker card's thumbnail: sidebar, three lanes' cards, a line of code, a primary button. */
export function MiniSpecimen() {
  return (
    <div className="flex h-full gap-1.5 p-1.5" aria-hidden>
      <div className="flex w-5 flex-col items-center gap-1 rounded-[7px] bg-chrome py-1.5 shadow-hairline">
        <span className="size-2 rounded-full bg-omp" />
        <span className="h-1 w-2.5 rounded-full bg-ink/25" />
        <span className="h-1 w-2.5 rounded-full bg-ink/15" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[9px] bg-[linear-gradient(180deg,var(--color-tile-2),var(--color-tile-1))] p-1.5 shadow-d1">
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-8 rounded-full bg-ink/80" />
          <span className="ml-auto h-2.5 w-6 rounded-[4px] bg-omp" />
        </div>
        <div className="grid flex-1 grid-cols-3 gap-1">
          {(["running", "needs-you", "done"] as const).map((s) => (
            <div key={s} data-status={s} className={cn("flex flex-col gap-0.5 rounded-[6px] p-1", s === "needs-you" ? "card-sunset" : "bg-tile-3 shadow-hairline")}>
              <span className="flex items-center gap-0.5">
                <span className="size-1.5 rounded-full st-fill" />
                <span className="h-1 flex-1 rounded-full bg-ink/60" />
              </span>
              <span className="h-1 w-3/4 rounded-full bg-ink/25" />
              <span className="h-1 w-1/2 rounded-full bg-ink/15" />
            </div>
          ))}
        </div>
        <div className="flex gap-1 rounded-[5px] bg-(--term-bg) px-1 py-0.5 font-mono text-[6px] leading-[8px]">
          <span className="text-(--syntax-keyword)">const</span>
          <span className="text-(--syntax-function)">fly</span>
          <span className="text-(--syntax-string)">"south"</span>
          <span className="text-(--term-green)">✓</span>
        </div>
      </div>
    </div>
  );
}

/** The editor's live preview: the surfaces a theme paints, at real size. */
export function FullSpecimen() {
  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="kicker">Board</span>
        <span className="ml-auto inline-flex h-8 items-center rounded-sm bg-omp px-3 text-xs font-bold text-on-accent shadow-glow-accent">Dispatch</span>
        <span className="inline-flex h-8 items-center rounded-sm bg-tile-4 px-3 text-xs font-bold text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]">Secondary</span>
        <span className="inline-flex h-8 items-center rounded-sm bg-error/12 px-3 text-xs font-bold text-error-ink">Delete</span>
      </div>
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
        <div data-status="running" className="card-surface flex flex-col gap-1 p-2.5">
          <span className="flex items-center gap-1.5 text-xs font-bold">
            <StatusOrb status="running" size={8} label={null} /> kanban
          </span>
          <span className="text-2xs text-mute">Refactoring the lanes</span>
          <span className="text-2xs text-mute-2">3 subagents · 12m</span>
        </div>
        <div data-status="needs-you" className="card-surface card-sunset flex flex-col gap-1 p-2.5">
          <span className="text-xs font-bold">Needs you</span>
          <span className="text-2xs text-mute">Allow npm install?</span>
          <span className="mt-0.5 inline-flex w-fit rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold text-[#d21a5a]">Allow</span>
        </div>
        <div data-status="review" className="card-surface flex flex-col gap-1 p-2.5">
          <span className="inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold st-soft">Review</span>
          <span className="text-2xs text-mute">
            <span className="text-add">+412</span> <span className="text-del">−38</span>
          </span>
        </div>
        <div data-status="done" className="card-surface flex flex-col gap-1 p-2.5">
          <span className="inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold st-bg">Done</span>
          <span className="text-2xs text-warn">1 warning</span>
          <span className="text-2xs text-error">1 error</span>
        </div>
      </div>
      <div className="glass flex flex-col gap-2 rounded-lg p-2.5">
        <div className="self-end rounded-lg bg-accent/14 px-2.5 py-1.5 text-xs text-accent-ink">Make the board faster</div>
        <div className="text-xs text-ink-2">
          Done. The lanes now render <code className="rounded-[5px] bg-ink/[0.07] px-1 font-mono text-accent-ink">memo</code>ized cards.
        </div>
        <pre className="overflow-hidden rounded-md bg-bg-deep/80 px-2.5 py-2 font-mono text-[11px] leading-[1.6] text-ink-2">
          <span className="text-(--syntax-comment) italic">{"// cards re-render on lane change only\n"}</span>
          <span className="text-(--syntax-keyword)">export function </span>
          <span className="text-(--syntax-function)">Lane</span>
          <span className="text-(--syntax-punctuation)">(</span>
          <span className="text-(--syntax-variable)">props</span>
          <span className="text-(--syntax-punctuation)">: </span>
          <span className="text-(--syntax-type)">LaneProps</span>
          <span className="text-(--syntax-punctuation)">{") {\n  "}</span>
          <span className="text-(--syntax-keyword)">return </span>
          <span className="text-(--syntax-tag)">{"<Card "}</span>
          <span className="text-(--syntax-attribute)">title</span>
          <span className="text-(--syntax-operator)">=</span>
          <span className="text-(--syntax-string)">"Running"</span>
          <span className="text-(--syntax-tag)">{" />"}</span>
          <span className="text-(--syntax-punctuation)">{";\n}"}</span>
        </pre>
        <div className="overflow-hidden rounded-md font-mono text-[11px] leading-[1.6]">
          <div className="bg-add/[0.08] px-2.5 text-ink-2">
            <span className="text-add">+ </span>
            <span className="text-(--syntax-keyword)">const</span> cards = <span className="text-(--syntax-number)">42</span>;
          </div>
          <div className="bg-del/[0.08] px-2.5 text-ink-2">
            <span className="text-del">− </span>
            <span className="text-(--syntax-keyword)">let</span> cards = <span className="text-(--syntax-literal)">null</span>;
          </div>
        </div>
        <pre className="overflow-hidden rounded-md bg-(--term-bg) px-2.5 py-2 font-mono text-[11px] leading-[1.6] text-(--term-fg)">
          <span className="text-(--term-green)">✓</span> 86 pass <span className="text-(--term-red)">✗</span> 0 fail <span className="text-(--term-bright-black)">[82ms]</span>
          {"\n"}
          <span className="text-(--term-blue)">~/teleflock</span> <span className="text-(--term-magenta)">main</span> <span className="text-(--term-yellow)">$</span> herdr agent list
        </pre>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="well inline-flex h-8 flex-1 items-center rounded-md px-2.5 text-xs text-mute-2">Ask anything…</span>
        <span className="inline-flex items-center gap-1.5 rounded-xl bg-float/94 px-3 py-2 text-xs font-bold text-ink shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)]">
          <StatusOrb status="done" size={7} label={null} /> Toast
        </span>
      </div>
    </div>
  );
}
