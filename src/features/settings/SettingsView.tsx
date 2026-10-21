import { invoke } from "@tauri-apps/api/core";
import { Bell, BellRing, Bot, Info, Keyboard, MonitorSmartphone, Sparkles, SquareTerminal } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import {
  Button,
  cn,
  fadeRise,
  Input,
  isAndroid,
  isTauri,
  Kbd,
  PageHeader,
  SegmentedControl,
  Select,
  spring,
  Switch,
  Tile,
  toast,
  useIsMobile,
  useMotionPreference,
} from "@/design";
import { core, useHostIds, useHosts, useSettings, useUi } from "@/core";
import type { ModelInfo, MotionPref, Settings, ThinkingLevel } from "@/core/gen";
import { useAppInfo } from "@/features/hosts/appInfo";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { MobileHeader } from "@/features/shell/MobileHeader";

const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

function Section({ icon, title, description, children, index }: { icon: ReactNode; title: string; description?: string; children: ReactNode; index: number }) {
  return (
    <motion.section {...fadeRise} transition={{ ...spring.smooth, delay: index * 0.05 }}>
      <Tile className="p-5">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent/16 text-accent-hi [&_svg]:size-4">{icon}</span>
          <div>
            <h2 className="font-display text-lg font-bold">{title}</h2>
            {description && <p className="text-xs text-mute">{description}</p>}
          </div>
        </div>
        <div className="flex flex-col divide-y divide-line">{children}</div>
      </Tile>
    </motion.section>
  );
}

/** One setting. `wide` controls (segmented, selects, text) take the full row on phones. */
function Row({ label, description, children, htmlFor, wide }: { label: string; description?: ReactNode; children: ReactNode; htmlFor?: string; wide?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-1 last:pb-1">
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor={htmlFor} className="block text-sm font-bold text-ink">
          {label}
        </label>
        {description && <div className="text-xs text-mute">{description}</div>}
      </div>
      <div className={cn("flex shrink-0 items-center gap-2", wide && "max-md:w-full max-md:[&>*]:w-full")}>{children}</div>
    </div>
  );
}

/** Text setting committed on blur / Enter (not per keystroke). */
function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void; id?: string; placeholder?: string; type?: string; className?: string; "aria-label"?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/** Models from the first online host (for the default-model picker). */
function useModels(): ModelInfo[] {
  const ids = useHostIds();
  const { status } = useHosts();
  const online = ids.find((id) => status[id]?.phase === "online");
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    if (!online) return;
    let live = true;
    core
      .host(online)
      .call("host.models", {})
      .then(
        (c) => live && setModels(c.models),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [online]);
  return models;
}

type PermState = "granted" | "denied" | "prompt" | "prompt-with-rationale";

function AndroidRows() {
  const [perm, setPerm] = useState<PermState | null>(null);
  const [battery, setBattery] = useState<boolean | null>(null);
  useEffect(() => {
    invoke<{ postNotification: PermState }>("plugin:teleflock-android|notification_permission").then(
      (r) => setPerm(r.postNotification),
      () => setPerm(null),
    );
    invoke<{ ignoringOptimizations: boolean }>("plugin:teleflock-android|battery_status").then(
      (r) => setBattery(r.ignoringOptimizations),
      () => setBattery(null),
    );
  }, []);
  return (
    <>
      {perm !== null && (
        <Row label="Notification permission" description={perm === "granted" ? "Granted." : "Android needs your permission to show needs-you alerts."}>
          {perm === "granted" ? (
            <span className="text-sm font-bold text-done">Allowed</span>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                invoke<{ postNotification: PermState }>("plugin:teleflock-android|request_notification_permission").then(
                  (r) => setPerm(r.postNotification),
                  (err: unknown) => toast({ title: `Couldn't request permission: ${errorMessage(err)}`, status: "error" }),
                )
              }
            >
              Allow
            </Button>
          )}
        </Row>
      )}
      {battery !== null && (
        <Row label="Battery optimisation" description={battery ? "TeleFlock may run in the background without being killed." : "Android may stop the background connection. Exempt TeleFlock for reliable alerts."}>
          {battery ? (
            <span className="text-sm font-bold text-done">Exempt</span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                invoke("plugin:teleflock-android|request_ignore_battery_optimizations").then(
                  () => invoke<{ ignoringOptimizations: boolean }>("plugin:teleflock-android|battery_status").then((r) => setBattery(r.ignoringOptimizations)),
                  (err: unknown) => toast({ title: `Couldn't open the setting: ${errorMessage(err)}`, status: "error" }),
                )
              }
            >
              Exempt
            </Button>
          )}
        </Row>
      )}
    </>
  );
}

