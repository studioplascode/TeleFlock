import { Bot, ClipboardList, FileText, Presentation, RefreshCw, Send } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useAgent, useSession } from "@/core";
import { cn, EmptyState, formatAge, IconButton, Skeleton, useIsMobile, useNow } from "@/design";
import { InspectorCard } from "../inspector/InspectorCard";
import { type ArtifactGroup, type ArtifactList, type ArtifactRow, type ArtifactSection, artifactRows, formatBytes, refreshArtifacts, SECTION_LABEL, useArtifactList } from "./artifacts";
import type { DocRef } from "./load";
import { openDoc } from "./viewer";

const ICON: Record<ArtifactSection, ReactNode> = {
  review: <ClipboardList />,
  presented: <Presentation />,
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

/** The document a row opens in the viewer (the same viewer the transcript's cards open). */
function rowDoc(agentKey: string, r: ArtifactRow): DocRef {
  if (r.review || !r.file) return { agentKey, kind: "review", name: "", title: r.title };
  return { agentKey, kind: r.file.kind, name: r.file.name, title: r.title };
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
  return <EmptyState compact title="No artifacts yet" description="Documents the agent presents, plans, reports and handoffs it and its subagents write to local://, subagent outputs and saved handoffs show up here." />;
}

function ArtifactsSection({ agentKey, list, groups }: { agentKey: string; list: ArtifactList; groups: ArtifactGroup[] }) {
  const mobile = useIsMobile();
  const now = useNow(60_000);
  const files = list.data?.files.length ?? 0;
  return (
    <InspectorCard
      id="artifacts"
      title="Artifacts"
      aside={
        <span className="flex items-center gap-1">
          {files} file{files === 1 ? "" : "s"}
          {list.data?.truncated && "+"}
          <IconButton label="List again" size="sm" className="-my-1 -mr-1.5" onClick={() => void refreshArtifacts(agentKey, true)}>
            <RefreshCw className={cn(list.loading && "opacity-40")} />
          </IconButton>
        </span>
      }
      summary={`${files} file${files === 1 ? "" : "s"}${list.data?.truncated ? "+" : ""}`}
    >
      <div className="flex flex-col gap-2.5">
        {groups.map((g) => (
          <div key={g.section}>
            <div className="mb-0.5 px-1.5 text-[10px] font-extrabold tracking-[0.08em] text-mute-2 uppercase">{SECTION_LABEL[g.section]}</div>
            <div className="flex flex-col gap-0.5">
              {g.rows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => openDoc(rowDoc(agentKey, r), mobile)}
                  title={r.ref}
                  className={cn(
                    "focus-ring pressable flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-ink/[0.04] [&>svg]:size-3.5 [&>svg]:shrink-0",
                    r.section === "review" ? "bg-accent/10 text-accent-hi shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_30%,transparent)]" : "text-mute-2",
                  )}
                >
                  {ICON[r.section]}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold text-ink-2">{r.title}</span>
                    <span className="block truncate font-mono text-[10.5px] text-mute-2">{r.ref}</span>
                  </span>
                  <span className="shrink-0 text-right text-[10.5px] leading-tight font-semibold text-mute-2 tabular">
                    {r.versions && r.versions > 1 ? `${r.versions} versions` : r.file ? formatBytes(r.file.size) : "review"}
                    {r.file && <span className="block">{formatAge(now - r.file.mtime)}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </InspectorCard>
  );
}
