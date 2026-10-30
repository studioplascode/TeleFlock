import { Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { useHostIds, useHosts } from "@/core";
import type { AutoAnswer } from "@/core/gen";
import { Button } from "@/design";
import { Section } from "@/features/settings/parts";
import { setHostAutoAnswer, useAutoAnswerPending } from "./actions";
import { policySummary, samePolicy } from "./format";
import { useHostAutoAnswer } from "./hooks";
import { PolicyEditor, QUALIFIES_NOTE } from "./PolicyEditor";

/**
 * Settings → Decide for me: each host's default (`host.autoAnswerSet`, `HostInfo.autoAnswer`) for
 * agents without their own policy. Edits wait for Save: a shorter wait applies to the questions
 * already waiting, so a half-typed number must never reach the host.
 */
export function AutoAnswerSettings({ index }: { index: number }) {
  const ids = useHostIds();
  return (
    <Section index={index} icon={<Timer />} title="Decide for me" description={`${QUALIFIES_NOTE} An agent's own setting (Agent options, or Decide for me… in its menu) comes first.`}>
      {ids.length === 0 ? <p className="py-2 text-sm text-mute-2">No hosts yet.</p> : ids.map((id) => <HostRow key={id} hostId={id} />)}
    </Section>
  );
}

function HostRow({ hostId }: { hostId: string }) {
  const name = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const online = useHosts((h) => h.status[hostId]?.phase === "online");
  const current = useHostAutoAnswer(hostId);
  const pending = useAutoAnswerPending(`host:${hostId}`);
  // unsaved edits; dropped once the host publishes the same policy (after Save, or from another device)
  const [draft, setDraft] = useState<AutoAnswer | undefined>();
  useEffect(() => {
    setDraft((d) => (d && samePolicy(d, current) ? undefined : d));
  }, [current]);
  const dirty = !!draft && !samePolicy(draft, current);

  const status = !current
    ? online
      ? "Update TeleFlock on this host"
      : "Connect the host to change it."
    : !online
      ? `${current.enabled ? `Picks ★ ${policySummary(current)}` : "Off"} · connect the host to change it.`
      : current.enabled
        ? `Agents without their own setting: ★ is picked ${policySummary(current)}.`
        : "Off: questions wait for you, unless an agent has its own setting.";
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-1 last:pb-1 max-md:py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-bold text-ink">{name}</div>
        <div className="text-xs text-mute">{status}</div>
      </div>
      {current && online && (
        <>
          <PolicyEditor value={draft ?? current} onChange={(v) => v && setDraft(v)} disabled={pending} />
          {draft && dirty && (
            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={pending} onClick={() => void setHostAutoAnswer(hostId, draft)}>
                Save
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDraft(undefined)}>
                Undo
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