/** Every Settings field, saved through `settings.set`; the motion preference applies live. */
export function SettingsView() {
  const settings = useSettings();
  const { openDialog } = useUi();
  const setMotion = useMotionPreference((s) => s.setPreference);
  const mobile = useIsMobile();
  const info = useAppInfo();
  const models = useModels();
  const [testing, setTesting] = useState(false);

  const update = (patch: Partial<Settings>) => {
    haptic("tick");
    settings.update(patch).catch((err: unknown) => {
      toast({ title: `Couldn't save settings: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
    });
  };
  const quiet = settings.quietStart !== undefined && settings.quietEnd !== undefined;

  const modelOptions = [
    { value: "__none", label: "Host default", hint: "Whatever omp is configured to use" },
    ...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.label ?? m.id, hint: m.provider })),
  ];
  if (settings.defaultModel && !models.some((m) => `${m.provider}/${m.id}` === settings.defaultModel)) {
    modelOptions.push({ value: settings.defaultModel, label: settings.defaultModel, hint: "saved" });
  }

  return (
    <div className="flex min-h-full flex-col">
      {mobile && <MobileHeader title="Settings" back />}
      <div className={cn("mx-auto grid w-full max-w-[880px] content-start gap-4", mobile ? "px-3 pb-8" : "px-8 pt-7 pb-12")}>
        {!mobile && <PageHeader kicker="Preferences" title="Settings" description="How TeleFlock moves, notifies and starts new agents on this device." className="mb-2" />}
        <Section index={0} icon={<Sparkles />} title="Motion" description="Animation is how TeleFlock shows that work is alive. Reduced keeps every meaning with calm, static colour.">
          <Row label="Animation" wide>
            <SegmentedControl<MotionPref>
              value={settings.motion}
              onValueChange={(motion) => {
                setMotion(motion);
                update({ motion });
              }}
              options={[
                { value: "system", label: "System" },
                { value: "full", label: "Full" },
                { value: "reduced", label: "Reduced" },
              ]}
              aria-label="Animation"
              fill={mobile}
            />
          </Row>
        </Section>

        <Section index={1} icon={<Bell />} title="Notifications" description="When TeleFlock should tap you on the shoulder.">
          <Row label="Needs you" description="Questions, approvals and plan reviews.">
            <Switch checked={settings.notifyNeeds} onCheckedChange={(notifyNeeds) => update({ notifyNeeds })} label="Notify when an agent needs you" />
          </Row>
          <Row label="Finished" description="An agent finished its turn and is ready for review.">
            <Switch checked={settings.notifyFinished} onCheckedChange={(notifyFinished) => update({ notifyFinished })} label="Notify when an agent finishes" />
          </Row>
          <Row label="Errors and stalls" description="Errors, and agents that have gone quiet while working.">
            <Switch checked={settings.notifyErrors} onCheckedChange={(notifyErrors) => update({ notifyErrors })} label="Notify on errors" />
          </Row>
          <Row label="Sound">
            <Switch checked={settings.notifySound} onCheckedChange={(notifySound) => update({ notifySound })} label="Notification sound" />
          </Row>
          <Row label="Quiet hours" description={quiet ? "Notifications stay silent in this window." : "Silence notifications overnight."}>
            {quiet && (
              <>
                <CommitInput type="time" value={settings.quietStart ?? "22:00"} onCommit={(quietStart) => update({ quietStart })} aria-label="Quiet hours start" className="w-[88px]" />
                <span className="text-mute">–</span>
                <CommitInput type="time" value={settings.quietEnd ?? "07:00"} onCommit={(quietEnd) => update({ quietEnd })} aria-label="Quiet hours end" className="w-[88px]" />
              </>
            )}
            <Switch
              checked={quiet}
              onCheckedChange={(on) => update(on ? { quietStart: "22:00", quietEnd: "07:00" } : { quietStart: undefined, quietEnd: undefined })}
              label="Quiet hours"
            />
          </Row>
          <Row label="Test" description="Send a sample notification through the system.">
            <Button
              size="sm"
              variant="secondary"
              icon={<BellRing />}
              loading={testing}
              onClick={() => {
                setTesting(true);
                core
                  .app("app.notifyTest", {})
                  .then(
                    () => toast({ title: "Test notification sent", status: "done" }),
                    (err: unknown) => toast({ title: `Couldn't notify: ${errorMessage(err)}`, description: errorHint(err), status: "error" }),
                  )
                  .finally(() => setTesting(false));
              }}
            >
              Send test
            </Button>
          </Row>
          {isTauri() && isAndroid && <AndroidRows />}
        </Section>

        <Section index={2} icon={<Bot />} title="New agents" description="Defaults for agents you start from TeleFlock.">
          <Row label="Model" htmlFor="tf-default-model" wide>
            <Select
              id="tf-default-model"
              className="w-60"
              value={settings.defaultModel ?? "__none"}
              onValueChange={(v) => update({ defaultModel: v === "__none" ? undefined : v })}
              options={modelOptions}
            />
          </Row>
          <Row label="Thinking" htmlFor="tf-default-thinking" wide>
            <Select
              id="tf-default-thinking"
              className="w-40"
              value={settings.defaultThinking ?? "__none"}
              onValueChange={(v) => update({ defaultThinking: v === "__none" ? undefined : (v as ThinkingLevel) })}
              options={[{ value: "__none", label: "Model default" }, ...THINKING.map((t) => ({ value: t, label: t }))]}
            />
          </Row>
          <Row label="Start in plan mode" description="The agent proposes a plan before touching files.">
            <Switch checked={settings.defaultPlan} onCheckedChange={(defaultPlan) => update({ defaultPlan })} label="Start in plan mode" />
          </Row>
          <Row label="Confirm before archiving">
            <Switch checked={settings.confirmArchive} onCheckedChange={(confirmArchive) => update({ confirmArchive })} label="Confirm before archiving" />
          </Row>
        </Section>

        <Section index={3} icon={<SquareTerminal />} title="Terminal">
          <Row label="Font size" description={<span className="font-mono" style={{ fontSize: settings.terminalFontSize }}>~/teleflock $ herdr agent list</span>}>
            <input
              type="range"
              min={9}
              max={22}
              step={1}
              value={settings.terminalFontSize}
              onChange={(e) => update({ terminalFontSize: Number(e.target.value) })}
              className="w-40 accent-[#a35cf0]"
              aria-label="Terminal font size"
            />
            <span className="w-10 text-right font-mono text-sm tabular text-ink-2">{settings.terminalFontSize}px</span>
          </Row>
        </Section>

        <Section index={4} icon={<MonitorSmartphone />} title="This device">
          <Row label="Device name" description="Shown to other clients as the author of prompts you send." htmlFor="tf-device-name" wide>
            <CommitInput id="tf-device-name" value={settings.deviceName} onCommit={(deviceName) => update({ deviceName: deviceName.trim() || settings.deviceName })} className="w-56" />
          </Row>
          {(isAndroid || info?.capabilities.keepAlive) && (
            <Row label="Stay connected in the background" description="Keeps host connections alive in a foreground service so needs-you alerts arrive while the app is closed.">
              <Switch checked={settings.keepAlive} onCheckedChange={(keepAlive) => update({ keepAlive })} label="Stay connected in the background" />
            </Row>
          )}
          {!mobile && (
            <Row label="Keyboard shortcuts" description={<>Press <Kbd>?</Kbd> anywhere.</>}>
              <Button size="sm" variant="secondary" icon={<Keyboard />} onClick={() => openDialog({ kind: "shortcuts" })}>
                Show
              </Button>
            </Row>
          )}
        </Section>

        <Section index={5} icon={<Info />} title="About">
          <Row label="TeleFlock" description={info ? `${info.platform} · data in ${info.dataDir}` : "…"}>
            <span className="font-mono text-sm text-ink-2">{info ? `v${info.version}` : ""}</span>
          </Row>
          <Row label="Bundled tf-hostd" description="Deployed to each host on connect.">
            <span className="font-mono text-sm text-ink-2">{info?.hostdVersion ?? ""}</span>
          </Row>
          <Row label="Backend">
            <span className="font-mono text-sm text-ink-2">{core.backend}</span>
          </Row>
        </Section>
      </div>
    </div>
  );
}
