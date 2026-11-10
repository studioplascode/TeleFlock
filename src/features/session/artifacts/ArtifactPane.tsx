import { AtSign, Check, ChevronDown, Copy, Download, ExternalLink, FolderInput, MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { getTranscript, type SplitState, toApiError, useSession } from "@/core";
import type { ArtifactFile, PresentKind } from "@/core/gen";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatAge,
  IconButton,
  isAndroid,
  isTauri,
  saveBlob,
  toast,
  useIsMobile,
  useNow,
  useThemeVersion,
} from "@/design";
import { LOAD_MAX, RANGELESS_MAX } from "@/features/review/diff/media";
import { FullscreenFrame } from "@/features/shell/FullscreenFrame";
import { SplitHeaderRow } from "@/features/shell/SplitHeaderRow";
import { figureBackground, renderDiagram } from "../markdown/diagrams";
import { prepareSvg, svgDataUrl } from "../markdown/svg";
import { copyText, formatBytes, mentionArtifact, refreshArtifacts, useArtifactList } from "./artifacts";
import { ArtifactBody, type FileActions, KIND_ICON, KIND_TONE } from "./ArtifactView";
import { KIND_LABEL, mimeFor, presentedName, presentedVersions } from "./kinds";
import { type DocRef, docFileName, docKind, type LoadedDoc, opensAsIs, otherVersion, type ReadProgress, readFile, shownAsFile, useLoadedDoc } from "./load";
import { canOpenInBrowser, openInBrowser } from "./native";
import { imageDocument, standaloneDocument } from "./sandbox";
import { closeFullscreen, docOf, showFullscreen, switchDoc, useFullscreenDoc } from "./viewer";

/** The Android app's WebView has no downloads. */
const canSave = !(isTauri() && isAndroid);

function KindTile({ kind }: { kind: PresentKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-[8px]", KIND_TONE[kind])} aria-hidden>
      <Icon className="size-3.5" />
    </span>
  );
}

/** The listing's entry for this document (its title, modification time and the other versions). */
function useListed(doc: DocRef): { file?: ArtifactFile; files: readonly ArtifactFile[] } {
  const list = useArtifactList(doc.agentKey);
  const files = list.data?.files ?? [];
  return { file: doc.kind === "review" ? undefined : files.find((f) => f.kind === doc.kind && f.name === doc.name), files };
}

