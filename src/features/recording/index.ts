import { registerBrowserToolbarItem } from "@/features/browser/observe";
import { RecordControl } from "./RecordControl";
import "./register";

/*
 * Session recording in the TeleFlock Browser (docs/architecture.md §6.15). Imported by the browser
 * panel: the Record control joins its toolbar.
 */

registerBrowserToolbarItem("recording", RecordControl);

export { RecordingDialogs } from "./RecordingDialogs";
export { startRecording, stopRecording, useRecorder } from "./recorder";
export { openRecordingsList, openReview } from "./store";
