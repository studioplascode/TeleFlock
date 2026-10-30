import { BellRing, EyeOff, Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { Button, Chip, formatAge, IconButton, Switch, toast, useNow } from "@/design";
import { core } from "@/core";
import type { NotifyConfig, PushChannel, PushChannelSave, PushKind } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { openSheet } from "@/features/shell/sheets";
import { kindsLabel, PUSH_KIND_LABEL, PUSH_WHEN_SHORT } from "./alerts";
import { PushChannelForm } from "./PushChannelForm";

/** Runs a host mutation, takes the config it answers with and toasts a failure; resolves whether it worked. */
export type Mutate = (run: () => Promise<NotifyConfig>) => Promise<boolean>;

const KIND_ICON: Record<PushKind, typeof Send> = { ntfy: BellRing, pushover: Send, webhook: Webhook };

/** The non-secret fields of a channel: saving only these keeps every stored secret. */
function plainFields(c: PushChannel, patch: Partial<PushChannelSave>): PushChannelSave {
  return { id: c.id, kind: c.kind, name: c.name, enabled: c.enabled, when: c.when, kinds: c.kinds, private: c.private, ...patch };
}

function LastResult({ last }: { last: NonNullable<PushChannel["last"]> }) {
  const now = useNow(30_000);
  const age = formatAge(now - last.at);
  return last.ok ? (
    <span className="text-xs text-done">
      {last.test ? "Test sent" : "Last push sent"} · {age}
    </span>
  ) : (
    <span className="text-xs text-error">
      {last.test ? "Test failed" : "Last push failed"} · {age}
      {last.error ? `: ${last.error}` : last.status !== undefined ? `: HTTP ${last.status}` : ""}
    </span>
  );
}

function ChannelRow({ hostId, channel, busy, mutate, onConfig }: { hostId: string; channel: PushChannel; busy: boolean; mutate: Mutate; onConfig: (c: NotifyConfig) => void }) {
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const Icon = KIND_ICON[channel.kind];

  const test = () => {
    setTesting(true);
    core
      .host(hostId)
      .call("notify.test", { channelId: channel.id, escalate: false })
      .then(
        (r) => {
          if (r.push?.ok === false) {
            haptic("warning");
            toast({ title: `${channel.name}: the test failed`, description: r.push.error ?? (r.push.status !== undefined ? `HTTP ${r.push.status}` : undefined), status: "error" });
          } else {
            haptic("success");
            toast({ title: `Test sent to ${channel.name}`, description: "It should arrive on that device in a moment.", status: "done" });
          }
        },
        (err: unknown) => toast({ title: `Couldn't test ${channel.name}: ${errorMessage(err)}`, description: errorHint(err), status: "error" }),
      )
      .finally(() => {
        setTesting(false);
        // the host recorded the result: show it
        core.host(hostId).call("notify.config", {}).then(onConfig, () => {});
      });
  };

  const edit = () =>
    openSheet({
      title: `Edit ${channel.name}`,
      description: `${PUSH_KIND_LABEL[channel.kind]} · ${channel.target}`,
      content: <PushChannelForm hostId={hostId} initial={channel} onSaved={onConfig} />,
    });

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-white/6 text-ink-2 shadow-hairline [&_svg]:size-4">
        <Icon />
      </span>
      <div className="min-w-0 flex-1 basis-52">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-bold text-ink">{channel.name}</span>
          {!channel.enabled && <Chip className="h-5 text-2xs">Off</Chip>}
        </div>
        <div className="truncate font-mono text-xs text-mute" title={channel.target}>
          {channel.target}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Chip className="h-5 text-2xs">{PUSH_WHEN_SHORT[channel.when]}</Chip>
          <Chip className="h-5 max-w-full min-w-0 text-2xs">
            <span className="truncate">{kindsLabel(channel.kinds)}</span>
          </Chip>
          {channel.private && (
            <Chip className="h-5 text-2xs" icon={<EyeOff />}>
              Details hidden
            </Chip>
          )}
        </div>
        <div className="mt-1 min-h-4">{channel.last ? <LastResult last={channel.last} /> : <span className="text-xs text-mute-2">Nothing sent yet</span>}</div>
      </div>
      <Switch
        checked={channel.enabled}
        disabled={busy}
        label={`${channel.name} enabled`}
        onCheckedChange={(enabled) => {
          haptic("tick");
          void mutate(() => core.host(hostId).call("notify.saveChannel", plainFields(channel, { enabled })));
        }}
      />
      <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
        {confirming ? (
          <>
            <span className="text-xs text-mute">Remove “{channel.name}”?</span>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={() =>
                void mutate(() => core.host(hostId).call("notify.removeChannel", { id: channel.id })).then((ok) => {
                  if (!ok) return;
                  setConfirming(false);
                  toast({ title: `Removed “${channel.name}”`, status: "done" });
                })
              }
            >
              Remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" icon={<Send />} loading={testing} onClick={test}>
              Test
            </Button>
            <IconButton label={`Edit ${channel.name}`} size="sm" onClick={edit}>
              <Pencil />
            </IconButton>
            <IconButton label={`Remove ${channel.name}`} size="sm" variant="danger" onClick={() => setConfirming(true)}>
              <Trash2 />
            </IconButton>
          </>
        )}
      </div>
    </li>
  );
}

/** A host's push channels: the list with enable, test, edit and remove, and Add channel. */
export function PushChannels({ hostId, config, busy, mutate, onConfig }: { hostId: string; config: NotifyConfig; busy: boolean; mutate: Mutate; onConfig: (c: NotifyConfig) => void }) {
  return (
    <div className="py-3 last:pb-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="text-sm font-bold text-ink">Push channels</div>
          <div className="text-xs text-mute">
            Reach you with no app open: ntfy, Pushover or your own webhook. ntfy also clears a notification once you read it on any device; Pushover can't take one back. Secrets stay on the host, owner-only, and are never shown again.
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus />}
          onClick={() =>
            openSheet({
              title: "Add a push channel",
              description: "A way for this host to reach you when no app is looking.",
              content: <PushChannelForm hostId={hostId} onSaved={onConfig} />,
            })
          }
        >
          Add channel
        </Button>
      </div>
      {config.channels.length === 0 ? (
        <p className="pt-2 text-sm text-mute-2">No push channels. Without one, an alert only reaches an app that is connected to this host.</p>
      ) : (
        <ul className="mt-1 flex flex-col divide-y divide-line">
          {config.channels.map((c) => (
            <ChannelRow key={c.id} hostId={hostId} channel={c} busy={busy} mutate={mutate} onConfig={onConfig} />
          ))}
        </ul>
      )}
    </div>
  );
}
