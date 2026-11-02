import { AtSign, Check, ChevronDown, Copy, Download, ExternalLink, FolderInput, MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { type SplitState, toApiError, useSession } from "@/core";
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
} from "@/design";
import { FullscreenFrame } from "@/features/shell/FullscreenFrame";
import { SplitHeaderRow } from "@/features/shell/SplitHeaderRow";
import { copyText, mentionArtifact, refreshArtifacts, useArtifactList } from "./artifacts";
import { ArtifactBody, KIND_ICON, KIND_TONE } from "./ArtifactView";
import { KIND_LABEL, mimeFor, presentedName, presentedVersions } from "./kinds";
import { type DocRef, docFileName, docKind, type LoadedDoc, otherVersion, useLoadedDoc } from "./load";
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

/**
 * Copy, Save, Open in browser, Copy path, Mention. Save and Open write the document under the name
 * `docFileName` gives it: a page as its copy with the policy first, a drawing (Open) as a page that
 * shows it as an image, everything else as its bytes or text.
 */
function Actions({ doc, loaded, kind, title, review, onLeave }: { doc: DocRef; loaded?: LoadedDoc; kind: PresentKind; title: string; review?: string; onLeave?: () => void }) {
  const text = review ?? loaded?.text;
  const url = doc.kind === "local" ? `local://${doc.name}` : (loaded?.content.url ?? undefined);
  const path = loaded?.content.path;
  const file = docFileName(doc, kind, "save");
  // A page never leaves the viewer without its policy.
  const page = kind === "html" && text != null ? (loaded?.standalone ?? standaloneDocument(text, new Map())) : undefined;
  const image = kind === "image" ? loaded?.content.data : undefined;
  const bytes = (): Blob | undefined => {
    if (image) return new Blob([Uint8Array.from(atob(image), (c) => c.charCodeAt(0))], { type: mimeFor(file) });
    const body = kind === "html" ? page : kind === "image" ? undefined : text;
    return body == null ? undefined : new Blob([body], { type: `${mimeFor(file)};charset=utf-8` });
  };
  const browserData = (): { text: string } | { base64: string } | undefined => {
    if (kind === "image") return image ? { base64: image } : undefined;
    if (kind === "svg") return loaded?.imageUrl ? { text: imageDocument(loaded.imageUrl, title) } : undefined;
    const body = kind === "html" ? page : text;
    return body == null ? undefined : { text: body };
  };
  const open = browserData();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Document actions" size="sm">
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {text != null && kind !== "image" && (
          <DropdownMenuItem icon={<Copy />} onSelect={() => void copyText(text, title)}>
            Copy {kind === "html" ? "page source" : "text"}
          </DropdownMenuItem>
        )}
        {canSave && (
          <DropdownMenuItem
            icon={<Download />}
            disabled={!loaded && review === undefined}
            onSelect={() => {
              const blob = bytes();
              if (blob) saveBlob(blob, file);
            }}
          >
            Save as {file}
          </DropdownMenuItem>
        )}
        {canOpenInBrowser() && open && (
          <DropdownMenuItem
            icon={<ExternalLink />}
            onSelect={() =>
              void openInBrowser(docFileName(doc, kind, "open"), open).catch((e: unknown) => toast({ title: "Couldn't open it", description: toApiError(e).message, status: "error" }))
            }
          >
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
  const { file, files } = useListed(doc);
  const { ui } = useSession(doc.agentKey);
  const plan = doc.kind === "review" && ui?.kind === "planReview" ? (ui.plan ?? undefined) : undefined;
  const state = useLoadedDoc(doc.kind === "review" ? null : doc, file?.mtime);
  const kind = docKind(doc);
  // The listing knows the other versions and titles: ask for it again when a document opens.
  useEffect(() => {
    void refreshArtifacts(doc.agentKey);
  }, [doc.agentKey, doc.name]);
  const base = doc.name.slice(doc.name.lastIndexOf("/") + 1);
  const title = doc.title || plan?.title || file?.title || base || "Plan";
  const review = doc.kind === "review" ? (plan?.content ?? "") : undefined;
  return {
    icon: <KindTile kind={kind} />,
    title,
    controls: (
      <>
        <Versions doc={doc} files={files} from={from} />
        <Actions doc={doc} loaded={state.doc} kind={kind} title={title} review={review} onLeave={onLeave} />
      </>
    ),
    body: <ArtifactBody title={title} kind={kind} state={state} review={doc.kind === "review" && !plan ? "_This plan review was answered._" : review} />,
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
