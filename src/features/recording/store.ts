import { create } from "zustand";
import { core, onAppEvent, toApiError } from "@/core";
import type { RecordingInfo, RecordingList } from "@/core/gen";

/*
 * The recordings on this device (`recording.list`, then `AppEvent::Recordings` after every change)
 * and which one the review sheet shows.
 */

interface RecordingsState {
  list: RecordingList | null;
  /** The app core can't record (an older or browser-less backend): why. */
  unsupported: string | null;
  /** The recording the review sheet shows. */
  reviewing: string | null;
  /** The Recordings dialog is open. */
  listOpen: boolean;
}

export const useRecordings = create<RecordingsState>(() => ({ list: null, unsupported: null, reviewing: null, listOpen: false }));

let started = false;

/** Loads the list once and follows its changes (idempotent). */
export function startRecordings(): void {
  if (started) return;
  started = true;
  onAppEvent((e) => {
    if (e.type === "recordings") useRecordings.setState({ list: e.recordings, unsupported: null });
  });
  void refreshRecordings();
}

export async function refreshRecordings(): Promise<void> {
  try {
    useRecordings.setState({ list: await core.app("recording.list", {}), unsupported: null });
  } catch (e) {
    const err = toApiError(e);
    if (err.code === "unknown_method" || err.code === "unsupported") useRecordings.setState({ unsupported: err.message });
  }
}

/** One recording, live. */
export function useRecording(id: string | null): RecordingInfo | undefined {
  return useRecordings((s) => (id ? s.list?.recordings.find((r) => r.id === id) : undefined));
}

export function openReview(id: string): void {
  useRecordings.setState({ reviewing: id, listOpen: false });
}

export function closeReview(): void {
  useRecordings.setState({ reviewing: null });
}

export function openRecordingsList(open = true): void {
  useRecordings.setState({ listOpen: open });
}

/** A recording's info as the list has it right now (outside React). */
export function recordingInfo(id: string): RecordingInfo | undefined {
  return useRecordings.getState().list?.recordings.find((r) => r.id === id);
}
