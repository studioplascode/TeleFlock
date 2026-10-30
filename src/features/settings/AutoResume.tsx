import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { core, toApiError, useHostIds, useHosts } from "@/core";
import type { AutoResumeConfig, AutoResumeSetParams } from "@/core/gen";
import { Switch, toast } from "@/design";
import { autoResumeDescription, bootServiceAvailable, bringBackDescription } from "./autoResumeText";
import { Row, Section } from "./parts";

/**
 * Per host: resume agents stopped on a provider usage or rate limit, and bring agents back after a
 * reboot (`host.autoResume`, `host.autoResumeSet`).
 */
export function AutoResumeSettings({ index }: { index: number }) {
  const ids = useHostIds();
  return (
    <Section
      index={index}
      icon={<RotateCw />}
      title="Auto-resume after usage limits"
      description="When agents stop on a provider usage or rate limit, this host resumes them and their subagents once usage is back, and keeps those limit errors out of what they see."
    >
      {ids.length === 0 ? <p className="py-2 text-sm text-mute-2">No hosts yet.</p> : ids.map((id) => <HostRows key={id} hostId={id} />)}
    </Section>
  );
}

function HostRows({ hostId }: { hostId: string }) {
  const name = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const online = useHosts((h) => h.status[hostId]?.phase === "online");
  const [config, setConfig] = useState<AutoResumeConfig | null>(null);
  const [old, setOld] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!online) return;
    let live = true;
    core
      .host(hostId)
      .call("host.autoResume", {})
      .then(
        (c) => {
          if (!live) return;
          setConfig(c);
          setOld(false);
          setError(null);
        },
        (e: unknown) => {
          if (!live) return;
          const err = toApiError(e);
          if (err.code === "unknown_method") setOld(true);
          else setError(err.message);
        },
      );
    return () => {
      live = false;
    };
  }, [hostId, online]);

  const save = async (patch: AutoResumeSetParams, what: string) => {
    setSaving(true);
    try {
      setConfig(await core.host(hostId).call("host.autoResumeSet", patch));
    } catch (e) {
      const err = toApiError(e);
      toast({ title: `Couldn't change ${what}`, description: err.hint ? `${err.message} — ${err.hint}` : err.message, status: "error" });
    } finally {
      setSaving(false);
    }
  };

  const disabled = !online || old || config === null || saving;
  const description = !online ? "Connect the host to change it." : old ? "Update TeleFlock on this host" : (error ?? (config === null ? "Checking…" : autoResumeDescription(config)));
  // A host from before the setting reports none: its boot service is not switchable from here.
  const bringBack = config?.bringBack;
  // What this host can really do (`bootService`, from its scheduler's status): systemd with root or
  // lingering only; macOS, Windows and Linux without systemd have no boot service to install.
  const bootAvailable = bootServiceAvailable(config);
  const bringBackText = !online
    ? "Connect the host to change it."
    : old || error !== null || config === null || bringBack === undefined
      ? "Needs a newer TeleFlock on this host."
      : bringBackDescription(config);
  return (
    <>
      <Row label={name} description={description}>
        <Switch checked={config?.enabled === true} disabled={disabled} onCheckedChange={(on) => void save({ enabled: on }, "auto-resume")} label={`Auto-resume after usage limits on ${name}`} />
      </Row>
      <Row label="Bring agents back after a reboot" description={bringBackText}>
        <Switch
          checked={bringBack === true && bootAvailable}
          disabled={disabled || bringBack === undefined || !bootAvailable}
          onCheckedChange={(on) => void save({ bringBack: on }, "the boot service")}
          label={`Bring agents back after a reboot on ${name}`}
        />
      </Row>
    </>
  );
}
