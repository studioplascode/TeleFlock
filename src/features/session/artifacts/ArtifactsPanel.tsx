import { AtSign, Bot, ClipboardList, Copy, FileText, FolderInput, RefreshCw, Send } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toApiError, useAgent, useSession } from "@/core";
import type { ArtifactContent } from "@/core/gen";
import { BottomSheet, Button, cn, Dialog, DialogContent, EmptyState, formatAge, IconButton, Skeleton, useIsMobile, useNow } from "@/design";
import { Markdown } from "../markdown/Markdown";
import {
  type ArtifactGroup,
  type ArtifactList,
  type ArtifactRow,
  type ArtifactSection,
  artifactRows,
  copyText,
  formatBytes,
  mentionArtifact,
  readArtifact,
  refreshArtifacts,
  SECTION_LABEL,
  useArtifactList,
} from "./artifacts";

const ICON: Record<ArtifactSection, ReactNode> = {
  review: <ClipboardList />,
  plans: <ClipboardList />,
  notes: <FileText />,
  outputs: <Bot />,
  handoffs: <Send />,
};

/** The agent's artifacts, listed now and again whenever a turn ends, a subagent finishes or a plan review opens. */
function useArtifacts(agentKey: string) {
  const agent = useAgent(agentKey);
  const { meta, ui } = useSession(agentKey);
  const list = useArtifactList(agentKey);
  const turnEnded = agent?.omp?.lastTurnEndedAt;
  const subsSettled = meta?.subagents.filter((s) => s.status !== "running").length ?? 0;
  const review = ui?.kind === "planReview" ? (ui.plan ?? undefined) : undefined;
  const reviewPath = review?.path;
  useEffect(() => {
    void refreshArtifacts(agentKey);
  }, [agentKey, turnEnded, subsSettled, reviewPath]);
  return { list, groups: artifactRows(list.data?.files ?? [], review) };
}

/** Desktop rail: hidden until the session has an artifact or a plan under review. */
export function ArtifactsPanel({ agentKey }: { agentKey: string }) {
  const { list, groups } = useArtifacts(agentKey);
  if (groups.length === 0) return null;
  return <ArtifactsSection agentKey={agentKey} list={list} groups={groups} />;
}

/** Mobile inspector tab: the list, or why there is none. */
export function ArtifactsTab({ agentKey }: { agentKey: string }) {
  const { list, groups } = useArtifacts(agentKey);
  if (groups.length > 0) return <ArtifactsSection agentKey={agentKey} list={list} groups={groups} />;
  if (list.error)
    return (
      <EmptyState
        compact
        title={list.error.code === "unknown_method" ? "Update this host to see artifacts" : "Couldn't list artifacts"}
        description={list.error.code === "unknown_method" ? "Its TeleFlock host daemon predates the artifacts list." : list.error.hint ? `${list.error.message} — ${list.error.hint}` : list.error.message}
      />
    );
  if (!list.data) return <Skeleton className="h-28 rounded-[22px]" />;
  return <EmptyState compact title="No artifacts yet" description="Plans, reports and handoffs the agent and its subagents write to local://, subagent outputs and saved handoffs show up here." />;
}

