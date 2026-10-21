import { invoke } from "@tauri-apps/api/core";
import { Bell, BellRing, Bot, Info, Keyboard, MonitorSmartphone, Sparkles, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  cn,
  isAndroid,
  isTauri,
  Kbd,
  PageHeader,
  SegmentedControl,
  Select,
  Switch,
  toast,
  useIsMobile,
  useMotionPreference,
} from "@/design";
import { core, useSettings, useUi } from "@/core";
import type { MotionPref, Settings, ThinkingLevel } from "@/core/gen";
import { useAppInfo } from "@/features/hosts/appInfo";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { MutedAgents } from "./MutedAgents";
import { CommitInput, Row, Section, THINKING, useModels } from "./parts";
import { Templates } from "./Templates";

type PermState = "granted" | "denied" | "prompt" | "prompt-with-rationale";

const PERM_COPY: Record<PermState, string> = {
  granted: "Granted. Needs-you alerts can reach you while the app is closed.",
  prompt: "Not granted yet. Android needs your permission to show needs-you alerts.",
  "prompt-with-rationale": "Not granted. Without it, agents that need you can't alert you.",
  denied: "Blocked for TeleFlock. Grant opens Android's notification settings.",
};

function AndroidRows() {
  const [perm, setPerm] = useState<PermState | null>(null);
  const [battery, setBattery] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () => {
      invoke<{ postNotification: PermState }>("plugin:teleflock-android|notification_permission").then(
        (r) => setPerm(r.postNotification),
        () => setPerm(null),
      );
      invoke<{ ignoringOptimizations: boolean }>("plugin:teleflock-android|battery_status").then(
        (r) => setBattery(r.ignoringOptimizations),
        () => setBattery(null),
      );
    };
    // Coming back from Android's settings screen: pick up what the user changed there.
    const onVisible = () => document.visibilityState === "visible" && refresh();
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return (
    <>
      {perm !== null && (
        <Row label="Notification permission" description={PERM_COPY[perm]}>
          {perm === "granted" ? (
            <span className="text-sm font-bold text-done">Allowed</span>
          ) : (
            <span className="flex items-center gap-2.5">
              <span className={cn("text-sm font-bold", perm === "denied" ? "text-error" : "text-sun-2")}>{perm === "denied" ? "Blocked" : "Off"}</span>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  invoke<{ postNotification: PermState }>("plugin:teleflock-android|request_notification_permission").then(
                    (r) => {
                      setPerm(r.postNotification);
                      if (r.postNotification === "granted") haptic("success");
                    },
                    (err: unknown) => toast({ title: `Couldn't request permission: ${errorMessage(err)}`, status: "error" }),
                  )
                }
              >
                Grant
              </Button>
            </span>
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
      <div className={cn("mx-auto grid w-full max-w-[880px] grid-cols-[minmax(0,1fr)] content-start gap-4", mobile ? "px-3 pb-8" : "px-8 pt-7 pb-12")}>
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

        <MutedAgents index={2} />

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

        <Templates index={3} />

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
