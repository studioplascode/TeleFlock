import { Circle, Eye, ListVideo, Mic, MicOff, MoreHorizontal, Pause, Play, Square, Trash2 } from "lucide-react";
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, Spinner, Tooltip, useNow } from "@/design";
import type { ToolbarItemProps } from "@/features/browser/observe";
import { RecordingDialogs } from "./RecordingDialogs";
import { discardRecording, pauseRecording, recordingClock, resumeRecording, startRecording, stopRecording, useRecorder } from "./recorder";
import { openRecordingsList } from "./store";

/**
 * The browser toolbar's Record control: Record; while recording a red pill with the clock and the
 * microphone's state, Pause/Resume and Stop; a menu with the saved recordings. An agent's tab shown
 * meanwhile is said to be left out.
 */
export function RecordControl({ tabId, compact }: ToolbarItemProps) {
  const st = useRecorder();
  const live = st.phase === "recording" || st.phase === "paused";
  const now = useNow(st.phase === "recording" ? 250 : null);
  const voiceOn = st.voice?.state === "on";
  return (
    <>
      {st.phase === "idle" || st.phase === "starting" ? (
        <Tooltip content="Record what you do and say in your tabs, to send to an agent">
          {compact ? (
            <IconButton label="Record" size="sm" disabled={!tabId || st.phase === "starting"} onClick={() => void startRecording()}>
              {st.phase === "starting" ? <Spinner /> : <Circle className="fill-current text-error" />}
            </IconButton>
          ) : (
            <Button size="sm" variant="ghost" disabled={!tabId || st.phase === "starting"} loading={st.phase === "starting"} icon={<Circle className="fill-current text-error" />} onClick={() => void startRecording()}>
              Record
            </Button>
          )}
        </Tooltip>
      ) : st.phase === "stopping" ? (
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-ink/8 px-2.5 text-[11.5px] font-bold text-ink-2">
          <Spinner className="size-3.5" />
          Saving…
        </span>
      ) : (
        <span role="status" aria-label={st.phase === "paused" ? "Recording paused" : "Recording"} className={cn("flex h-7 shrink-0 items-center gap-1 rounded-full pr-0.5 pl-2.5", st.phase === "paused" ? "bg-ink/10" : "bg-error/15")}>
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", st.phase === "paused" ? "bg-mute" : "bg-error")} />
          <span className={cn("text-[11.5px] font-bold tabular-nums", st.phase === "paused" ? "text-ink-2" : "text-error")}>{st.phase === "paused" ? `Paused ${recordingClock(st, now)}` : recordingClock(st, now)}</span>
          <Tooltip content={voiceOn ? "Your microphone is recorded" : `No voice: ${st.voice?.message ?? "the microphone isn't recorded"}`}>
            <span className="grid size-6 place-items-center text-ink-2 [&_svg]:size-3.5" aria-label={voiceOn ? "Microphone on" : "Microphone off"}>
              {voiceOn ? <Mic /> : <MicOff />}
            </span>
          </Tooltip>
          {st.watching && (
            <Tooltip content={`The tab of ${st.watching} is shown: agents' tabs are not recorded`}>
              <span className="flex items-center gap-1 text-[11px] font-semibold text-mute [&_svg]:size-3.5">
                <Eye />
                {!compact && "not recorded"}
              </span>
            </Tooltip>
          )}
          {st.phase === "paused" ? (
            <IconButton label="Resume recording" size="sm" onClick={() => void resumeRecording()}>
              <Play />
            </IconButton>
          ) : (
            <IconButton label="Pause recording" size="sm" onClick={() => void pauseRecording()}>
              <Pause />
            </IconButton>
          )}
          <IconButton label="Stop and review" size="sm" onClick={() => void stopRecording()}>
            <Square className="fill-current" />
          </IconButton>
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="Recordings" size="sm">
            {live ? <MoreHorizontal /> : <ListVideo />}
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<ListVideo />} onSelect={() => openRecordingsList()}>
            Recordings…
          </DropdownMenuItem>
          {st.phase === "idle" && (
            <DropdownMenuItem icon={<MicOff />} disabled={!tabId} onSelect={() => void startRecording(false)}>
              Record without voice
            </DropdownMenuItem>
          )}
          {live && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => void discardRecording()}>
                Discard this recording
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <RecordingDialogs />
    </>
  );
}