function ArtifactsSection({ agentKey, list, groups }: { agentKey: string; list: ArtifactList; groups: ArtifactGroup[] }) {
  const [open, setOpen] = useState<ArtifactRow | null>(null);
  const now = useNow(60_000);
  const files = list.data?.files.length ?? 0;
  return (
    <section data-panel="artifacts" aria-label="Artifacts" className="rounded-[22px] glass px-4 py-3.5 transition-shadow duration-500">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="kicker">Artifacts</div>
        <span className="flex items-center gap-1 text-[11px] font-bold text-mute">
          {files} file{files === 1 ? "" : "s"}
          {list.data?.truncated && "+"}
          <IconButton label="List again" size="sm" className="-my-1 -mr-1.5" onClick={() => void refreshArtifacts(agentKey, true)}>
            <RefreshCw className={cn(list.loading && "opacity-40")} />
          </IconButton>
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {groups.map((g) => (
          <div key={g.section}>
            <div className="mb-0.5 px-1.5 text-[10px] font-extrabold tracking-[0.08em] text-mute-2 uppercase">{SECTION_LABEL[g.section]}</div>
            <div className="flex flex-col gap-0.5">
              {g.rows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setOpen(r)}
                  title={r.ref}
                  className={cn(
                    "focus-ring pressable flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-white/[0.04] [&>svg]:size-3.5 [&>svg]:shrink-0",
                    r.section === "review" ? "bg-accent/10 text-accent-hi shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]" : "text-mute-2",
                  )}
                >
                  {ICON[r.section]}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold text-ink-2">{r.title}</span>
                    <span className="block truncate font-mono text-[10.5px] text-mute-2">{r.ref}</span>
                  </span>
                  <span className="shrink-0 text-right text-[10.5px] leading-tight font-semibold text-mute-2 tabular">
                    {r.file ? formatBytes(r.file.size) : "review"}
                    {r.file && <span className="block">{formatAge(now - r.file.mtime)}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {open && <ArtifactViewer agentKey={agentKey} row={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** One artifact in full: rendered Markdown (else plain text), Copy, Copy path, Mention in the composer. */
function ArtifactViewer({ agentKey, row, onClose }: { agentKey: string; row: ArtifactRow; onClose: () => void }) {
  const mobile = useIsMobile();
  const [state, setState] = useState<{ content?: ArtifactContent; error?: string }>({});
  const file = row.file;
  const review = row.review;
  useEffect(() => {
    if (review || !file) return;
    let live = true;
    readArtifact(agentKey, file).then(
      (content) => live && setState({ content }),
      (e: unknown) => live && setState({ error: toApiError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [agentKey, file, review]);
  const text = review ? review.content : state.content?.text;
  const path = state.content?.path;
  const markdown = review !== undefined || /\.mdx?$/i.test(file?.name ?? "");
  const mention = row.ref.includes("://") ? row.ref : undefined;
  const description = [row.ref, file && formatBytes(file.size), state.content?.truncated && "showing the first 1 MB"].filter(Boolean).join(" · ");
  const body = state.error ? (
    <EmptyState compact title="Couldn't read it" description={state.error} />
  ) : text == null ? (
    state.content?.binary ? (
      <EmptyState compact title="Not a text file" description={`${formatBytes(state.content.size)} · ${state.content.path}`} />
    ) : (
      <Skeleton className="h-40 rounded-lg" />
    )
  ) : markdown ? (
    <div className="text-[13.5px] leading-relaxed">
      <Markdown text={text} />
    </div>
  ) : (
    <pre className="font-mono text-[12px] break-words whitespace-pre-wrap text-ink-2">{text}</pre>
  );
  const actions = (
    <>
      {text != null && (
        <Button size="sm" icon={<Copy />} onClick={() => void copyText(text, row.title)}>
          Copy
        </Button>
      )}
      {path && (
        <Button size="sm" variant="ghost" icon={<FolderInput />} onClick={() => void copyText(path, "the host path")}>
          Copy path
        </Button>
      )}
      {mention && (
        <Button
          size="sm"
          variant="primary"
          icon={<AtSign />}
          title={`Add ${mention} to the composer`}
          onClick={() => {
            mentionArtifact(agentKey, mention);
            onClose();
          }}
        >
          Mention
        </Button>
      )}
    </>
  );
  if (mobile)
    return (
      <BottomSheet open onOpenChange={(o) => !o && onClose()} title={row.title} description={description} maxHeight="92dvh" footer={<div className="flex flex-wrap justify-end gap-2">{actions}</div>}>
        {body}
      </BottomSheet>
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={row.title} description={description} width={860} footer={actions}>
        {body}
      </DialogContent>
    </Dialog>
  );
}
