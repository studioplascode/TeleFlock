import { Terminal } from "lucide-react";
import { useCore, useHostIds, useHosts } from "@/core";
import { Switch } from "@/design";
import { shellsText, spanText } from "@/features/cleanup/idleShells";
import { ThresholdSelect, useIdleShellsSave } from "@/features/cleanup/idleShellControls";
import { Row, Section } from "./parts";

/**
 * Per host: close idle shells by itself, and after how long a shell counts as idle (`cleanup.idleShellsSet`,
 * `HostInfo.idleShells`). The host's Cleanup page lists the shells idle now.
 */
export function IdleShellsSettings({ index }: { index: number }) {
  const ids = useHostIds();
  return (
    <Section
      index={index}
      icon={<Terminal />}
      title="Idle shells"
      description="Shells nobody uses: no agent in their workspace, nothing running, no input or output for a while, shown in no terminal. Each host lists them on its Cleanup page and can close them by itself."
    >
      {ids.length === 0 ? <p className="py-2 text-sm text-mute-2">No hosts yet.</p> : ids.map((id) => <HostRows key={id} hostId={id} />)}
    </Section>
  );
}

function HostRows({ hostId }: { hostId: string }) {
  const name = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const online = useHosts((h) => h.status[hostId]?.phase === "online");
  const idle = useCore((s) => s.hosts[hostId]?.state.info.idleShells);
  const { saving, save } = useIdleShellsSave(hostId);
  const disabled = !online || !idle || saving;
  // The host's own notice first: its settings file was unreadable, so closing by itself is off.
  const summary = idle ? (idle.notice ?? (idle.auto ? `Closes shells idle for ${spanText(idle.minutes)} by itself.` : `Off: idle shells stay open${idle.shells.length > 0 ? ` (${shellsText(idle.shells.length)} now)` : ""}.`)) : "";
  const description = !idle ? (online ? "Update TeleFlock on this host" : "Connect the host to change it.") : online ? summary : `${summary} Connect the host to change it.`;
  return (
    <>
      <Row label={name} description={description}>
        <Switch checked={idle?.auto === true} disabled={disabled} onCheckedChange={(auto) => save({ auto })} label={`Close idle shells automatically on ${name}`} />
      </Row>
      {idle && (
        <Row label="Idle after" description="No agent, nothing running and no input or output for this long." htmlFor={`tf-idle-shells-${hostId}`} wide>
          <ThresholdSelect id={`tf-idle-shells-${hostId}`} minutes={idle.minutes} disabled={disabled} onChange={(minutes) => save({ minutes })} className="w-40" />
        </Row>
      )}
    </>
  );
}
