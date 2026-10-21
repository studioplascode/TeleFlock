import { Download, RefreshCw, RefreshCwOff } from "lucide-react";
import { useEffect } from "react";
import { Button, formatAge, Switch, toast, useNow } from "@/design";
import { core, useSettings } from "@/core";
import type { UpdateStatus } from "@/core/gen";
import { errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { installLine, useUpdateStatus, watchUpdates } from "@/features/updates/updates";
import { Row, Section } from "./parts";

function statusLine(s: UpdateStatus, now: number): string {
  const checked = s.checkedAt === undefined ? "" : ` · checked ${formatAge(now - s.checkedAt)}`;
  switch (s.phase) {
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking GitHub for a new version…";
    case "upToDate":
      return `Up to date${checked}`;
    case "available":
      return `v${s.latest} is available${checked}`;
    case "error": {
      const e = s.error ?? "the update failed";
      return `${e.charAt(0).toUpperCase()}${e.slice(1)}${checked}`;
    }
    default:
      return installLine(s);
  }
}

/** Settings → Updates (Tauri app only): version, status, manual check / install, auto toggle. */
export function Updates({ index }: { index: number }) {
  const status = useUpdateStatus((s) => s.status);
  const autoUpdate = useSettings((s) => s.autoUpdate);
  const saveSettings = useSettings((s) => s.update);
  const now = useNow(30_000);
  useEffect(watchUpdates, []);
  if (core.backend !== "tauri" || !status) return null;

  const busy = status.phase === "checking" || status.phase === "downloading" || status.phase === "installing";
  const canInstall = status.phase === "available" || status.phase === "needsPermission";
  const run = (p: Promise<unknown>) =>
    p.catch((err: unknown) => toast({ title: `Couldn't update: ${errorMessage(err)}`, status: "error" }));

  return (
    <Section index={index} icon={status.supported ? <RefreshCw /> : <RefreshCwOff />} title="Updates" description="New versions come from TeleFlock's GitHub releases.">
      <Row
        label={`TeleFlock v${status.current}`}
        description={
          status.supported ? (
            <>
              <span className="tabular">{statusLine(status, now)}</span>
              {status.phase === "downloading" && status.progress !== undefined && (
                <span className="mt-1.5 block h-1 w-full max-w-56 overflow-hidden rounded-full bg-line">
                  <span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${status.progress}%` }} />
                </span>
              )}
            </>
          ) : (
            status.unsupportedReason ?? "This copy doesn't update itself. Install a release from GitHub to get updates."
          )
        }
      >
        {status.supported &&
          (canInstall ? (
            <Button size="sm" variant="primary" icon={<Download />} onClick={() => run(core.app("app.updateInstall", {}))}>
              {status.manual ? `Download v${status.latest}` : `Update to v${status.latest}`}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw />}
              loading={busy}
              disabled={busy}
              onClick={() => run(core.app("app.updateCheck", { launch: false, install: autoUpdate }))}
            >
              Check for updates
            </Button>
          ))}
      </Row>
      <Row
        label="Automatic updates"
        description={
          status.manual
            ? "Check when TeleFlock starts. On macOS you install new versions yourself from the downloaded .dmg."
            : "Check when TeleFlock starts and install new versions right away."
        }
      >
        <Switch
          checked={autoUpdate}
          onCheckedChange={(on) => {
            haptic("tick");
            saveSettings({ autoUpdate: on }).catch((err: unknown) => toast({ title: `Couldn't save settings: ${errorMessage(err)}`, status: "error" }));
          }}
          label="Automatic updates"
        />
      </Row>
    </Section>
  );
}
