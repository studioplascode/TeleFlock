import { ChevronDown, RotateCw, ShieldCheck } from "lucide-react";
import { type ReactNode, useContext } from "react";
import { useAgent, useCore } from "@/core";
import type { AssistantItem, Refusal, ThinkingLevel } from "@/core/gen";
import { categoryOf, firstMatch, lastRefusalRowId, modelKey } from "@/core/refusal";
import { Button } from "@/design";
import { ModelCombobox } from "@/features/ompSettings/ModelRoles";
import { alwaysDoThis, retryOnModel, useActionPending } from "@/features/refusal/actions";
import { openRefusalSettings } from "@/features/refusal/focus";
import { refusedModel, retryTarget, ruleWords, selectorName } from "@/features/refusal/model";
import { useEnsureRules } from "@/features/refusal/store";
import { SessionCtx, type SessionRef } from "../context";
import { useModels } from "../header/useModels";

/**
 * What the refusal row that ended the session's last turn offers (`caps.refusalRetry`: bridge ≥ 2.3.0, tf-hostd ≥ 0.9.0),
 * while the agent sits idle on a live link: "Retry with <model>" (the model of the host's rule for it, else Sonnet; the
 * chevron picks another) goes on with the same turn on that model, once; "Always do this for <category> refusals on
 * <model>" makes that a rule of the host (and goes on now). Only the row of the store's own session: an older refusal,
 * a preview or a subagent's transcript gets nothing.
 */
export function RefusalActions({ item }: { item: AssistantItem }) {
  const session = useContext(SessionCtx);
  const latest = useCore((s) => {
    const e = session ? s.sessions[session.key] : undefined;
    return e != null && e.items[item.id] === item && lastRefusalRowId(e.itemIds.length, (i) => e.items[e.itemIds[i] ?? ""]) === item.id;
  });
  if (!session || !latest || !item.refusal) return null;
  return <Actions session={session} item={item} refusal={item.refusal} />;
}

function Actions({ session, item, refusal }: { session: SessionRef; item: AssistantItem; refusal: Refusal }) {
  const { hostId, key } = session;
  const agent = useAgent(key);
  const online = useCore((s) => s.status[hostId]?.phase === "online");
  const caps = useCore((s) => s.sessions[key]?.meta?.caps);
  const { catalog, error } = useModels(hostId);
  const rules = useEnsureRules(hostId, online, 30_000);
  const busy = useActionPending(key);
  // idle on a live link
  if (!agent || !online || !caps || agent.omp?.link !== "live" || agent.column === "running" || agent.needs) return null;
  // The host knows the feature, this agent's omp doesn't (no bridge, or one that predates it: neither the rules nor Retry with reach it).
  if (!caps.refusalRetry) {
    return rules?.phase === "ready" ? (
      <p data-find-skip className="mt-2 text-2xs font-semibold text-mute">
        This agent's omp doesn't have the current TeleFlock bridge, which switches models after a refusal. Mark it done, then Resume it, to load it.
      </p>
    ) : null;
  }
  // the catalog and the rules are in (or failed), so the buttons don't change under the pointer
  if ((!catalog && !error) || !rules) return null;

  const models = catalog?.models ?? [];
  const refused = refusedModel(models, item.model, agent.omp?.model);
  const target = retryTarget(models, rules.rules, refusal, refused);
  const covering = refused ? firstMatch(rules.rules, refusal, refused) : undefined;
  const category = categoryOf(refusal.category);
  const always =
    rules.phase === "ready" && !covering && target && refused ? { ...(category ? { category } : {}), from: modelKey(refused), to: target.model, ...(target.thinking ? { thinking: target.thinking } : {}), after: "stay" as const } : undefined;
  const retryWith = (model: string, thinking?: ThinkingLevel) => void retryOnModel(session, { model, thinking }, models);
  const other = (trigger: ReactNode) => (
    <ModelCombobox
      models={models}
      label="Retry with another model"
      disabled={busy}
      unavailable={(id) => (refused && id === modelKey(refused) ? "The refused model" : undefined)}
      onPick={(model) => retryWith(model)}
      trigger={trigger}
    />
  );

  return (
    <div data-find-skip className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
      {target ? (
        <div className="inline-flex">
          <Button size="sm" variant="primary" icon={<RotateCw />} loading={busy} className="rounded-r-none" onClick={() => retryWith(target.model, target.thinking)}>
            Retry with {selectorName(models, target.model)}
          </Button>
          {other(
            <Button size="sm" variant="primary" aria-label="Retry with another model" title="Another model…" disabled={busy} className="rounded-l-none border-l border-on-accent/25 px-1.5">
              <ChevronDown />
            </Button>,
          )}
        </div>
      ) : (
        other(
          <Button size="sm" variant="primary" icon={<RotateCw />} disabled={busy}>
            Retry with…
          </Button>,
        )
      )}
      {always && refused && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void alwaysDoThis(session, always, models)}
          title="Saves this as a rule of the host, for every agent, and goes on with this turn now"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-sm text-left text-xs font-bold text-accent-ink underline-offset-2 hover:underline focus-ring disabled:opacity-45"
        >
          <ShieldCheck className="size-3.5 shrink-0" />
          <span>
            Always do this for {category ? `${category} refusals` : "any refusal"} on {selectorName(models, modelKey(refused))}
          </span>
        </button>
      )}
      {covering && (
        <span className="text-2xs font-semibold text-mute">
          This host's rule: {ruleWords(covering, models).when} → {ruleWords(covering, models).to}.{" "}
          <button type="button" onClick={() => openRefusalSettings(hostId)} className="rounded-xs font-bold text-accent-ink underline underline-offset-2 focus-ring">
            Refusal fallback
          </button>
        </span>
      )}
    </div>
  );
}
