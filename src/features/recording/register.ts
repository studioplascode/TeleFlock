import { registerUploadSource } from "@/core/draftUploads";
import { recordingSource } from "./send";

/*
 * A recording attached to a composer draft comes back after a restart (its files are still on this
 * device): imported at app start, before drafts load, and by the recording feature itself.
 */

registerUploadSource("recording", recordingSource);
