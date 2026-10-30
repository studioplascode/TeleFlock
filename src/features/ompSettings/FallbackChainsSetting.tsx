import { Braces, Check, ListTree, TriangleAlert, Undo2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { OmpSetting } from "@/core/gen";
import { Button } from "@/design";
import { FallbackChainsEditor } from "@/features/agentRoles/FallbackChainsEditor";
import { type ChainMap, type ChainRow, chainRecord, chainRows, cleanChains, validateChains } from "@/features/agentRoles/roles";
import { useModels } from "@/features/session/header/useModels";
import type { RowContext } from "./controls";
import { BUILTIN_ROLES, deepEqual, MODEL_ROLES_KEY, roleRecord } from "./model";

/** omp's `retry.fallbackOn` / `retry.fallbackRevertPolicy` choices, worded for the policy line. */
const FALLBACK_ON: Record<string, string> = { any: "any error", "usage-limit": "usage limits only", "except-usage-limit": "every error but usage limits" };
const REVERT: Record<string, string> = { "cooldown-expiry": "back to the primary model after its cooldown", never: "stays on the fallback until changed" };

/** When omp walks the chains, from the sibling retry settings this omp has. Off: a warning and the switch. */
function PolicyLine({ ctx }: { ctx: RowContext }) {
  if (ctx.get("retry.modelFallback") === false) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-warn/8 px-3 py-2 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.35)]">
        <TriangleAlert className="size-3.5 shrink-0 text-warn" />
        <span className="min-w-0 flex-1 text-xs font-semibold text-warn">Fallback is off — chains are ignored</span>
        <Button size="sm" variant="secondary" onClick={() => ctx.save([{ key: "retry.modelFallback", value: true }])}>
          Turn fallback on
        </Button>
      </div>
    );
  }
  const on = ctx.get("retry.fallbackOn");
  const walks = ctx.get("retry.rateLimitWalksChain");
  const revert = ctx.get("retry.fallbackRevertPolicy");
  const parts = [
    typeof on === "string" && `Falls back on ${FALLBACK_ON[on] ?? on}`,
    walks === true ? "rate limits walk the chain at once" : walks === false && "a rate-limited turn retries its model first",
    ctx.get("retry.usageAwareFallback") === true && "usage-aware: switches before a hard limit",
    typeof revert === "string" && (REVERT[revert] ?? revert),
  ].filter((p): p is string => typeof p === "string");
  return parts.length > 0 ? <p className="text-xs text-mute">{parts.join(" · ")}</p> : null;
}

/** The rows hold something the record doesn't (an incomplete chain, a repeated key) or differ from it. */
function differs(rows: readonly ChainRow[], record: ChainMap): boolean {
  return rows.length !== Object.keys(record).length || !deepEqual(chainRecord(rows), record);
}

export interface FallbackChainsSettingProps {
  s: OmpSetting;
  ctx: RowContext;
  onCommit: (record: ChainMap) => void;
  /** The plain JSON editor of the setting (advanced, "Edit as JSON"). */
  json: ReactNode;
}

/**
 * The host-global `retry.fallbackChains`: a local draft in the guided editor, saved explicitly
 * once valid (or edited as JSON), with when omp walks the chains above it.
 */
export function FallbackChainsSetting({ s, ctx, onCommit, json }: FallbackChainsSettingProps) {
  const saved = cleanChains(s.value);
  const [rows, setRows] = useState(() => chainRows(saved));
  const [base, setBase] = useState(saved);
  const [asJson, setAsJson] = useState(false);
  const { catalog, error } = useModels(ctx.hostId);
  // The host's value re-seeds the draft only while it holds no local edits.
  if (!deepEqual(base, saved)) {
    setBase(saved);
    if (!differs(rows, base) && differs(rows, saved)) setRows(chainRows(saved));
  }
  const dirty = differs(rows, saved);
  const check = validateChains(rows);
  const customRoles = Object.keys(roleRecord(ctx.get(MODEL_ROLES_KEY))).filter((id) => !BUILTIN_ROLES.some((r) => r.id === id));
  const jsonToggle = (
    <Button
      size="sm"
      variant="ghost"
      icon={asJson ? <ListTree /> : <Braces />}
      disabled={!asJson && dirty}
      title={!asJson && dirty ? "Save or revert the changes first" : undefined}
      onClick={() => setAsJson(!asJson)}
    >
      {asJson ? "Guided editor" : "Edit as JSON"}
    </Button>
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-mute">Recovery after provider errors: once retries are spent, omp tries a chain's models in order. Chains don't pick the main model; Model roles do.</p>
      <PolicyLine ctx={ctx} />
      {asJson ? (
        <>
          {json}
          <div>{jsonToggle}</div>
        </>
      ) : (
        <>
          {error && <p className="text-xs text-warn">Couldn't load the host's models ({error}); type a provider/id selector instead.</p>}
          <FallbackChainsEditor rows={rows} onChange={setRows} models={catalog?.models ?? []} customRoles={customRoles} />
          <div className="flex flex-wrap items-center gap-2">
            {jsonToggle}
            <p className="min-w-0 flex-1 text-2xs text-mute-2">{dirty ? (check.ok ? "Unsaved changes" : "Fix the marked fields to save") : ""}</p>
            {dirty && (
              <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => setRows(chainRows(saved))}>
                Revert
              </Button>
            )}
            <Button size="sm" variant="secondary" icon={<Check />} disabled={!dirty || !check.ok} onClick={() => onCommit(chainRecord(rows))}>
              Save
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
