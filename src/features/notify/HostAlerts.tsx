import { BellRing, Globe, Info, Monitor, Smartphone, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, Chip, formatAge, SegmentedControl, Select, Spinner, Switch, toast, useInView, useNow, useWindowActive } from "@/design";
import { core, useHosts } from "@/core";
import type { DevicePresence, EscalateTo, NotifyConfig, NotifyPolicy } from "@/core/gen";
import { Row, Section } from "@/features/settings/parts";
import { errorHint, errorMessage, isApiError } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { describeTest, deviceGlyph, ESCALATE_TO_LABEL, escalateLabel, escalateOptions, PRESENCE_HINT, PRESENCE_LABEL } from "./alerts";
import { type Mutate, PushChannels } from "./PushChannels";

/** How often the device list refreshes while the section is on screen in the front window. */
const POLL_MS = 10_000;

const UNSUPPORTED = "Update this host to TeleFlock 0.7.0 to route alerts";

interface Loaded {
  hostId?: string;
  config?: NotifyConfig;
  /** `unsupported`: the host predates 0.7.0; otherwise the error's message. */
  problem?: { unsupported: boolean; message: string };
}

/**
 * One host's `notify.config`: loaded when the host or its connection changes, refreshed every 10 s
 * while `poll` (section on screen, window in front) and replaced by whatever a mutation answers.
 */
function useNotifyConfig(hostId: string | undefined, online: boolean, poll: boolean) {
  const [state, setState] = useState<Loaded>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!hostId || !online) return;
    let live = true;
    const load = () =>
      core
        .host(hostId)
        .call("notify.config", {})
        .then(
          (config) => live && setState({ hostId, config }),
          (err: unknown) =>
            live &&
            setState((prev) => ({
              hostId,
              config: prev.hostId === hostId ? prev.config : undefined,
              problem: { unsupported: isApiError(err) && err.code === "unknown_method", message: errorMessage(err) },
            })),
        );
    void load();
    if (!poll) return () => void (live = false);
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [hostId, online, poll, attempt]);
  const cur = state.hostId === hostId ? state : {};
  return { config: cur.config, problem: cur.problem, set: (config: NotifyConfig) => setState({ hostId, config }), retry: () => setAttempt((a) => a + 1) };
}

const GLYPH = { phone: Smartphone, desktop: Monitor, web: Globe } as const;

function DeviceRow({ device }: { device: DevicePresence }) {
  const now = useNow(30_000);
  const Icon = GLYPH[deviceGlyph(device.platform, device.presence?.device)];
  const p = device.presence;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-white/6 text-ink-2 shadow-hairline [&_svg]:size-4">
        <Icon />
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-bold text-ink">{device.name}</span>
          {device.me && <Chip className="h-5 text-2xs">this device</Chip>}
        </div>
        <div className="truncate text-xs text-mute">
          {device.platform}
          {p?.inputAt !== undefined && ` · input ${formatAge(now - p.inputAt)}`}
          {p && !p.osNotifications && " · no system notifications"}
        </div>
      </div>
      {p ? (
        <Chip tone={p.state === "active" ? "done" : p.state === "idle" ? "idle" : "neutral"} title={PRESENCE_HINT[p.state]}>
          {PRESENCE_LABEL[p.state]}
        </Chip>
      ) : (
        <Chip title="This app predates presence: it shows every alert the host sends">Older app: alerts everything</Chip>
      )}
    </li>
  );
}

