import { MonitorPlay } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent } from "@/design";
import { RecordingsList } from "./RecordingsList";
import { ReviewSheet } from "./ReviewSheet";
import { openRecordingsList, openReview, startRecordings, useRecordings } from "./store";

/*
 * The review sheet and the Recordings dialog, rendered by whichever surface that offers them is on
 * screen (the browser toolbar, Settings → Recordings): the first one mounted shows them, so two
 * surfaces never open them twice.
 */

const holders: symbol[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function RecordingDialogs() {
  const [me] = useState(() => Symbol("recording-dialogs"));
  useEffect(() => {
    startRecordings();
    holders.push(me);
    changed();
    return () => {
      holders.splice(holders.indexOf(me), 1);
      changed();
    };
  }, [me]);
  const shows = useSyncExternalStore(subscribe, () => holders[0] === me);
  const reviewing = useRecordings((s) => s.reviewing);
  const listOpen = useRecordings((s) => s.listOpen);
  if (!shows) return null;
  return (
    <>
      {reviewing && <ReviewSheet key={reviewing} id={reviewing} />}
      {listOpen && (
        <Dialog open onOpenChange={(o) => !o && openRecordingsList(false)}>
          <DialogContent width={640} icon={<MonitorPlay />} title="Recordings" description="What you recorded in the browser, kept on this device.">
            <RecordingsList onOpen={openReview} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