/** v1, v2, …: every version of a presented document, the shown one checked. */
function Versions({ doc, files, from }: { doc: DocRef; files: readonly ArtifactFile[]; from: "split" | "full" }) {
  const now = useNow(60_000);
  const p = doc.kind === "local" ? presentedName(doc.name) : undefined;
  if (!p) return null;
  const listed = presentedVersions(files, p.slug);
  const versions = listed.some((v) => v.version === p.version) ? listed : [...listed, { version: p.version, file: undefined }].sort((a, b) => a.version - b.version);
  if (versions.length < 2)
    return <span className="shrink-0 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] font-bold text-mute tabular">v{p.version}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Version ${p.version} of ${versions.length}; other versions`}
          className="focus-ring pressable flex shrink-0 items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-bold text-accent-hi tabular hover:bg-accent/20"
        >
          v{p.version}
          <span className="font-semibold text-mute">/ {versions.length}</span>
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Versions</DropdownMenuLabel>
        {[...versions].reverse().map((v) => {
          const name = v.file?.name ?? doc.name;
          return (
            <DropdownMenuItem
              key={v.version}
              icon={v.version === p.version ? <Check /> : <span className="size-4" />}
              shortcut={v.file ? formatAge(now - v.file.mtime) : undefined}
              onSelect={() => switchDoc(from, otherVersion(doc, name))}
            >
              Version {v.version}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The path the agent presented snapshot `name` from, when the session's loaded rows hold its card. */
function presentedSource(agentKey: string, name: string): string | undefined {
  for (const item of getTranscript(agentKey).items) if (item.kind === "tool" && item.artifact?.name === name) return item.artifact.source;
  return undefined;
}

/** A file's bytes read for Save and Open (once per document, then kept while it is shown); `reading` meanwhile. */
function useFileBytes(doc: DocRef): { reading?: ReadProgress; bytes: () => Promise<Blob> } {
  const key = `${doc.agentKey}|${doc.kind}|${doc.name}`;
  const [reading, setReading] = useState<{ key: string; progress: ReadProgress }>();
  const job = useRef<{ key: string; blob: Promise<Blob> }>(undefined);
  const runs = useRef(0);
  const bytes = (): Promise<Blob> => {
    if (job.current?.key === key) return job.current.blob;
    const run = ++runs.current;
    const show = (progress: ReadProgress | undefined) => {
      if (runs.current === run) setReading(progress && { key, progress });
    };
    const blob = readFile(doc, (received, size) => show({ received, size }));
    job.current = { key, blob };
    show({ received: 0, size: 0 });
    blob.then(
      () => show(undefined),
      () => {
        show(undefined);
        if (job.current?.blob === blob) job.current = undefined;
      },
    );
    return blob;
  };
  return { reading: reading?.key === key ? reading.progress : undefined, bytes };
}

/** What Save and Open in browser write for the shown document, whether they can, and doing it (the menu's, and a file's card). */
interface DocActions {
  saveName: string;
  /** There is something to save (loaded, and readable here). */
  saves: boolean;
  /** Open in browser is offered. */
  opens: boolean;
  save: () => void;
  open: () => void;
  /** Shown as a file: its card's actions. */
  file?: FileActions;
}

/**
 * Save writes the document under the name `docFileName` gives it: a page as its copy with the
 * policy first, a file's or a medium's bytes (a file shown as one is read for it, in ranges),
 * everything else its text; Open in browser the same, a drawing or diagram as a page that shows
 * it as an image, a file handed over only as a type that opens as it is.
 */
function useDocActions(doc: DocRef, loaded: LoadedDoc | undefined, kind: PresentKind, title: string, review: string | undefined): DocActions {
  const theme = useThemeVersion();
  const fileBytes = useFileBytes(doc);
  const asFile = loaded !== undefined && shownAsFile(loaded);
  const source = asFile && doc.kind === "local" ? presentedSource(doc.agentKey, doc.name) : undefined;
  const as: PresentKind = asFile ? "file" : kind;
  const saveName = docFileName(doc, as, "save", source);
  const openName = docFileName(doc, as, "open", source);
  const text = review ?? loaded?.text;
  // A page never leaves the viewer without its policy.
  const body = kind === "html" ? (text != null ? (loaded?.standalone ?? standaloneDocument(text, new Map())) : undefined) : text;
  const size = loaded?.content.size ?? 0;
  const blocked = !asFile
    ? undefined
    : size > LOAD_MAX
      ? `TeleFlock saves files up to ${formatBytes(LOAD_MAX)}: copy its path on the host instead.`
      : loaded?.rangeless && size > RANGELESS_MAX
        ? `This host's TeleFlock reads files up to ${formatBytes(RANGELESS_MAX)} at once: update TeleFlock on the host to save this one.`
        : undefined;
  const saves = review !== undefined || (loaded !== undefined && !blocked && (asFile || loaded.media !== undefined || body != null));
  const opens = canOpenInBrowser() && saves && (asFile ? opensAsIs(openName) : loaded?.media !== undefined || (kind === "svg" ? loaded?.imageUrl !== undefined : body != null));
  const failed = (what: string) => (e: unknown) => toast({ title: `Couldn't ${what} it`, description: toApiError(e).message, status: "error" });
  const bytes = async (): Promise<Blob | undefined> => {
    if (asFile) return fileBytes.bytes();
    if (loaded?.media) return loaded.media;
    return body == null ? undefined : new Blob([body], { type: `${mimeFor(saveName)};charset=utf-8` });
  };
  const browserData = async (): Promise<{ text: string } | { blob: Blob } | undefined> => {
    if (asFile || loaded?.media) {
      const blob = await bytes();
      return blob && { blob };
    }
    if (kind === "svg") return loaded?.imageUrl ? { text: imageDocument(loaded.imageUrl, title) } : undefined;
    if (kind === "mermaid" && text != null) {
      const diagram = await renderDiagram(text, theme);
      if (!diagram.ok) throw new Error(`The diagram doesn't draw: ${diagram.error}`);
      // Drawn in the app's theme: on the figure's own surface, as the expanded view shows it.
      return { text: imageDocument(svgDataUrl(prepareSvg(diagram.svg, figureBackground())?.svg ?? diagram.svg), title) };
    }
    return body == null ? undefined : { text: body };
  };
  const save = () => void bytes().then((blob) => blob && saveBlob(blob, saveName), failed("save"));
  const open = () => void browserData().then((data) => data && openInBrowser(openName, data)).catch(failed("open"));
  return {
    saveName,
    saves,
    opens,
    save,
    open,
    file: asFile ? { name: saveName, source, save: canSave && saves ? save : undefined, open: opens ? open : undefined, blocked, reading: fileBytes.reading } : undefined,
  };
}

