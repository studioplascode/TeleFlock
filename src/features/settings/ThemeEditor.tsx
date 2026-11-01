import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Button, cn, Dialog, DialogContent, hasErrors, Input, inspectThemeCss, THEME_VAR_GROUPS, type ThemeIssue, toast, useIsMobile, useThemeStore } from "@/design";
import { FullSpecimen, ThemeScope } from "./ThemePreview";

/** What the editor opens on: an existing custom theme (`id`) or a new one. */
export interface EditorTarget {
  id?: string;
  name: string;
  css: string;
  /** Preset id it started from. */
  base: string;
}

const isColor = (v: string) => typeof CSS !== "undefined" && CSS.supports("color", v);

/** Theme editor: name, CSS with live checks, and a live preview confined to the dialog. */
export function ThemeEditor({ target, onClose }: { target: EditorTarget | null; onClose(): void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {target && <EditorBody key={target.id ?? `new:${target.base}:${target.name}`} target={target} onClose={onClose} />}
    </Dialog>
  );
}

function EditorBody({ target, onClose }: { target: EditorTarget; onClose(): void }) {
  const mobile = useIsMobile();
  const [name, setName] = useState(target.name);
  const [css, setCss] = useState(target.css);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const deferred = useDeferredValue(css);
  const info = inspectThemeCss(deferred, { isColor });
  const broken = hasErrors(info);
  // The preview keeps the last CSS without errors while the text is mid-edit.
  const [good, setGood] = useState(target.css);
  useEffect(() => {
    if (!broken) setGood(deferred);
  }, [broken, deferred]);
  const onScreen = useThemeStore((s) => target.id !== undefined && (s.trial?.id ?? s.active) === target.id);

  const jumpTo = (line: number) => {
    const ta = textRef.current;
    if (!ta) return;
    const lines = css.split("\n");
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  };

  const insert = (text: string) => {
    const ta = textRef.current;
    const at = ta?.selectionStart ?? css.length;
    const end = ta?.selectionEnd ?? at;
    setCss(css.slice(0, at) + text + css.slice(end));
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(at + text.length, at + text.length);
    });
  };

  const save = (use: boolean) => {
    const store = useThemeStore.getState();
    const result = target.id ? store.update(target.id, { name, css }) : store.create({ name, css, base: target.base });
    if (!result.ok) return setSaveError(result.error);
    const saved = useThemeStore.getState().custom.find((t) => t.id === result.id);
    if (use && (useThemeStore.getState().trial?.id ?? useThemeStore.getState().active) !== result.id) {
      const used = useThemeStore.getState().choose(result.id);
      if (!used.ok) return setSaveError(used.error);
    }
    toast({ title: `Saved “${saved?.name ?? name}”`, status: "done" });
    onClose();
  };

  const errors = info.issues.filter((i) => i.severity === "error");
  return (
    <DialogContent
      title={target.id ? `Edit “${target.name}”` : "New theme"}
      description="Variables on :root restyle TeleFlock everywhere; any other CSS works too. The preview shows the theme here only, until you use it."
      width={1180}
      className={cn(mobile && "p-4")}
      footer={
        <>
          <span className={cn("mr-auto text-xs", errors.length ? "text-error-ink" : "text-mute")} role="status">
            {saveError ?? (errors.length ? `${errors.length} error${errors.length > 1 ? "s" : ""}: fix them to save` : info.issues.length ? `${info.issues.length} warning${info.issues.length > 1 ? "s" : ""}` : "No problems")}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={broken || !name.trim()} onClick={() => save(false)}>
            Save
          </Button>
          {!onScreen && (
            <Button disabled={broken || !name.trim()} onClick={() => save(true)}>
              Save and use
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Theme name" placeholder="Theme name" maxLength={60} />
          <div className="well rounded-md">
            <textarea
              ref={textRef}
              value={css}
              onChange={(e) => {
                setCss(e.target.value);
                setSaveError(null);
              }}
              aria-label="Theme CSS"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              className="block h-[min(52vh,520px)] w-full resize-y bg-transparent px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-ink-2 outline-none max-md:h-[38vh]"
            />
          </div>
          {info.issues.length > 0 && <IssueList issues={info.issues} onJump={jumpTo} />}
          <details className="rounded-md bg-ink/[0.03] px-3 py-2 text-xs shadow-hairline">
            <summary className="cursor-pointer font-bold text-ink-2">Variables a theme may set</summary>
            <p className="mt-1.5 text-mute">Click one to insert its name. Colours take any CSS colour; `url()` takes data: URIs only, and nothing loads from the network.</p>
            <div className="mt-2 flex flex-col gap-2.5">
              {THEME_VAR_GROUPS.map((g) => (
                <div key={g.title}>
                  <div className="kicker mb-1">{g.title}</div>
                  <ul className="grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
                    {g.vars.map((v) => (
                      <li key={v.name} className="min-w-0">
                        <button type="button" className="focus-ring w-full truncate rounded-xs text-left hover:bg-ink/6" onClick={() => insert(v.name)} title={v.hint}>
                          <code className="font-mono text-accent-ink">{v.name}</code> <span className="text-mute-2">{v.hint}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        </div>
        <div className="min-w-0 md:sticky md:top-0 md:self-start">
          <div className="kicker mb-1.5 flex items-center gap-2">
            Preview
            {broken && <span className="font-sans text-2xs font-semibold tracking-normal text-mute-2 normal-case">showing the last version without errors</span>}
          </div>
          <ThemeScope id="editor" css={broken ? good : deferred} className="@container overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_var(--color-line-2)]">
            <FullSpecimen />
          </ThemeScope>
        </div>
      </div>
    </DialogContent>
  );
}

function IssueList({ issues, onJump }: { issues: readonly ThemeIssue[]; onJump(line: number): void }) {
  return (
    <ul className="flex max-h-36 flex-col gap-1 overflow-auto text-xs" aria-label="Problems">
      {issues.slice(0, 12).map((i, n) => (
        <li key={`${i.line}:${n}`}>
          <button
            type="button"
            onClick={() => onJump(i.line)}
            className={cn("focus-ring w-full rounded-sm px-2 py-1 text-left", i.severity === "error" ? "bg-error/10 text-error-ink" : "bg-warn/10 text-warn-ink")}
          >
            <span className="font-mono font-bold">Line {i.line}</span> · {i.message}
          </button>
        </li>
      ))}
      {issues.length > 12 && <li className="px-2 text-mute-2">and {issues.length - 12} more</li>}
    </ul>
  );
}
