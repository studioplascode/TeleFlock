import { AlertTriangle, ArrowUpCircle, Info, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Badge, Button, cn, formatAge, Spinner, Switch, toast, useNow } from "@/design";
import { core, useHostState } from "@/core";
import type { ToolUpdate, ToolUpdates } from "@/core/gen";
import { errorMessage, isApiError } from "@/features/shell/errors";
import { Ticks } from "@/features/shell/Ticks";
import { useHerdrHealth } from "./HerdrControls";
import { HerdrSettings, HerdrUpdatePlan } from "./HerdrPlan";

const HOUR = 3_600_000;

/** "in 5h 48m", "in 12m", "soon". */
function formatIn(ms: number): string {
  if (ms < 60_000) return "soon";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 || h >= 10 ? `in ${h}h` : `in ${h}h ${m % 60}m`;
}

function ToolChip({ t, now }: { t: ToolUpdate; now: number }) {
  const fresh = t.updatedAt !== undefined && now - t.updatedAt < 24 * HOUR;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {t.updating && <Spinner size={11} label={`Updating ${t.tool}`} />}
      <span className={cn(t.error && "text-warn")}>
        {t.tool} {t.current ?? "?"}
      </span>
      {t.latest && (
        <span className="font-semibold text-accent-ink" title={`${t.tool} ${t.latest} is available`}>
          → {t.latest}
        </span>
      )}
      {fresh && !t.latest && t.updatedAt !== undefined && <span className="text-done">updated {formatAge(now - t.updatedAt)}</span>}
    </span>
  );
}

/** One note or error line under the versions. */
function Message({ t }: { t: ToolUpdate }) {
  if (!t.error && !t.note) return null;
  const Icon = t.error ? AlertTriangle : Info;
  // hostd quotes commands in backticks (`herdr update`, `brew upgrade herdr`).
  return (
    <li className={cn("flex min-w-0 items-start gap-1.5", t.error ? "text-warn" : "text-mute")}>
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        <span className="font-semibold">{t.tool}: </span>
        <Ticks text={t.error ?? t.note ?? ""} />
      </span>
    </li>
  );
}

/**
 * omp / herdr versions this host's tf-hostd keeps current (`HostInfo.tools`): available updates,
 * running checks, notes and errors, "Check now" / "Update now", and the per-host auto switch.
 * Hidden for hosts whose tf-hostd predates tool updates (no `tools`).
 */
export function ToolUpdatesRow({ hostId }: { hostId: string }) {
  const tools = useHostState(hostId)?.info.tools;
  const herdr = useHerdrHealth(hostId);
  const now = useNow(30_000);
  const [pending, setPending] = useState<"check" | "update" | "auto" | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  if (!tools || unsupported) return null;

  const fail = (what: string, err: unknown) => {
    if (isApiError(err) && err.code === "unknown_method") {
      setUnsupported(true);
      return;
    }
    toast({ title: `Couldn't ${what}`, description: errorMessage(err), status: "error" });
  };
  const run = async (checkOnly: boolean) => {
    setPending(checkOnly ? "check" : "update");
    try {
      const s: ToolUpdates = await core.host(hostId).call("host.toolsUpdate", { checkOnly });
      const list = [s.omp, s.herdr];
      // Still running after the reply window: progress keeps arriving through the host state.
      if (list.some((t) => t.updating)) return;
      const error = list.find((t) => t.error);
      const left = list.filter((t) => t.latest);
      if (error) toast({ title: `${error.tool}: ${error.error}`, status: "error" });
      else if (left.length > 0) {
        const names = left.map((t) => `${t.tool} ${t.latest}`).join(", ");
        toast(checkOnly ? { title: `Update available: ${names}`, status: "review" } : { title: `Not installed: ${names}`, description: left.find((t) => t.note)?.note, status: "idle" });
      } else toast({ title: "omp and herdr are up to date", status: "done", duration: 3000 });
    } catch (err) {
      fail(checkOnly ? "check for updates" : "update", err);
    } finally {
      setPending(null);
    }
  };
  const setAuto = async (auto: boolean) => {
    setPending("auto");
    try {
      await core.host(hostId).call("host.toolsConfig", { auto });
    } catch (err) {
      fail("change automatic updates", err);
    } finally {
      setPending(null);
    }
  };

  const updating = tools.omp.updating || tools.herdr.updating;
  const available = Boolean(tools.omp.latest || tools.herdr.latest);
  const checked = [tools.omp.checkedAt, tools.herdr.checkedAt].filter((t): t is number => t !== undefined);
  const lastCheck = checked.length ? Math.max(...checked) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md well p-2.5 text-xs" data-testid="tool-updates">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        {/* basis, not 0: on a narrow card the buttons wrap below instead of squeezing the versions under them */}
        <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs text-ink-2">
          <ToolChip t={tools.omp} now={now} />
          <ToolChip t={tools.herdr} now={now} />
          {available && !updating && <Badge tone="accent">Update available</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={pending === "check"} disabled={updating || pending !== null} onClick={() => void run(true)}>
            Check now
          </Button>
          {available && (
            <Button size="sm" variant="primary" icon={<ArrowUpCircle />} loading={pending === "update" || (updating && pending === null)} disabled={updating || pending !== null} onClick={() => void run(false)}>
              {updating ? "Updating…" : "Update now"}
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-mute-2">
        <label className="inline-flex cursor-pointer items-center gap-2 font-semibold text-ink-2">
          <Switch checked={tools.auto} disabled={pending === "auto"} onCheckedChange={(on) => void setAuto(on)} label="Update omp and herdr automatically" />
          Auto-updates {tools.auto ? "on" : "off"}
        </label>
        <span>
          {updating ? "updating now" : lastCheck !== undefined ? `checked ${formatAge(now - lastCheck)}` : "not checked yet"}
          {tools.auto && tools.nextCheckAt !== undefined && !updating && <> · next {formatIn(tools.nextCheckAt - now)}</>}
        </span>
      </div>
      {(tools.omp.error || tools.omp.note || tools.herdr.error || tools.herdr.note) && (
        <ul className="flex flex-col gap-1">
          <Message t={tools.omp} />
          {/* The plan below says what the running herdr does about its newer install: "keeps running X until it restarts" would contradict it. */}
          <Message t={herdr?.update && tools.herdr.note?.startsWith("The herdr server keeps running") ? { ...tools.herdr, note: undefined } : tools.herdr} />
        </ul>
      )}
      {herdr && (
        <div className="flex min-w-0 flex-col gap-2 border-t border-line pt-2">
          <HerdrUpdatePlan hostId={hostId} />
          <HerdrSettings hostId={hostId} />
        </div>
      )}
    </div>
  );
}
