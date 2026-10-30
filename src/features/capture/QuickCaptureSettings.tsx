import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Copy, RotateCcw, Zap } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useSettings } from "@/core";
import { Button, isAndroid, isTauri, Kbd, Switch, toast } from "@/design";
import { Row, Section } from "@/features/settings/parts";
import { errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { SHORTCUTS } from "@/features/shell/keyboard";
import { ACTIONS } from "@/features/shell/vocab";
import { acceleratorCaps, appClash, chordToAccelerator, type DesktopPlatform, systemClash } from "./shortcut";

/** What the desktop shell reports about the Quick capture shortcut (`capture_status`, `capture-status` event). */
export interface CaptureStatus {
  platform: DesktopPlatform;
  /** The accelerator wanted (`Settings.captureShortcut`); "" = off, which is also what it is until the user sets one. */
  shortcut: string;
  /** What turning the shortcut on picks (this platform's suggestion). */
  defaultShortcut: string;
  /**
   * `registered`: works system-wide. `off`: turned off. `taken`: another app holds it. `invalid`:
   * not a shortcut this platform knows. `unsupported`: no system-wide shortcuts here (Wayland).
   * `failed`: the system refused for another reason (`reason`).
   */
  state: "registered" | "off" | "taken" | "invalid" | "unsupported" | "failed";
  reason?: string;
  /** Wayland: the command that opens Quick capture, for a shortcut set in the desktop's own settings. */
  command?: string;
}

function Caps({ accelerator, platform }: { accelerator: string; platform: DesktopPlatform }) {
  return (
    <span className="flex items-center gap-1">
      {acceleratorCaps(accelerator, platform).map((k, i) => (
        <Kbd key={`${i}:${k}`}>{k}</Kbd>
      ))}
    </span>
  );
}

function statusText(s: CaptureStatus): { tone: "ok" | "warn" | "error"; text: string } {
  switch (s.state) {
    case "registered":
      return { tone: "ok", text: "Works from any app." };
    case "off":
      return { tone: "warn", text: "Off until you turn it on. The tray menu still opens Quick capture." };
    case "taken":
      return { tone: "error", text: "Another app already uses this shortcut. Pick another one." };
    case "invalid":
      return { tone: "error", text: `This isn't a shortcut the system knows${s.reason ? ` (${s.reason})` : ""}. Pick another one.` };
    case "unsupported":
      return { tone: "warn", text: s.reason ?? "This desktop doesn't let apps listen for a shortcut system-wide." };
    case "failed":
      return { tone: "error", text: `The system refused it${s.reason ? `: ${s.reason}` : ""}. Pick another one.` };
  }
}

/** Settings → Quick capture (desktop app only): the system-wide shortcut, its state and its clashes. */
export function QuickCaptureSettings({ index }: { index: number }) {
  const save = useSettings((s) => s.update);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);
  const desktop = isTauri() && !isAndroid;

  useEffect(() => {
    if (!desktop) return;
    invoke<CaptureStatus>("capture_status").then(setStatus, (e: unknown) => console.warn("capture: no status", e));
    const off = listen<CaptureStatus>("capture-status", (e) => setStatus(e.payload));
    return () => void off.then((f) => f());
  }, [desktop]);
  useEffect(() => {
    if (recording) recorder.current?.focus();
  }, [recording]);

  if (!desktop || !status) return null;
  const { platform } = status;
  const on = status.shortcut !== "";
  const line = statusText(status);
  const inApp = on ? appClash(status.shortcut, SHORTCUTS.flatMap((g) => g.items), platform) : null;
  const system = on && status.state !== "taken" ? systemClash(status.shortcut, platform) : null;

  const update = (captureShortcut: string | undefined) => {
    haptic("tick");
    save({ captureShortcut }).catch((err: unknown) => toast({ title: `Couldn't save the shortcut: ${errorMessage(err)}`, status: "error" }));
  };
  const onRecordKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      setRecording(false);
      setRecordError(null);
      return;
    }
    const r = chordToAccelerator(e, platform);
    if (!r) return;
    if ("error" in r) {
      setRecordError(r.error);
      return;
    }
    setRecording(false);
    setRecordError(null);
    update(r.accelerator);
  };

  return (
    <Section
      index={index}
      icon={<Zap />}
      title={ACTIONS.quickCapture.label}
      description="A small box over any app: Enter sends a task to Dispatch's last repository, pasted screenshots come along, and 1–9 answers the next question. The system-wide shortcut is off until you turn it on here; the tray menu always opens it."
    >
      <Row
        label="System-wide shortcut"
        description={
          <span className={line.tone === "ok" ? "text-done" : line.tone === "warn" ? "text-warn" : "text-error"} role={line.tone === "error" ? "alert" : undefined}>
            {line.text}
          </span>
        }
      >
        {recording ? (
          <button
            ref={recorder}
            type="button"
            onKeyDown={onRecordKey}
            onBlur={() => setRecording(false)}
            className="focus-ring rounded-md bg-accent/14 px-3 py-1.5 text-xs font-bold text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.45)]"
          >
            Press the new shortcut… (Esc cancels)
          </button>
        ) : (
          on && <Caps accelerator={status.shortcut} platform={platform} />
        )}
        {!recording && (
          <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
            {on ? "Change…" : "Set…"}
          </Button>
        )}
        {!recording && on && status.shortcut !== status.defaultShortcut && (
          <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => update(status.defaultShortcut)} title="Back to the suggested shortcut">
            <Caps accelerator={status.defaultShortcut} platform={platform} />
          </Button>
        )}
        <Switch checked={on} onCheckedChange={(v) => update(v ? status.defaultShortcut : undefined)} label="System-wide shortcut" />
      </Row>
      {recordError && <p className="-mt-1 pb-2 text-xs font-semibold text-error">{recordError}</p>}
      {(inApp || system) && (
        <p className="-mt-1 pb-2 text-xs font-semibold text-warn">
          {inApp && <>Inside TeleFlock this takes over “{inApp}”. </>}
          {system && <>Your desktop usually uses it: it {system}.</>}
        </p>
      )}
      {status.command && (
        <Row
          label="Use your desktop's shortcut"
          description="Add a custom shortcut in your desktop's keyboard settings that runs this command; it opens Quick capture like the built-in one would."
          wide
        >
          <code className="max-w-full truncate rounded-xs bg-well px-2 py-1 font-mono text-xs text-ink-2">{status.command}</code>
          <Button
            size="sm"
            variant="secondary"
            icon={<Copy />}
            onClick={() =>
              navigator.clipboard.writeText(status.command ?? "").then(
                () => toast({ title: "Command copied", status: "done" }),
                (e: unknown) => toast({ title: `Couldn't copy: ${errorMessage(e)}`, status: "error" }),
              )
            }
          >
            Copy
          </Button>
        </Row>
      )}
      <Row label="Try it" description="Opens the box now, as the shortcut would.">
        <Button size="sm" variant="secondary" icon={<Zap />} onClick={() => invoke("capture_open").catch((e: unknown) => toast({ title: `Couldn't open it: ${errorMessage(e)}`, status: "error" }))}>
          Open Quick capture
        </Button>
      </Row>
    </Section>
  );
}
