import { create } from "zustand";
import { type SplitState, useUi } from "@/core";
import type { DocRef } from "./load";

/**
 * Where a session's documents open (architecture "Presented artifacts"): one viewer, shown in the
 * split panel beside the session on desktop (`SplitState` kind `artifact`), or full screen: on
 * phones, in focus mode, and from the panel's Full screen button.
 */

type ArtifactSplit = Extract<SplitState, { kind: "artifact" }>;

/** The document shown full screen, if any (mounted once: `ArtifactOverlay`). */
export const useFullscreenDoc = create<{ doc: DocRef | null }>()(() => ({ doc: null }));

export function showFullscreen(doc: DocRef): void {
  useFullscreenDoc.setState({ doc });
}

export function closeFullscreen(): void {
  useFullscreenDoc.setState({ doc: null });
}

export function splitOf(doc: DocRef): ArtifactSplit {
  return { kind: "artifact", key: doc.agentKey, file: doc.kind, name: doc.name, as: doc.as, title: doc.title, language: doc.language };
}

export function docOf(split: ArtifactSplit): DocRef {
  return { agentKey: split.key, kind: split.file, name: split.name, as: split.as, title: split.title, language: split.language };
}

/** Opens a document: in the panel beside the session on desktop, full screen on phones and in focus mode. */
export function openDoc(doc: DocRef, mobile: boolean): void {
  const ui = useUi.getState();
  if (mobile || ui.focusMode) showFullscreen(doc);
  else ui.setSplit(splitOf(doc));
}

/** Shows another document (a version) where `from` is shown: the panel, or full screen. */
export function switchDoc(from: "split" | "full", doc: DocRef): void {
  if (from === "full") showFullscreen(doc);
  else useUi.getState().setSplit(splitOf(doc));
}

/** Whether this document is the one in the panel (its card in the transcript shows that). */
export function useShownInSplit(agentKey: string | undefined, name: string): boolean {
  return useUi((s) => s.split?.kind === "artifact" && s.split.key === agentKey && s.split.name === name);
}