/**
 * Copy, Save, Open in browser, Copy path, Mention (Save and Open: `useDocActions`).
 */
function Actions({ doc, loaded, kind, title, review, actions, onLeave }: { doc: DocRef; loaded?: LoadedDoc; kind: PresentKind; title: string; review?: string; actions: DocActions; onLeave?: () => void }) {
  const text = review ?? loaded?.text;
  const url = doc.kind === "local" ? `local://${doc.name}` : (loaded?.content.url ?? undefined);
  const path = loaded?.content.path;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Document actions" size="sm">
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {text != null && (
          <DropdownMenuItem icon={<Copy />} onSelect={() => void copyText(text, title)}>
            Copy {kind === "html" ? "page source" : kind === "svg" || kind === "mermaid" ? "source" : "text"}
          </DropdownMenuItem>
        )}
        {canSave && (
          <DropdownMenuItem icon={<Download />} disabled={!actions.saves} onSelect={actions.save}>
            Save as {actions.saveName}
          </DropdownMenuItem>
        )}
        {actions.opens && (
          <DropdownMenuItem icon={<ExternalLink />} onSelect={actions.open}>
            Open in browser
          </DropdownMenuItem>
        )}
        {(path || url) && <DropdownMenuSeparator />}
        {path && (
          <DropdownMenuItem icon={<FolderInput />} onSelect={() => void copyText(path, "the host path")}>
            Copy path on the host
          </DropdownMenuItem>
        )}
        {url && (
          <DropdownMenuItem
            icon={<AtSign />}
            onSelect={() => {
              mentionArtifact(doc.agentKey, url);
              onLeave?.();
            }}
          >
            Mention in the composer
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Everything a viewer chrome shows for a document: its tile, title, controls and body. */
function usePane(doc: DocRef, from: "split" | "full", onLeave?: () => void): { icon: ReactNode; title: string; controls: ReactNode; body: ReactNode } {
  const { file: listed, files } = useListed(doc);
  const { ui } = useSession(doc.agentKey);
  const plan = doc.kind === "review" && ui?.kind === "planReview" ? (ui.plan ?? undefined) : undefined;
  const state = useLoadedDoc(doc.kind === "review" ? null : doc, listed?.mtime);
  const kind = docKind(doc);
  // The listing knows the other versions and titles: ask for it again when a document opens.
  useEffect(() => {
    void refreshArtifacts(doc.agentKey);
  }, [doc.agentKey, doc.name]);
  const base = doc.name.slice(doc.name.lastIndexOf("/") + 1);
  const title = doc.title || plan?.title || listed?.title || base || "Plan";
  const review = doc.kind === "review" ? (plan?.content ?? "") : undefined;
  const actions = useDocActions(doc, state.doc, kind, title, review);
  return {
    icon: <KindTile kind={actions.file ? "file" : kind} />,
    title,
    controls: (
      <>
        <Versions doc={doc} files={files} from={from} />
        <Actions doc={doc} loaded={state.doc} kind={kind} title={title} review={review} actions={actions} onLeave={onLeave} />
      </>
    ),
    body: <ArtifactBody title={title} kind={kind} state={state} review={doc.kind === "review" && !plan ? "_This plan review was answered._" : review} file={actions.file} />,
  };
}

/** The split panel beside a session (`SplitState` kind `artifact`). */
export function ArtifactSplit({ split }: { split: Extract<SplitState, { kind: "artifact" }> }) {
  const doc = docOf(split);
  const pane = usePane(doc, "split");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SplitHeaderRow icon={pane.icon} title={<span title={`${KIND_LABEL[docKind(doc)]} · ${doc.name || "plan under review"}`}>{pane.title}</span>} onExpand={() => showFullscreen(doc)} expandLabel="Full screen">
        {pane.controls}
      </SplitHeaderRow>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-deep/40">{pane.body}</div>
    </div>
  );
}

/** The document shown full screen (phones: every document; desktop: from the panel). */
export function ArtifactFull({ doc }: { doc: DocRef }) {
  const mobile = useIsMobile();
  const pane = usePane(doc, "full", closeFullscreen);
  const open = useFullscreenDoc((s) => s.doc != null);
  return (
    <FullscreenFrame open={open} onClose={closeFullscreen} label={pane.title} icon={pane.icon} title={pane.title} actions={pane.controls}>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", !mobile && "bg-bg-deep/40")}>{pane.body}</div>
    </FullscreenFrame>
  );
}
