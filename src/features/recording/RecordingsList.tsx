import { MonitorPlay, MoreHorizontal, Trash2 } from "lucide-react";
import { core, toApiError } from "@/core";
import type { RecordingInfo } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, IconButton, toast } from "@/design";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { formatLength } from "./timeline";
import { useRecordings } from "./store";

/** Where a recording stands, in a few words. */
export function recordingStateText(r: RecordingInfo): string {
  switch (r.state) {
    case "recording":
      return "recording";
    case "paused":
      return "paused";
    case "processing":
      return "saving";
    case "failed":
      return r.message ? `failed: ${r.message}` : "failed";
    case "ready":
      switch (r.transcript.state) {
        case "waiting":
          return "transcribing soon";
        case "running":
          return `transcribing ${Math.round((r.transcript.progress ?? 0) * 100)}%`;
        case "noModel":
          return "no transcript: no speech model";
        case "failed":
          return "no transcript: it failed";
        default:
          return r.voice.state === "on" ? "transcribed" : "no voice";
      }
  }
}

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? `today ${time}` : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/**
 * Deletes a recording after the app's standard confirm, which names what is lost. False when they
 * declined or the delete failed; `onConfirmed` runs once they agreed (the review sheet closes then).
 */
export async function deleteRecording(r: Pick<RecordingInfo, "id" | "title">, onConfirmed?: () => void): Promise<boolean> {
  if (!(await confirmAction({ title: "Delete this recording?", body: "Its video, voice and timeline are removed from this computer.", confirmLabel: "Delete", danger: true }))) return false;
  onConfirmed?.();
  try {
    await core.app("recording.delete", { id: r.id });
    toast({ title: "Recording deleted", description: r.title, status: "done", duration: 2600 });
    return true;
  } catch (e) {
    toast({ title: "Couldn't delete the recording", description: toApiError(e).message, status: "error" });
    return false;
  }
}

/** The recordings on this device: open one to review and send it, or delete it; and the space they take. */
export function RecordingsList({ onOpen, className }: { onOpen(id: string): void; className?: string }) {
  const list = useRecordings((s) => s.list);
  const unsupported = useRecordings((s) => s.unsupported);
  if (unsupported) return <p className="text-sm text-mute">{unsupported}</p>;
  if (!list) return <p className="text-sm text-mute">Loading…</p>;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {list.recordings.length === 0 ? (
        <EmptyState icon={<MonitorPlay />} title="No recordings" description="Press Record in the browser's toolbar, then walk through the problem and say what you see." />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.recordings.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-[12px] bg-tile-4 py-2 pr-1.5 pl-3 shadow-hairline">
              <MonitorPlay className="size-4 shrink-0 text-accent-hi" aria-hidden />
              <button type="button" className="focus-ring min-w-0 flex-1 rounded-md text-left" onClick={() => onOpen(r.id)} disabled={r.state === "recording" || r.state === "paused"}>
                <span className="block truncate text-[13px] font-bold text-ink">{r.title}</span>
                <span className="block truncate text-[11.5px] font-semibold text-mute tabular-nums">
                  {when(r.createdAt)} · {formatLength(r.durationMs)} · {formatBytes(r.bytes)} · {recordingStateText(r)}
                </span>
              </button>
              <Button size="sm" variant="secondary" onClick={() => onOpen(r.id)} disabled={r.state === "recording" || r.state === "paused"}>
                Review
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label={`More for ${r.title}`} size="sm">
                    <MoreHorizontal />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => void deleteRecording(r)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11.5px] font-medium text-mute">
        {formatBytes(list.bytes)} of {formatBytes(list.budget)} used. Recordings stay on this device until you send one; the oldest are never deleted by themselves, so delete what you no longer need.
      </p>
    </div>
  );
}
