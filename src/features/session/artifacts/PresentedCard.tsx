import { ChevronRight, PanelRight } from "lucide-react";
import { useContext } from "react";
import type { PresentedArtifact, ToolItem } from "@/core/gen";
import { cn, useIsMobile } from "@/design";
import { SessionCtx } from "../context";
import { formatBytes } from "./artifacts";
import { KIND_ICON, KIND_TONE } from "./ArtifactView";
import { KIND_LABEL } from "./kinds";
import type { DocRef } from "./load";
import { openDoc, useShownInSplit } from "./viewer";

/** The document a `present` row shows, as the viewer opens it. */
export function presentedDoc(agentKey: string, a: PresentedArtifact): DocRef {
  return { agentKey, kind: "local", name: a.name, as: a.kind, title: a.title, language: a.language };
}

/**
 * A document the agent presented (`present`, bridge ≥ 2.3.0), in the transcript: its kind, title,
 * version and size; Open shows it in the panel beside the session (full screen on a phone).
 */
export function PresentedCard({ item, artifact }: { item: ToolItem; artifact: PresentedArtifact }) {
  const session = useContext(SessionCtx);
  const mobile = useIsMobile();
  const shown = useShownInSplit(session?.key, artifact.name);
  const Icon = KIND_ICON[artifact.kind];
  const facts = [KIND_LABEL[artifact.kind], `version ${artifact.version}`, formatBytes(artifact.size), artifact.assets > 0 && `${artifact.assets} file${artifact.assets === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-presented={artifact.slug}
      disabled={!session}
      onClick={() => session && openDoc(presentedDoc(session.key, artifact), mobile)}
      aria-label={`Open ${artifact.title} (${facts})`}
      title={item.intent ?? artifact.source ?? artifact.url}
      className={cn(
        "group focus-ring pressable flex w-full min-w-0 items-center gap-3 rounded-[16px] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-accent)_9%,var(--color-bg-deep)),color-mix(in_srgb,var(--color-bg-deep)_92%,transparent))] px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_24%,var(--color-line))] transition-shadow hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_45%,var(--color-line)),0_0_28px_-14px_color-mix(in_srgb,var(--color-accent)_70%,transparent)] max-md:gap-2.5 max-md:px-2.5 max-md:py-2",
        shown && "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-accent)_60%,transparent)]",
      )}
    >
      <span className={cn("grid size-10 shrink-0 place-items-center rounded-[12px] max-md:size-9", KIND_TONE[artifact.kind])} aria-hidden>
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-bold text-ink">{artifact.title}</span>
        <span className="block truncate text-[11.5px] font-semibold text-mute-2 tabular">{facts}</span>
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-bold transition-colors",
          shown ? "bg-accent/15 text-accent-hi" : "bg-ink/[0.06] text-ink-2 group-hover:bg-accent/15 group-hover:text-accent-hi",
        )}
      >
        {shown ? <PanelRight className="size-3.5" /> : null}
        {shown ? "Showing" : "Open"}
        {!shown && <ChevronRight className="size-3.5" />}
      </span>
    </button>
  );
}
