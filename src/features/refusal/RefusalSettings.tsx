import { ArrowDown, ArrowRight, ArrowUp, Lightbulb, Pencil, Plus, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toApiError, useHostIds, useHosts } from "@/core";
import type { ModelInfo, RefusalRule } from "@/core/gen";
import { MAX_RULES } from "@/core/refusal";
import { Button, cn, IconButton, toast } from "@/design";
import { Section } from "@/features/settings/parts";
import { useModels } from "@/features/session/header/useModels";
import { bringIntoView, REFUSAL_SECTION_ID, useRefusalFocus } from "./focus";
import { draftOf, moved, NEW_DRAFT, restored, ruleWords, sameRules, selectorName, suggestedRule, withRule, without } from "./model";
import { RuleEditor } from "./RuleEditor";
import { changeRules, useEnsureRules } from "./store";

/**
 * Settings → Refusal fallback: per host, what to do when the provider refuses a turn (`host.refusalFallback`,
 * `host.refusalFallbackSet`): the rules in the order they apply, add / change / remove / reorder, and the
 * Opus → Sonnet suggestion. A host before 0.9.0 says what it needs.
 */
export function RefusalFallbackSettings({ index }: { index: number }) {
  const ids = useHostIds();
  const request = useRefusalFocus((s) => s.request);
  const done = useRefusalFocus((s) => s.done);
  const card = useRef<HTMLDivElement>(null);
  // the host (or the card) lit up after a link from the omp settings page or a refusal row
  const [lit, setLit] = useState<{ hostId: string; n: number } | null>(null);
  useEffect(() => {
    if (!request) return;
    // the whole card comes into view (its title first); the host the link came from is the one that lights up
    const host = request.hostId ? card.current?.querySelector<HTMLElement>(`[data-refusal-host="${CSS.escape(request.hostId)}"]`) : null;
    bringIntoView(card.current);
    setLit({ hostId: host ? request.hostId : "", n: request.n });
    done(request.n);
  }, [request, done]);
  return (
    <div id={REFUSAL_SECTION_ID} ref={card} className="relative scroll-mt-4 max-md:scroll-mt-16">
      <Section
        index={index}
        icon={<ShieldAlert />}
        title="Refusal fallback"
        description="When a provider refuses a turn (a cyber refusal, say), this host switches the agent to another model and goes on with the same turn, by itself, with no app connected. The first rule that matches decides."
      >
        {ids.length === 0 ? <p className="py-2 text-sm text-mute-2">No hosts yet.</p> : ids.map((id) => <HostRules key={id} hostId={id} lit={lit?.hostId === id ? lit.n : 0} />)}
      </Section>
      {lit && lit.hostId === "" && <Flash n={lit.n} className="inset-0" />}
    </div>
  );
}

/** A brief glow on what a link brought into view. */
function Flash({ n, className }: { n: number; className?: string }) {
  return (
    <span
      key={n}
      aria-hidden
      className={cn(
        "tf-keep pointer-events-none absolute animate-[tf-flash_1.6s_ease-out_0.3s_both] rounded-tile bg-accent/[0.05] shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-accent)_70%,transparent),0_0_28px_-6px_color-mix(in_srgb,var(--color-accent)_50%,transparent)]",
        className,
      )}
    />
  );
}

interface Editing {
  /** The rule being changed; `null`: a new one. */
  index: number | null;
  rule?: RefusalRule;
}

