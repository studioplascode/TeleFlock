import { Boxes, CircleAlert, RotateCcw, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { core, parseAgentKey, toApiError } from "@/core";
import type { ApiError, SessionRoleModels } from "@/core/gen";
import { Button, Shimmer, Spinner, toast, useIsMobile } from "@/design";
import { deepEqual } from "@/features/ompSettings/model";
import { useModels } from "@/features/session/header/useModels";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { RoleOverridesEditor } from "./RoleOverridesEditor";
import { type ChainMap, type RoleMap, selectorLabel, validateOverrides } from "./roles";

type Load = { phase: "loading" } | { phase: "error"; error: ApiError } | { phase: "ready"; data: SessionRoleModels };

/** What a failed read or save means here: a bridge or hostd too old says so, with the way out. */
function problem(e: ApiError): { title: string; detail?: string; hint?: string } {
  if (e.code === "unsupported") return { title: "This agent's TeleFlock bridge is too old to change its roles", detail: e.message, hint: e.hint ?? "Restart the agent so it loads the current bridge." };
  if (e.code === "unknown_method") return { title: "This host's TeleFlock is too old for per-session roles", hint: "Update TeleFlock on the host (it updates when an updated app reconnects)." };
  return { title: e.message, hint: e.hint };
}

function Problem({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const p = problem(error);
  return (
    <div className="flex items-start gap-2.5 rounded-md bg-error/8 px-3 py-2.5 shadow-[inset_0_0_0_1px_rgb(255_77_94/0.35)]">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-error" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
        <span className="font-semibold text-ink">{p.title}</span>
        {p.detail && <span className="text-mute">{p.detail}</span>}
        {p.hint && <span className="text-mute">{p.hint}</span>}
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Model roles and fallback chains of one running session, for it alone (`agent.getRoleModels` /
 * `agent.setRoleModels`): the host's omp settings stay as they are. Dialog on desktop, sheet on
 * phones; mounted by `SessionDialogs` while `useSessionUi().dialog[key] === "roles"`.
 */
export function SessionRolesDialog({ agentKey, open, onOpenChange }: { agentKey: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const mobile = useIsMobile();
  const { catalog } = useModels(hostId, open);
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [roles, setRoles] = useState<RoleMap>({});
  const [chains, setChains] = useState<ChainMap>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [warning, setWarning] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);

  // Each opening reads the session afresh.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ phase: "loading" });
    setSaveError(null);
    setWarning(undefined);
    core
      .host(hostId)
      .call("agent.getRoleModels", { agentId })
      .then(
        (data) => {
          if (!live) return;
          setLoad({ phase: "ready", data });
          setRoles(data.session);
          setChains(data.sessionChains);
        },
        (e: unknown) => live && setLoad({ phase: "error", error: toApiError(e) }),
      );
    return () => {
      live = false;
    };
  }, [open, hostId, agentId, attempt]);

  const data = load.phase === "ready" ? load.data : undefined;
  const dirty = !!data && (!deepEqual(roles, data.session) || !deepEqual(chains, data.sessionChains));
  const valid = validateOverrides(roles, chains).ok;

  const save = async () => {
    if (!data || !dirty || !valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await core.host(hostId).call("agent.setRoleModels", { agentId, roleModels: roles, fallbackChains: chains });
      setLoad({ phase: "ready", data: next });
      setRoles(next.session);
      setChains(next.sessionChains);
      setWarning(next.warning);
      toast({ title: "Roles updated for this session", description: next.warning, status: "done", duration: next.warning ? 6000 : 2600 });
    } catch (e) {
      setSaveError(toApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    if (!data) return;
    setRoles(data.session);
    setChains(data.sessionChains);
    setSaveError(null);
  };

  const footer = (
    <div className="flex w-full items-center justify-end gap-2">
      {dirty && (
        <Button variant="ghost" icon={<Undo2 />} disabled={saving} onClick={revert}>
          Revert
        </Button>
      )}
      {!mobile && (
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      )}
      <Button variant="primary" loading={saving} disabled={!dirty || !valid} onClick={() => void save()} className={mobile ? "flex-1" : undefined}>
        Save for this session
      </Button>
    </div>
  );

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Model roles · this session only"
      description="Only this agent's omp changes; the host's omp settings stay as they are."
      icon={<Boxes />}
      width={760}
      tall
      footer={data ? footer : undefined}
    >
      {load.phase === "loading" && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-mute">
          <Spinner size={14} /> <Shimmer>Reading the session's roles…</Shimmer>
        </div>
      )}
      {load.phase === "error" && <Problem error={load.error} onRetry={() => setAttempt((n) => n + 1)} />}
      {data && (
        <div className="flex min-w-0 flex-col gap-4 pb-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md well px-3 py-2 text-xs">
            <span className="text-mute">Running now:</span>
            {data.active ? (
              <>
                <span className="font-semibold text-ink">{selectorLabel(catalog?.models ?? [], data.active)}</span>
                <span className="font-mono text-2xs text-mute-2">{data.active}</span>
              </>
            ) : (
              <span className="text-mute-2">unknown</span>
            )}
          </div>
          <p className="text-xs text-mute">New subagents start with these roles; subagents already running keep theirs.</p>
          {warning && (
            <p className="flex items-start gap-1.5 text-xs font-semibold text-warn">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              <span>{warning}</span>
            </p>
          )}
          <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
            <RoleOverridesEditor
              hostId={hostId}
              value={roles}
              onChange={setRoles}
              host={data.host}
              defaultRow="editable"
              chains={chains}
              onChainsChange={setChains}
              hostChains={data.hostChains}
            />
          </fieldset>
          {saveError && <Problem error={saveError} />}
        </div>
      )}
    </ResponsiveDialog>
  );
}
