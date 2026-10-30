import { CheckCircle2, CircleAlert, Download, Info } from "lucide-react";
import { useState } from "react";
import { core } from "@/core";
import type { HerdrConfigParams } from "@/core/gen";
import { Button, cn, Spinner, Switch, toast, useNow } from "@/design";
import { errorMessage, isApiError } from "@/features/shell/errors";
import { ConfirmDialog, useHerdrHealth, useHostName } from "./HerdrControls";
import { herdrConfigNote, herdrUpdateNote, loadNowConfirm } from "./herdrHealth";

const NOTE_ICON = { info: Info, ok: CheckCircle2, warn: CircleAlert } as const;

/**
 * What loading the installed herdr into the running server will do and when, or how the last load went
 * (`HerdrHealth.update`), with Load now behind a confirm that says what it does to running work.
 */
export function HerdrUpdatePlan({ hostId }: { hostId: string }) {
  const health = useHerdrHealth(hostId);
  const name = useHostName(hostId);
  const update = health?.update;
  const counting = update?.state === "waiting" || update?.state === "done";
  const now = useNow(counting ? 1000 : 30_000);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  if (!health || !update) return null;
  const note = herdrUpdateNote(update, now, health.config.idleMinutes);
  const Icon = NOTE_ICON[note.tone];
  const running = update.state === "running" || pending;
  const canLoad = health.state === "up" && (update.state === "waiting" || update.state === "manual" || update.state === "failed" || update.state === "ready");
  const confirm = loadNowConfirm(update, name);
  const load = async () => {
    setPending(true);
    try {
      await core.host(hostId).call("host.herdrLoad", {});
    } catch (err) {
      toast({ title: "Couldn't load herdr", description: errorMessage(err), status: "error" });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2" data-testid="herdr-update" data-state={update.state}>
      <div className={cn("flex min-w-0 flex-[1_1_16rem] items-start gap-1.5", note.tone === "warn" ? "text-warn" : note.tone === "ok" ? "text-done" : "text-mute")}>
        {running ? <Spinner size={12} label="Loading herdr" className="mt-0.5" /> : <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
        <p className="min-w-0 text-xs">
          {note.text}
          {note.mode && <span className="block text-mute-2">{note.mode}</span>}
          {note.wait && <span className="block font-semibold text-ink-2 tabular">{note.wait}</span>}
        </p>
      </div>
      {canLoad && (
        <Button size="sm" variant="secondary" icon={<Download />} loading={running} disabled={pending} onClick={() => setConfirming(true)} className="shrink-0">
          {update.state === "ready" ? "Restart herdr" : "Load now"}
        </Button>
      )}
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title={confirm.title} body={confirm.body} confirm={confirm.confirm} danger={confirm.danger} onConfirm={() => void load()} />
    </div>
  );
}

/** Per-host herdr settings: start it again when it stops, load updates when idle (and after how long). */
export function HerdrSettings({ hostId }: { hostId: string }) {
  const health = useHerdrHealth(hostId);
  const [pending, setPending] = useState(false);
  const [minutes, setMinutes] = useState<string | null>(null);
  if (!health) return null;
  const { config } = health;
  const configNote = herdrConfigNote(health);
  const save = async (change: HerdrConfigParams) => {
    setPending(true);
    try {
      await core.host(hostId).call("host.herdrConfig", change);
    } catch (err) {
      if (!(isApiError(err) && err.code === "unknown_method")) toast({ title: "Couldn't change herdr's settings", description: errorMessage(err), status: "error" });
    } finally {
      setPending(false);
    }
  };
  const commitMinutes = () => {
    const n = Number(minutes);
    setMinutes(null);
    if (minutes === null || !Number.isInteger(n) || n < 1 || n > 1440 || n === config.idleMinutes) return;
    void save({ idleMinutes: n });
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-mute-2" data-testid="herdr-settings">
      <label className="inline-flex cursor-pointer items-center gap-2 font-semibold text-ink-2">
        <Switch checked={config.autoRestart} disabled={pending} onCheckedChange={(on) => void save({ autoRestart: on })} label="Restart herdr when it stops" />
        Restart herdr when it stops
      </label>
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="inline-flex cursor-pointer items-center gap-2 font-semibold text-ink-2">
          <Switch checked={config.idleUpdate} disabled={pending} onCheckedChange={(on) => void save({ idleUpdate: on })} label="Load herdr updates when idle" />
          Load herdr updates when idle
        </label>
        {config.idleUpdate && (
          <label className="inline-flex items-center gap-1.5">
            after
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              aria-label="Minutes with nothing running before herdr loads an update"
              value={minutes ?? config.idleMinutes}
              disabled={pending}
              onChange={(e) => setMinutes(e.target.value)}
              onBlur={commitMinutes}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="well h-7 w-16 rounded-md px-2 text-center text-xs font-semibold text-ink tabular focus-ring"
            />
            min with nothing running
          </label>
        )}
      </span>
      {configNote && (
        <p className="basis-full text-warn" data-testid="herdr-config-edited">
          {configNote}
        </p>
      )}
    </div>
  );
}