function HostRules({ hostId, lit }: { hostId: string; lit: number }) {
  const name = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const online = useHosts((h) => h.status[hostId]?.phase === "online");
  const state = useEnsureRules(hostId, online);
  const { catalog } = useModels(hostId, online);
  const models: readonly ModelInfo[] = catalog?.models ?? [];
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const rules = state?.rules ?? [];
  const ready = state?.phase === "ready";
  const suggestion = ready && online && !editing ? suggestedRule(models, rules) : undefined;

  /** Saves `change` of the host's rules as they are once other changes are in (`changeRules`). */
  const save = async (change: (now: readonly RefusalRule[]) => readonly RefusalRule[] | undefined, what: string): Promise<boolean> => {
    setSaving(true);
    try {
      await changeRules(hostId, change);
      return true;
    } catch (e) {
      const err = toApiError(e);
      toast({ title: `Couldn't ${what}`, description: err.hint ? `${err.message} — ${err.hint}` : err.message, status: "error" });
      return false;
    } finally {
      setSaving(false);
    }
  };
  /** A list made from the rules shown here: saved only while they are still the host's (else they show as they are now). */
  const asShown = (next: RefusalRule[]) => (now: readonly RefusalRule[]) => {
    if (!sameRules(now, rules)) throw new Error("The rules changed meanwhile: they show as they are now, so try again");
    return next;
  };
  const remove = async (at: number) => {
    const gone = rules[at];
    if (!gone || !(await save((now) => without(now, gone, at), "remove the rule"))) return;
    toast({
      title: `Removed: ${ruleWords(gone, models).when}`,
      status: "idle",
      duration: 8000,
      // back into the rules as they are then, at its place: what changed since stays
      action: { label: "Undo", onClick: () => void save((now) => restored(now, gone, at), "put the rule back") },
    });
  };

  const status = !online
    ? state?.phase === "ready"
      ? "Connect the host to change it."
      : "Connect the host to see its rules."
    : !state
      ? "Checking…"
      : state.phase === "old"
        ? "Needs TeleFlock 0.9.0 on this host"
        : state.phase === "error"
          ? (state.error ?? "Couldn't read the host's rules")
          : rules.length === 0
            ? "No rules: a refusal stops the turn, as omp leaves it."
            : `${rules.length} ${rules.length === 1 ? "rule" : "rules"}${rules.length > 1 ? ", the first that matches decides" : ""}`;

  return (
    <div data-refusal-host={hostId} className="relative flex scroll-mt-4 flex-col gap-3 py-3 first:pt-1 last:pb-1 max-md:scroll-mt-16 max-md:py-2.5">
      {lit > 0 && <Flash n={lit} className="inset-y-0 -inset-x-2 rounded-lg" />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="text-sm font-bold text-ink">{name}</div>
          <div className="text-xs text-mute">{status}</div>
        </div>
        {ready && online && !editing && (
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={saving || rules.length >= MAX_RULES} onClick={() => setEditing({ index: null })}>
            Add rule
          </Button>
        )}
      </div>
      {state?.notice && <p className="rounded-md bg-warn/8 px-3 py-2 text-xs font-semibold text-warn shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warn)_35%,transparent)]">{state.notice}</p>}
      {ready && (rules.length > 0 || editing) && (
        <ol className="flex flex-col divide-y divide-line rounded-lg shadow-hairline">
          {rules.map((rule, i) =>
            editing?.index === i ? (
              <li key={i} className="p-2">
                <RuleEditor models={models} rules={rules} editing={i} initial={draftOf(rule)} saving={saving} onCancel={() => setEditing(null)} onSave={(next) => void save(asShown(withRule(rules, next, i)), "save the rule").then((ok) => ok && setEditing(null))} />
              </li>
            ) : (
              <RuleRow
                key={`${i}:${JSON.stringify(rule)}`}
                n={i + 1}
                rule={rule}
                models={models}
                last={i === rules.length - 1}
                busy={saving || !online || editing !== null}
                onEdit={() => setEditing({ index: i, rule })}
                onMove={(by) => void save(asShown(moved(rules, i, by)), "reorder the rules")}
                onRemove={() => void remove(i)}
              />
            ),
          )}
          {editing?.index === null && (
            <li className="p-2">
              <RuleEditor models={models} rules={rules} editing={null} initial={NEW_DRAFT} saving={saving} onCancel={() => setEditing(null)} onSave={(next) => void save(asShown(withRule(rules, next, null)), "add the rule").then((ok) => ok && setEditing(null))} />
            </li>
          )}
        </ol>
      )}
      {suggestion && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-accent/[0.07] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]">
          <Lightbulb className="size-4 shrink-0 text-accent-hi" aria-hidden />
          <div className="min-w-0 flex-1 basis-56 text-xs text-ink-2">
            <b className="text-ink">
              {selectorName(models, suggestion.from)} → {selectorName(models, suggestion.to)}
            </b>{" "}
            for cyber refusals. Sonnet's safety classifier is the newer one.
          </div>
          <Button size="sm" variant="secondary" icon={<Plus />} loading={saving} onClick={() => void save(asShown(withRule(rules, suggestion, null)), "add the rule")}>
            Add this rule
          </Button>
        </div>
      )}
    </div>
  );
}

function RuleRow({ n, rule, models, last, busy, onEdit, onMove, onRemove }: { n: number; rule: RefusalRule; models: readonly ModelInfo[]; last: boolean; busy: boolean; onEdit(): void; onMove(by: -1 | 1): void; onRemove(): void }) {
  const words = ruleWords(rule, models);
  const { when, to } = words;
  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5 max-md:px-2.5">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-ink/8 text-2xs font-bold text-mute tabular" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-bold text-ink">
          <span>{when}</span>
          <ArrowRight className="size-3.5 shrink-0 text-mute" aria-hidden />
          <span className="sr-only">goes to</span>
          <span>{to}</span>
        </div>
        <div className="text-xs text-mute">{words.then}</div>
      </div>
      <div className="flex shrink-0 items-center">
        {(n > 1 || !last) && (
          <>
            <IconButton size="sm" label={`Move rule ${n} up`} disabled={busy || n === 1} onClick={() => onMove(-1)}>
              <ArrowUp />
            </IconButton>
            <IconButton size="sm" label={`Move rule ${n} down`} disabled={busy || last} onClick={() => onMove(1)}>
              <ArrowDown />
            </IconButton>
          </>
        )}
        <IconButton size="sm" label={`Change rule ${n}`} disabled={busy} onClick={onEdit}>
          <Pencil />
        </IconButton>
        <IconButton size="sm" label={`Remove rule ${n}`} disabled={busy} onClick={onRemove}>
          <X />
        </IconButton>
      </div>
    </li>
  );
}
