import { Check, ClipboardPaste, Copy, Download, FileUp, MoreHorizontal, Palette, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  Button,
  type CustomTheme,
  cn,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  hasErrors,
  IconButton,
  inspectThemeCss,
  Kbd,
  nameFromFileName,
  PRESETS,
  presetById,
  SegmentedControl,
  THEME_ESCAPE_KEYS,
  type ThemeIssue,
  toast,
  useIsMobile,
  useMotionPreference,
  useNow,
  useThemeStore,
} from "@/design";
import { useSettings } from "@/core";
import type { MotionPref, Settings } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { MOTION_COPY, Row, Section } from "./parts";
import { type EditorTarget, ThemeEditor } from "./ThemeEditor";
import { MiniSpecimen, ThemeScope } from "./ThemePreview";
import { canDownloadThemes, downloadTheme, pickThemeFile, readClipboardText, startingCss } from "./themeFiles";

/** Calm (the default, stored as `system`) first, then Lively, then Reduced. */
const MOTION_ORDER: readonly MotionPref[] = ["system", "full", "reduced"];

/**
 * Settings → Appearance: the theme (premade or custom CSS, per device; src/design/theme) and the
 * motion level. A custom theme goes on trial when used: it sticks only once kept.
 */
export function Appearance({ index }: { index: number }) {
  const mobile = useIsMobile();
  const active = useThemeStore((s) => s.active);
  const activeCss = useThemeStore((s) => s.activeCss);
  const trial = useThemeStore((s) => s.trial);
  const custom = useThemeStore((s) => s.custom);
  const shown = trial?.id ?? active;
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [pasting, setPasting] = useState<{ text: string; name?: string } | null>(null);

  const use = (id: string) => {
    haptic("tick");
    const r = useThemeStore.getState().choose(id);
    if (!r.ok) toast({ title: "Couldn't use this theme", description: r.error, status: "error" });
  };

  const startNew = (baseId: string) => {
    const base = presetById(baseId)?.name ?? custom.find((t) => t.id === baseId)?.name ?? "Theme";
    const name = `${base} custom`;
    setEditing({ name, css: startingCss(baseId, name, custom), base: presetById(baseId) ? baseId : (custom.find((t) => t.id === baseId)?.base ?? "default") });
  };

  const importCss = (text: string, fileName?: string) => {
    const info = inspectThemeCss(text);
    if (hasErrors(info)) {
      setPasting({ text, name: fileName });
      return;
    }
    const base = PRESETS.find((p) => p.name === info.base)?.id ?? "default";
    const r = useThemeStore.getState().create({ name: info.name ?? (fileName ? nameFromFileName(fileName) : "Imported theme"), css: text, base });
    if (!r.ok) return toast({ title: "Couldn't import the theme", description: r.error, status: "error" });
    setPasting(null);
    const name = useThemeStore.getState().custom.find((t) => t.id === r.id)?.name ?? "the theme";
    toast({ title: `Imported “${name}”`, status: "done", action: { label: "Use it", onClick: () => use(r.id) } });
  };

  const importFile = () => {
    pickThemeFile().then(
      (file) => file && importCss(file.text, file.name),
      (err: unknown) => toast({ title: "Couldn't read the file", description: errorMessage(err), status: "error" }),
    );
  };

  const pasteCss = () => {
    void readClipboardText().then((text) => setPasting({ text: text?.trim() ?? "" }));
  };

  return (
    <Section index={index} icon={<Palette />} title="Appearance" description="Theme and motion on this device. Meaning never depends on colour or motion alone: every state is also text.">
      {trial && <TrialBanner name={custom.find((t) => t.id === trial.id)?.name ?? "this theme"} until={trial.until} />}
      <div className="flex flex-col gap-3 py-3 first:pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <div className="text-sm font-bold text-ink">Theme</div>
            <div className="text-xs text-mute">The main window, Quick capture and the phone app follow it. Custom themes are CSS; start one from any theme.</div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" icon={<Plus />}>
                New theme
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Start from</DropdownMenuLabel>
              {[...PRESETS, ...custom].map((t) => (
                <DropdownMenuItem key={t.id} onSelect={() => startNew(t.id)}>
                  {t.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" icon={<FileUp />}>
                Import
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={<FileUp />} onSelect={importFile}>
                From a .css file…
              </DropdownMenuItem>
              <DropdownMenuItem icon={<ClipboardPaste />} onSelect={pasteCss}>
                Paste CSS…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className={cn("grid gap-2.5", mobile ? "grid-cols-2" : "grid-cols-3 lg:grid-cols-4")} role="radiogroup" aria-label="Theme">
          {PRESETS.map((p) => (
            <ThemeCard key={p.id} id={p.id} name={p.name} note={p.description} css={p.css} selected={shown === p.id} onUse={() => use(p.id)} />
          ))}
          {custom.map((t) => (
            <ThemeCard
              key={t.id}
              id={t.id}
              name={t.name}
              note={`Custom · from ${presetById(t.base)?.name ?? "a theme"}`}
              // the confirmed snapshot is what's on screen for the active theme
              css={t.id === active && !trial ? (activeCss ?? t.css) : t.css}
              selected={shown === t.id}
              onUse={() => use(t.id)}
              menu={<CustomMenu theme={t} onEdit={() => setEditing({ id: t.id, name: t.name, css: t.css, base: t.base })} onDuplicate={() => startNew(t.id)} />}
            />
          ))}
        </div>
      </div>
      <Row
        label="Reset theme"
        description={
          <>
            Back to {presetById("default")?.name}; your themes stay. If a theme ever hides TeleFlock, press <Kbd>{THEME_ESCAPE_KEYS}</Kbd> anywhere, or open it with{" "}
            <code className="font-mono">?theme=default</code> in a browser's address.
          </>
        }
      >
        <Button size="sm" variant="secondary" icon={<RotateCcw />} disabled={shown === "default"} onClick={() => useThemeStore.getState().reset()}>
          Reset
        </Button>
      </Row>
      <AnimationRow />
      <ThemeEditor target={editing} onClose={() => setEditing(null)} />
      <PasteDialog draft={pasting} onImport={importCss} onClose={() => setPasting(null)} />
    </Section>
  );
}

function ThemeCard({ id, name, note, css, selected, onUse, menu }: { id: string; name: string; note: string; css: string; selected: boolean; onUse(): void; menu?: React.ReactNode }) {
  return (
    <div className={cn("group relative flex min-w-0 flex-col overflow-hidden rounded-lg bg-tile-3 shadow-hairline", selected && "shadow-[inset_0_0_0_2px_var(--color-accent),var(--shadow-glow-accent)]")}>
      <button type="button" role="radio" aria-checked={selected} onClick={onUse} className="focus-ring flex min-w-0 flex-col text-left">
        <ThemeScope id={id} css={css} className="pointer-events-none h-24 overflow-hidden">
          <MiniSpecimen />
        </ThemeScope>
        <span className="flex min-w-0 items-center gap-1.5 px-2.5 pt-2 text-sm font-bold text-ink">
          <span className="truncate">{name}</span>
          {selected && <Check className="size-3.5 shrink-0 text-accent-hi" aria-hidden />}
        </span>
        <span className="mb-2.5 line-clamp-2 px-2.5 text-2xs text-mute">{note}</span>
      </button>
      {menu && <div className="absolute top-1.5 right-1.5 rounded-sm bg-float/90 shadow-hairline">{menu}</div>}
    </div>
  );
}

function CustomMenu({ theme, onEdit, onDuplicate }: { theme: CustomTheme; onEdit(): void; onDuplicate(): void }) {
  const copy = () => {
    navigator.clipboard.writeText(theme.css).then(
      () => toast({ title: `Copied “${theme.name}”`, description: "Paste it into Import → Paste CSS on another device.", status: "done" }),
      (err: unknown) => toast({ title: "Couldn't copy", description: errorMessage(err), status: "error" }),
    );
  };
  const remove = () => {
    useThemeStore.getState().remove(theme.id);
    toast({
      title: `Deleted “${theme.name}”`,
      action: { label: "Undo", onClick: () => useThemeStore.getState().create({ name: theme.name, css: theme.css, base: theme.base }) },
    });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" label={`${theme.name}: more`}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Plus />} onSelect={onDuplicate}>
          Duplicate
        </DropdownMenuItem>
        {canDownloadThemes && (
          <DropdownMenuItem icon={<Download />} onSelect={() => toast({ title: `Saved ${downloadTheme(theme.name, theme.css)}`, description: "In your downloads.", status: "done" })}>
            Export .css file
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={<Copy />} onSelect={copy}>
          Copy CSS
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Trash2 />} danger onSelect={remove}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrialBanner({ name, until }: { name: string; until: number }) {
  const left = Math.max(0, Math.ceil((until - useNow(1000)) / 1000));
  return (
    <div role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-accent/12 px-3 py-2 text-sm text-accent-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent)]">
      <span className="min-w-0 flex-1">
        Trying “{name}”. Keep it? Going back in {left} s.
      </span>
      <Button size="sm" variant="ghost" onClick={() => useThemeStore.getState().goBack()}>
        Go back
      </Button>
      <Button size="sm" onClick={() => useThemeStore.getState().keep()}>
        Keep
      </Button>
    </div>
  );
}

function PasteDialog({ draft, onImport, onClose }: { draft: { text: string; name?: string } | null; onImport(text: string, fileName?: string): void; onClose(): void }) {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      {draft && <PasteBody key={draft.text} draft={draft} onImport={onImport} onClose={onClose} />}
    </Dialog>
  );
}

function PasteBody({ draft, onImport, onClose }: { draft: { text: string; name?: string }; onImport(text: string, fileName?: string): void; onClose(): void }) {
  const [text, setText] = useState(draft.text);
  const issues: readonly ThemeIssue[] = text.trim() ? inspectThemeCss(text).issues : [];
  const errors = issues.filter((i) => i.severity === "error");
  return (
    <DialogContent
      title="Import a theme"
      description={draft.name ? `${draft.name} has problems to fix before it can be imported.` : "Paste a theme's CSS. Nothing in it may load from the network."}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!text.trim() || errors.length > 0} onClick={() => onImport(text, draft.name)}>
            Import
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="well rounded-md">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Theme CSS"
            placeholder={":root {\n  --color-bg: #10141c;\n}"}
            spellCheck={false}
            wrap="off"
            data-autofocus
            className="block h-[40vh] w-full resize-y bg-transparent px-3 py-2.5 font-mono text-[12px] leading-[1.55] text-ink-2 outline-none placeholder:text-mute-2"
          />
        </div>
        {issues.length > 0 && (
          <ul className="flex max-h-32 flex-col gap-1 overflow-auto text-xs">
            {issues.slice(0, 8).map((i, n) => (
              <li key={`${i.line}:${n}`} className={cn("rounded-sm px-2 py-1", i.severity === "error" ? "bg-error/10 text-error-ink" : "bg-warn/10 text-warn-ink")}>
                <span className="font-mono font-bold">Line {i.line}</span> · {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}

/** The motion level, saved in app Settings (`settings.set`) and applied live. */
function AnimationRow() {
  const mobile = useIsMobile();
  const settings = useSettings();
  const setMotion = useMotionPreference((s) => s.setPreference);
  const update = (patch: Partial<Settings>) => {
    haptic("tick");
    settings.update(patch).catch((err: unknown) => {
      toast({ title: `Couldn't save settings: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
    });
  };
  return (
    <Row
      label="Animation"
      wide
      description={
        <ul className="mt-1 flex flex-col gap-0.5">
          {MOTION_ORDER.map((m) => (
            <li key={m} className={cn(settings.motion === m && "text-ink-2")}>
              <b className="font-bold">{MOTION_COPY[m].label}</b> · {MOTION_COPY[m].description}
            </li>
          ))}
        </ul>
      }
    >
      <SegmentedControl<MotionPref>
        value={settings.motion}
        onValueChange={(motion) => {
          setMotion(motion);
          update({ motion });
        }}
        options={MOTION_ORDER.map((m) => ({ value: m, label: MOTION_COPY[m].label }))}
        aria-label="Animation"
        fill={mobile}
      />
    </Row>
  );
}
