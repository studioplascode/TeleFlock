import { Select, SegmentedControl, Switch, isAndroid, isTauri, toast } from "@/design";
import { useSettings } from "@/core";
import type { DeviceKind, Settings } from "@/core/gen";
import { autoDeviceKind, DEFAULT_IDLE_AFTER_MIN, DEVICE_KIND_LABEL, escalateLabel, IDLE_AFTER_MIN, idleChoice } from "@/features/notify/alerts";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { Row } from "./parts";

type KindChoice = "auto" | "desktop" | "phone";

/**
 * Device-level alert routing, inside Settings › Notifications: whether this device tells hosts it
 * is in use, what kind of device it is and when it counts as idle (`Settings.sharePresence`,
 * `deviceKind`, `idleAfterMin`). Hosts before 0.7.0 ignore all of it and alert every device.
 */
export function PresenceRows() {
  const settings = useSettings();
  const share = settings.sharePresence !== false;
  const kind: KindChoice = settings.deviceKind === "desktop" || settings.deviceKind === "phone" ? settings.deviceKind : "auto";
  const auto: DeviceKind = autoDeviceKind({ android: isAndroid, tauri: isTauri() });

  const update = (patch: Partial<Settings>) => {
    haptic("tick");
    settings.update(patch).catch((err: unknown) => {
      toast({ title: `Couldn't save settings: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
    });
  };

  return (
    <>
      <Row
        label="Alert the device I'm using"
        description="Hosts alert the device you're using first and escalate to your phone when nobody saw it. Hosts before 0.7.0 alert every device."
      >
        <Switch checked={share} onCheckedChange={(sharePresence) => update({ sharePresence })} label="Alert the device I'm using" />
      </Row>
      {share && (
        <>
          <Row
            label="This device is"
            wide
            description={`Decides which alerts escalate here. Auto means ${DEVICE_KIND_LABEL[auto]} on this device${auto === "web" ? " (a browser counts as neither phone nor desktop)" : ""}.`}
          >
            <SegmentedControl<KindChoice>
              value={kind}
              onValueChange={(v) => update({ deviceKind: v === "auto" ? undefined : v })}
              options={[
                { value: "auto", label: "Auto" },
                { value: "desktop", label: "Desktop" },
                { value: "phone", label: "Phone" },
              ]}
              aria-label="This device is"
            />
          </Row>
          <Row label="Idle after" htmlFor="tf-idle-after" wide description="No input for this long and the device counts as not in use.">
            <Select
              id="tf-idle-after"
              className="w-36"
              value={String(idleChoice(settings.idleAfterMin))}
              onValueChange={(v) => update({ idleAfterMin: Number(v) === DEFAULT_IDLE_AFTER_MIN ? undefined : Number(v) })}
              options={IDLE_AFTER_MIN.map((m) => ({ value: String(m), label: escalateLabel(m * 60) }))}
            />
          </Row>
        </>
      )}
    </>
  );
}