function Note({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-sm text-mute [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <span className="min-w-0 flex-1 basis-56">{children}</span>
      {action}
    </div>
  );
}

/**
 * Settings: what each host does with a notification (`notify.*`, hosts ≥ 0.7.0): alert the device
 * in use, escalate when unseen, the devices connected now and the host's push channels.
 */
export function HostAlerts({ index }: { index: number }) {
  const profiles = useHosts((h) => h.profiles);
  const status = useHosts((h) => h.status);
  const filter = useHosts((h) => h.filter);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const onScreen = useInView(box);
  const active = useWindowActive();

  const isOnline = (id: string) => status[id]?.phase === "online";
  const fallback = filter !== "all" && isOnline(filter) ? filter : (profiles.find((p) => isOnline(p.id)) ?? profiles[0])?.id;
  const hostId = chosen !== null && profiles.some((p) => p.id === chosen) ? chosen : fallback;
  const online = hostId !== undefined && isOnline(hostId);
  const { config, problem, set, retry } = useNotifyConfig(hostId, online, onScreen && active);

  const mutate: Mutate = (run) => {
    setBusy(true);
    return run()
      .then(
        (next) => {
          set(next);
          return true;
        },
        (err: unknown) => {
          haptic("warning");
          toast({ title: `Couldn't save: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
          return false;
        },
      )
      .finally(() => setBusy(false));
  };
  const setPolicy = (patch: Partial<NotifyPolicy>) => {
    if (!hostId || !config) return;
    haptic("tick");
    void mutate(() => core.host(hostId).call("notify.setPolicy", { ...config.policy, ...patch }));
  };

  const sendTest = () => {
    if (!hostId || !config) return;
    setTesting(true);
    core
      .host(hostId)
      .call("notify.test", { escalate: true })
      .then(
        (r) => {
          const { title, status: s } = describeTest(r, config);
          haptic("success");
          toast({ title, status: s });
        },
        (err: unknown) => toast({ title: `Couldn't send the test: ${errorMessage(err)}`, description: errorHint(err), status: "error" }),
      )
      .finally(() => setTesting(false));
  };

  const hostName = profiles.find((p) => p.id === hostId)?.name ?? "this host";
  const policy = config?.policy;
  const routing = policy?.route === true;
  const escalating = routing && policy.escalateAfterS > 0;

  let body: ReactNode;
  if (profiles.length === 0) {
    body = <Note icon={<Info />}>Connect a host to set how it alerts you.</Note>;
  } else if (hostId === undefined || !online) {
    body = <Note icon={<Info />}>{hostName} isn't connected. Connect it to see and change how it alerts you.</Note>;
  } else if (problem?.unsupported) {
    body = <Note icon={<Info />}>{UNSUPPORTED}.</Note>;
  } else if (!config || !policy) {
    body = problem ? (
      <Note
        icon={<TriangleAlert />}
        action={
          <Button size="sm" variant="secondary" onClick={retry}>
            Retry
          </Button>
        }
      >
        Couldn't read {hostName}'s alert settings: {problem.message}
      </Note>
    ) : (
      <Note icon={<Spinner size={16} />}>Reading {hostName}'s alert settings…</Note>
    );
  } else {
    body = (
      <>
        <Row label="Alert the device in use" description="The host alerts the device you are using, not every device at once.">
          <Switch checked={policy.route} disabled={busy} onCheckedChange={(route) => setPolicy({ route })} label="Alert the device in use" />
        </Row>
        <Row label="Escalate when unseen" htmlFor="tf-escalate-after" wide description="If nobody looks at an alert in this time, the host alerts more devices and the push channels set to Unseen.">
          <Select
            id="tf-escalate-after"
            className="w-36"
            value={String(policy.escalateAfterS)}
            disabled={busy}
            onValueChange={(v) => setPolicy({ escalateAfterS: Number(v) })}
            options={escalateOptions(policy.escalateAfterS).map((s) => ({ value: String(s), label: escalateLabel(s) }))}
          />
        </Row>
        <Row label="Escalate to" wide description="Phones are the devices you carry; All devices includes desktops and browsers.">
          <SegmentedControl<EscalateTo>
            value={policy.escalateTo}
            onValueChange={(escalateTo) => setPolicy({ escalateTo })}
            options={(Object.keys(ESCALATE_TO_LABEL) as EscalateTo[]).map((v) => ({ value: v, label: ESCALATE_TO_LABEL[v], disabled: busy || !escalating }))}
            aria-label="Escalate to"
          />
        </Row>
        <div className="py-3">
          <div className="text-sm font-bold text-ink">Devices now</div>
          <div className="text-xs text-mute">Apps connected to {hostName}, and which one counts as in use.</div>
          {config.devices.length === 0 ? (
            <p className="pt-2 text-sm text-mute-2">No app is connected to this host right now.</p>
          ) : (
            <ul className="mt-1 flex flex-col divide-y divide-line">
              {config.devices.map((d) => (
                <DeviceRow key={`${d.name}/${d.platform}`} device={d} />
              ))}
            </ul>
          )}
        </div>
        <Row label="Send a test" description="A sample notification, routed like a real one and escalating by these rules.">
          <Button size="sm" variant="secondary" icon={<BellRing />} loading={testing} onClick={sendTest}>
            Send test
          </Button>
        </Row>
        <PushChannels hostId={hostId} config={config} busy={busy} mutate={mutate} onConfig={set} />
      </>
    );
  }

  return (
    <Section
      index={index}
      icon={<BellRing />}
      title="Alerts from your hosts"
      description="Each host decides who gets an alert: the device you're using first, then more if nobody sees it, plus push channels that reach you with no app open."
    >
      <div ref={box} className="flex flex-col divide-y divide-line">
        {profiles.length > 0 && (
          <Row label="Host" htmlFor="tf-alerts-host" wide>
            {profiles.length > 1 ? (
              <Select
                id="tf-alerts-host"
                className="w-56"
                value={hostId}
                onValueChange={setChosen}
                options={profiles.map((p) => ({ value: p.id, label: p.name, hint: isOnline(p.id) ? undefined : "not connected" }))}
              />
            ) : (
              <span className="text-sm font-bold text-ink-2">{hostName}</span>
            )}
          </Row>
        )}
        {body}
      </div>
    </Section>
  );
}
