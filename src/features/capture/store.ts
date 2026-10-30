import { create } from "zustand";
import type { DraftImage } from "@/core";
import type { PrefilledTask, TaskSource } from "./task";

/*
 * The prefilled task Dispatch is showing (memory only: the draft itself persists like any draft).
 * `waiting`: no repository was picked yet, so it lands in the thread picked next. `applied`: what
 * it added to which draft, so the banner can say so and "Send to agent…" can take exactly that
 * part out again.
 */

export interface AppliedPrefill {
  id: string;
  /** Dispatch draft key (`dispatchDraftKey`) it went into. */
  key: string;
  source: TaskSource;
  /** The draft's text before and right after it was added. */
  before: string;
  after: string;
  /** The images it added (by identity). */
  images: DraftImage[];
  /** Why images were left out (caps), if any. */
  skipped?: string;
  at: number;
}

interface PrefillState {
  waiting: { id: string; task: PrefilledTask } | null;
  applied: AppliedPrefill | null;
}

export const usePrefill = create<PrefillState>()(() => ({ waiting: null, applied: null }));
