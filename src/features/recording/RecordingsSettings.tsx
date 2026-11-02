import { MonitorPlay } from "lucide-react";
import { Section } from "@/features/settings/parts";
import { RecordingDialogs } from "./RecordingDialogs";
import { RecordingsList } from "./RecordingsList";
import { openReview } from "./store";

/** Settings → Recordings: the browser recordings kept on this device, to review, send or delete. */
export function RecordingsSettings({ index }: { index: number }) {
  return (
    <Section index={index} icon={<MonitorPlay />} title="Recordings" description="Walkthroughs recorded in the TeleFlock Browser: video, what you said, what you did and what failed. Kept on this device until you send one.">
      <RecordingsList onOpen={openReview} className="py-3 first:pt-1 last:pb-1" />
      <RecordingDialogs />
    </Section>
  );
}
