import { ArrowRight, Blocks, Check, CircleCheck, Copy, Info, Lock, Plus, RefreshCw, Server, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { core, toApiError, useHostIds, useHosts, useUi } from "@/core";
import type { SyncApplied, SyncItemResult, SyncPlan, SyncProfile, SyncSignIn } from "@/core/gen";
import { Button, Chip, cn, EmptyState, Select, type SelectOption, Skeleton, Spinner, toast } from "@/design";
import { connAction } from "@/features/hosts/ConnStatusCard";
import { plural } from "@/features/mcp/model";
import { type PaletteCommand, usePaletteCommands } from "@/features/palette/registry";
import { PHASE_TEXT } from "@/features/shell/status";
import { Ticks } from "@/features/shell/Ticks";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { useDialogSession } from "@/features/workspace/shared/useDialogSession";
import { openHostSync } from "./entry";
import {
  type ApplyPhase,
  appliedSummary,
  applyCopy,
  carrySelection,
  changeLabel,
  chosenIds,
  compareHosts,
  type ComparePhase,
  countsLine,
  defaultSelection,
  describeFailure,
  type FailureView,
  mergeResults,
  planCounts,
  reloadSummary,
  SECTION_TITLE,
  secretIds,
  selectable,
  stepText,
  type SyncCall,
  SyncStepError,
} from "./model";
import { CHANGE_TONE, PlanSections, placeText, SECTION_ICON } from "./PlanView";

const callHost: SyncCall = (hostId, method, params) => core.host(hostId).call(method, params as never);

/** The source's export and the target's plan for it. */
interface Compared {
  sourceId: string;
  targetId: string;
  profile: SyncProfile;
  plan: SyncPlan;
}

type View =
  | { kind: "pick" }
  | { kind: "loading"; phase: ComparePhase }
  | { kind: "plan" }
  | { kind: "confirm" }
  | { kind: "applying"; phase: ApplyPhase; secrets: boolean }
  | { kind: "result"; applied: SyncApplied; before: SyncPlan }
  | { kind: "error"; failure: SyncStepError; during: "compare" | "apply" };

/**
 * "Make <host> like another host" (`useUi().dialog.kind === "hostSync"`, mounted once by the app). Also
 * contributes the palette's "Make a host like another…" while there are two hosts or more.
 */
export function HostSyncDialog() {
  const { open, payload, gen, close } = useDialogSession("hostSync");
  const many = useHosts((h) => h.profiles.length > 1);
  const commands = useMemo<PaletteCommand[]>(
    () =>
      many
        ? [
            {
              id: "host-sync",
              title: "Make a host like another…",
              group: "Actions",
              keywords: ["copy", "sync", "clone", "same", "settings", "model roles", "mcp", "sign-ins", "omp", "host"],
              icon: <Copy />,
              hint: "Copy omp settings, model roles and MCP servers from one host to another",
              run: () => openHostSync(),
            },
          ]
        : [],
    [many],
  );
  usePaletteCommands(commands);
  if (!payload) return null;
  return <HostSyncFlow key={gen} open={open} initialTarget={payload.hostId} initialSource={payload.sourceHostId} onClose={close} />;
}

function HostSyncFlow({ open, initialTarget, initialSource, onClose }: { open: boolean; initialTarget?: string; initialSource?: string; onClose(): void }) {
  const ids = useHostIds();
  const profiles = useHosts((h) => h.profiles);
  const status = useHosts((h) => h.status);
  const openDialog = useUi((s) => s.openDialog);
  const sourcePicker = useId();
  const [fixedTarget] = useState(() => (initialTarget && ids.includes(initialTarget) ? initialTarget : undefined));
  const [targetId, setTargetId] = useState(fixedTarget);
  const [sourceId, setSourceId] = useState(initialSource && initialSource !== fixedTarget ? initialSource : undefined);
  const [view, setView] = useState<View>({ kind: "pick" });
  const [compared, setCompared] = useState<Compared | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** Every copy's outcome in this dialog, by item: failures stay on their rows when reviewing again. */
  const [results, setResults] = useState<ReadonlyMap<string, SyncItemResult>>(() => new Map());
  /** Newest request wins: a new pick, comparison or copy makes the answers of older ones stale. */
  const token = useRef(0);
  const shown = useRef(open);
  useEffect(() => {
    shown.current = open;
  }, [open]);

  const nameOf = (id: string | undefined) => (id ? (profiles.find((p) => p.id === id)?.name ?? id) : "");
  const isOnline = (id: string | undefined) => !!id && status[id]?.phase === "online";
  const source = nameOf(sourceId);
  const target = nameOf(targetId);
  /** The copy is in flight: the hosts stay as they are until it answers. */
  const applying = view.kind === "applying";

  const compare = (s: string, t: string, keep?: { selected: ReadonlySet<string>; plan: SyncPlan }) => {
    const mine = ++token.current;
    setView({ kind: "loading", phase: "export" });
    compareHosts(callHost, s, t, (phase) => {
      if (mine === token.current) setView({ kind: "loading", phase });
    }).then(
      ({ profile, plan }) => {
        if (mine !== token.current) return;
        setCompared({ sourceId: s, targetId: t, profile, plan });
        setSelected(keep ? carrySelection(keep.selected, keep.plan, plan) : defaultSelection(plan));
        setView({ kind: "plan" });
      },
      (err: unknown) => {
        if (mine !== token.current) return;
        setView({ kind: "error", failure: err instanceof SyncStepError ? err : new SyncStepError("export", s, toApiError(err)), during: "compare" });
      },
    );
  };

  // Compare as soon as both hosts are picked and online (again after a pick, or once a host connects).
  const ready = !!sourceId && !!targetId && sourceId !== targetId && isOnline(sourceId) && isOnline(targetId);
  const waiting = open && ready && view.kind === "pick";
  const startCompare = useEffectEvent(() => {
    if (sourceId && targetId) compare(sourceId, targetId);
  });
  useEffect(() => {
    if (waiting) startCompare();
  }, [waiting, sourceId, targetId]);

  const resetPlan = () => {
    token.current += 1;
    setCompared(null);
    setView({ kind: "pick" });
  };
  const pickSource = (id: string) => {
    setSourceId(id);
    resetPlan();
  };
  const pickTarget = (id: string) => {
    setTargetId(id);
    if (id === sourceId) setSourceId(undefined);
    resetPlan();
  };
  /** Export and plan again: after a failure, or to see what changed meanwhile (the choice carries over). */
  const compareAgain = () => {
    if (compared) compare(compared.sourceId, compared.targetId, { selected, plan: compared.plan });
    else if (sourceId && targetId) compare(sourceId, targetId);
  };

  const apply = () => {
    if (!compared) return;
    const mine = ++token.current;
    const req = { ...compared, selected };
    const secrets = secretIds(compared.plan, selected).length > 0;
    const targetName = nameOf(compared.targetId);
    setView({ kind: "applying", phase: secrets ? "key" : "apply", secrets });
    applyCopy(callHost, req, (phase) => {
      if (mine === token.current) setView({ kind: "applying", phase, secrets });
    }).then(
      (applied) => {
        const sum = appliedSummary(applied, targetName);
        toast({ title: sum.title, description: sum.description, status: sum.ok ? "done" : "error" });
        if (mine !== token.current) return;
        setResults((prev) => mergeResults(prev, applied.results));
        setCompared({ ...compared, plan: applied.plan });
        setSelected(defaultSelection(applied.plan));
        setView({ kind: "result", applied, before: compared.plan });
      },
      (err: unknown) => {
        const failure = err instanceof SyncStepError ? err : new SyncStepError("apply", compared.targetId, toApiError(err));
        // Closed meanwhile: the outcome still needs saying.
        if (!shown.current) {
          const f = describeFailure(failure, nameOf, compared.sourceId, compared.targetId);
          toast({ title: f.title, description: f.message, status: "error" });
        }
        if (mine === token.current) setView({ kind: "error", failure, during: "apply" });
      },
    );
  };

  const plan = compared?.plan;
  const chosen = plan ? chosenIds(plan, selected).length : 0;
  const secretCount = plan ? secretIds(plan, selected).length : 0;
  const blocked = !isOnline(targetId) ? `${target} isn't connected` : secretCount > 0 && !isOnline(sourceId) ? `${source} isn't connected: it seals the secrets` : null;

  const option = (id: string): SelectOption => ({ value: id, label: nameOf(id), hint: isOnline(id) ? undefined : "offline", disabled: !isOnline(id) });
  const candidates = ids.filter((id) => id !== targetId);
  // Picked hosts that aren't online; before a source is picked, the candidates when none of them is.
  const waitFor = !sourceId && candidates.length > 0 && !candidates.some(isOnline) ? candidates.slice(0, 3) : [];
  const offline = [...new Set([targetId, sourceId, ...waitFor])].filter((id): id is string => !!id && !isOnline(id));

  const pickers = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <label htmlFor={sourcePicker} className="text-xs font-bold text-mute">
          Copy from
        </label>
        <Select
          id={sourcePicker}
          value={sourceId ?? ""}
          onValueChange={pickSource}
          options={candidates.map(option)}
          placeholder={candidates.length ? "Pick a host" : "No other host"}
          disabled={applying || candidates.length === 0}
          className="min-w-44 max-md:flex-1"
        />
        <ArrowRight className="size-4 shrink-0 text-mute-2" aria-hidden />
        {fixedTarget ? (
          <span className="inline-flex h-10 items-center px-1 text-sm font-bold text-ink">{target}</span>
        ) : (
          <Select aria-label="Host to change" value={targetId ?? ""} onValueChange={pickTarget} options={ids.map(option)} placeholder="Host to change" disabled={applying} className="min-w-44 max-md:flex-1" />
        )}
      </div>
      {offline.map((id) => (
        <OfflineNote
          key={id}
          hostId={id}
          name={nameOf(id)}
          why={!compared ? "Both hosts need to be online to compare." : id === compared.targetId ? "The changes need it online." : "Its secrets can't be sealed without it; everything else still applies."}
          onLeave={onClose}
        />
      ))}
    </div>
  );

  let body: ReactNode;
  switch (view.kind) {
    case "pick":
      body = (
        <Intro
          hasOthers={ids.length > 1}
          onAddHost={() => openDialog({ kind: "hostEditor" })}
          hint={!sourceId ? (targetId ? `Pick the host whose omp setup ${target} should get.` : "Pick the host to change and the host to copy from.") : !targetId ? "Pick the host to change." : null}
        />
      );
      break;
    case "loading":
      body = <Loading text={stepText(view.phase, source, target)} />;
      break;
    case "plan":
    case "confirm":
      if (!compared) break;
      body =
        view.kind === "confirm" ? (
          <ConfirmSecrets plan={compared.plan} selected={selected} source={source} target={target} />
        ) : (
          <PlanBody plan={compared.plan} selected={selected} onSelect={setSelected} source={source} target={target} results={results} onCompareAgain={compareAgain} />
        );
      break;
    case "applying":
      body = <Applying phase={view.phase} secrets={view.secrets} source={source} target={target} />;
      break;
    case "result":
      body = <Result applied={view.applied} before={view.before} source={source} target={target} onReview={() => setView({ kind: "plan" })} />;
      break;
    case "error":
      body = <Failure view={describeFailure(view.failure, nameOf, sourceId ?? "", targetId ?? "")} />;
      break;
  }

  let footer: ReactNode;
  const cancel = (
    <Button variant="ghost" onClick={onClose}>
      {view.kind === "applying" ? "Close" : "Cancel"}
    </Button>
  );
  if (view.kind === "confirm") {
    footer = (
      <FooterRow info={blocked && <span className="text-warn">{blocked}</span>}>
        <Button variant="ghost" onClick={() => setView({ kind: "plan" })}>
          Back
        </Button>
        <Button variant="primary" icon={<Lock />} disabled={!!blocked} onClick={apply}>
          Copy secrets and apply
        </Button>
      </FooterRow>
    );
  } else if (view.kind === "error") {
    const f = describeFailure(view.failure, nameOf, sourceId ?? "", targetId ?? "");
    const again = view.during === "compare" || f.restart ? compareAgain : apply;
    footer = (
      <FooterRow>
        {compared && view.during === "apply" ? (
          <Button variant="ghost" onClick={() => setView({ kind: "plan" })}>
            Back to the list
          </Button>
        ) : (
          cancel
        )}
        <Button variant="primary" icon={<RefreshCw />} onClick={again}>
          {f.restart ? "Start again" : "Try again"}
        </Button>
      </FooterRow>
    );
  } else if (view.kind === "result") {
    footer = (
      <FooterRow>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </FooterRow>
    );
  } else {
    footer = (
      <FooterRow
        info={
          view.kind === "plan" ? (
            <>
              <span className="font-semibold text-ink-2 tabular">
                {chosen} selected{secretCount > 0 ? ` (${plural(secretCount, "secret")})` : ""}
              </span>
              {blocked && <span className="text-warn">{blocked}</span>}
            </>
          ) : null
        }
      >
        {cancel}
        <Button variant="primary" disabled={view.kind !== "plan" || chosen === 0 || !!blocked} onClick={() => (secretCount > 0 ? setView({ kind: "confirm" }) : apply())}>
          {targetId ? `Apply to ${target}` : "Apply"}
        </Button>
      </FooterRow>
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={targetId ? `Make ${target} like another host` : "Make a host like another"}
      description="Copies omp's settings, model roles and MCP servers after you review each change, and sign-ins and other secrets only when you tick them: encrypted on the other host for this one and never shown, TeleFlock only passes them on."
      icon={<Copy />}
      width={880}
      maxHeight="94dvh"
      tall
      className="md:h-[min(86dvh,860px)]"
      footer={footer}
    >
      <div className="flex min-h-full flex-col gap-5 pb-1">
        {pickers}
        {body}
      </div>
    </ResponsiveDialog>
  );
}

function FooterRow({ info, children }: { info?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
      {info && <div className="flex min-w-0 flex-col text-xs">{info}</div>}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** A host the copy needs that isn't online, with the one thing to do about it (Connect, Retry, Sign in, Verify). */
function OfflineNote({ hostId, name, why, onLeave }: { hostId: string; name: string; why: string; onLeave(): void }) {
  const st = useHosts((h) => h.status[hostId]);
  const action = connAction(st, hostId);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-white/[0.04] px-3 py-2 text-xs text-ink-2 shadow-hairline">
      <Info className="size-3.5 shrink-0 text-mute" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-ink">
          {name} {PHASE_TEXT[st?.phase ?? "idle"]}.
        </span>{" "}
        {why}
      </span>
      {action && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            // Verify happens on the Hosts page, under this dialog.
            if (action.label === "Verify") onLeave();
            action.run();
          }}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}

/**
 * EmptyState's icon floats forever, and Calm keeps loops inside dialogs running (§6.3): hold it
 * still, so only a Spinner moves while a call runs.
 */
const STILL_ICON = "[&>div:first-child]:animate-none";

const WHAT_COPIES = [
  { section: "settings", text: "omp's global settings (config.yml), key by key" },
  { section: "roles", text: "The model behind each role, and its fallback chain" },
  { section: "mcp", text: "Your user-level MCP servers; their secret values only if you tick them" },
  { section: "signIns", text: "Accounts and API keys omp signs in with, only if you tick them" },
] as const;

function Intro({ hasOthers, onAddHost, hint }: { hasOthers: boolean; onAddHost(): void; hint: string | null }) {
  if (!hasOthers) {
    return (
      <EmptyState
        className={STILL_ICON}
        icon={<Server />}
        title="No other host to copy from"
        description="Add a second host: then either one can be made like the other."
        action={
          <Button variant="primary" icon={<Plus />} onClick={onAddHost}>
            Add a host
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {hint && <p className="text-sm text-ink-2">{hint}</p>}
      <p className="text-sm text-mute">TeleFlock compares the two hosts and lists every difference for you to choose from. Nothing changes until you apply.</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {WHAT_COPIES.map(({ section, text }) => {
          const Icon = SECTION_ICON[section];
          return (
            <li key={section} className="flex items-start gap-3 rounded-lg bg-white/[0.03] p-3 shadow-hairline">
              <Icon className="mt-0.5 size-4 shrink-0 text-mute" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink">{SECTION_TITLE[section]}</p>
                <p className="text-xs text-mute">{text}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="flex items-start gap-2 text-xs text-mute">
        <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
        Secrets travel only when you tick them: the other host encrypts them for a one-time key this host makes, TeleFlock passes the sealed box on, and nobody sees them on the way.
      </p>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <p className="flex items-center gap-2 text-sm font-semibold text-ink-2">
        <Spinner size={14} label={text} />
        {text}
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function PlanBody({
  plan,
  selected,
  onSelect,
  source,
  target,
  results,
  onCompareAgain,
}: {
  plan: SyncPlan;
  selected: ReadonlySet<string>;
  onSelect(next: Set<string>): void;
  source: string;
  target: string;
  results: ReadonlyMap<string, SyncItemResult>;
  onCompareAgain(): void;
}) {
  const counts = planCounts(plan);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-ink-2 tabular">{countsLine(counts)}</p>
        <span className="text-2xs text-mute-2">
          omp {plan.sourceOmp} on {source} · {plan.targetOmp} on {target}
        </span>
        <Button size="sm" variant="ghost" icon={<RefreshCw />} className="ml-auto" onClick={onCompareAgain}>
          Compare again
        </Button>
      </div>
      {plan.notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {plan.notes.map((n) => (
            <li key={n} className="flex items-start gap-2 text-xs text-mute">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                <Ticks text={n} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {counts.differences === 0 ? (
        <EmptyState
          className={STILL_ICON}
          icon={<CircleCheck />}
          title={`${target} already matches ${source}`}
          description={`omp's settings, model roles, MCP servers and sign-ins: ${plural(counts.same, "item")} compared, all the same.`}
        />
      ) : (
        <PlanSections plan={plan} selected={selected} onSelect={onSelect} source={source} target={target} results={results} />
      )}
    </div>
  );
}

function ConfirmSecrets({ plan, selected, source, target }: { plan: SyncPlan; selected: ReadonlySet<string>; source: string; target: string }) {
  const secrets = plan.items.filter((i) => i.secret && selected.has(i.id) && selectable(i));
  const oauth = secrets.filter((i) => i.section === "signIns" && ((i.from ?? i.to) as SyncSignIn | undefined)?.kind === "oauth").length;
  const replaced = secrets.filter((i) => i.change === "unknown").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3 rounded-lg bg-accent/8 p-3.5 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent-hi" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1.5 text-sm">
          <h3 className="font-bold text-ink">
            Copy {plural(secrets.length, "secret")} to {target}?
          </h3>
          <p className="text-ink-2">
            {source} encrypts them with a one-time key {target} made for this copy: only {target} can open them, and only once.
          </p>
          <p className="text-ink-2">TeleFlock only relays the sealed box. It never sees, keeps or shows what's inside.</p>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {secrets.map((i) => {
          const place = placeText(i);
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md bg-white/[0.03] px-3 py-2 shadow-hairline">
              <Lock className="size-3.5 shrink-0 text-mute" aria-hidden />
              <span className="min-w-0 text-sm font-semibold text-ink">{i.label}</span>
              <span className="text-2xs text-mute-2">{place ? `${SECTION_TITLE[i.section]} · ${place}` : SECTION_TITLE[i.section]}</span>
              <Chip tone={CHANGE_TONE[i.change]} className="ml-auto">
                {changeLabel(i.change, target)}
              </Chip>
            </li>
          );
        })}
      </ul>
      {replaced > 0 && (
        <p className="text-xs text-mute">
          {target} already has {replaced === 1 ? "one of these" : `${replaced} of these`}: copying replaces {target}'s own.
        </p>
      )}
      {oauth > 0 && (
        <p className="flex items-start gap-2 rounded-md bg-warn/8 p-2.5 text-xs text-ink-2 shadow-[inset_0_0_0_1px_rgb(251_191_36/0.3)]">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
          <span>
            Some providers rotate refresh tokens: once {target} refreshes {oauth === 1 ? "this sign-in" : "these sign-ins"}, {source} may be signed out of{" "}
            {oauth === 1 ? "that account" : "those accounts"} and need to sign in again.
          </span>
        </p>
      )}
    </div>
  );
}

function Applying({ phase, secrets, source, target }: { phase: ApplyPhase; secrets: boolean; source: string; target: string }) {
  const steps: ApplyPhase[] = secrets ? ["key", "seal", "apply"] : ["apply"];
  const at = steps.indexOf(phase);
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => (
          <li key={s} className={cn("flex items-center gap-2.5 text-sm", i < at ? "text-mute" : i === at ? "font-semibold text-ink" : "text-mute-2")}>
            {i < at ? (
              <Check className="size-4 shrink-0 text-done" aria-label="Done" />
            ) : i === at ? (
              <Spinner size={16} label="Working" />
            ) : (
              <span className="grid size-4 shrink-0 place-items-center" aria-hidden>
                <span className="size-1.5 rounded-full bg-white/25" />
              </span>
            )}
            {stepText(s, source, target)}
          </li>
        ))}
      </ol>
      <p className="text-xs text-mute">You can close this: the copy finishes on {target} either way, and TeleFlock tells you how it went.</p>
    </div>
  );
}

function Result({ applied, before, source, target, onReview }: { applied: SyncApplied; before: SyncPlan; source: string; target: string; onReview(): void }) {
  const byId = new Map([...applied.plan.items, ...before.items].map((i) => [i.id, i]));
  const sum = appliedSummary(applied, target);
  const reload = reloadSummary(applied.mcpReload);
  const left = planCounts(applied.plan);
  const unknown = applied.plan.items.filter((i) => i.change === "unknown").length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        {sum.ok ? <CircleCheck className="size-5 shrink-0 text-done" aria-hidden /> : <TriangleAlert className="size-5 shrink-0 text-warn" aria-hidden />}
        <h3 className="font-display text-lg font-bold text-ink">{sum.title}</h3>
      </div>
      <ul className="flex flex-col gap-1.5">
        {applied.results.map((r) => {
          const item = byId.get(r.id);
          return (
            <li key={r.id} className="flex items-start gap-2.5 rounded-md bg-white/[0.03] px-3 py-2 shadow-hairline">
              {r.ok ? <Check className="mt-0.5 size-4 shrink-0 text-done" aria-label="Copied" /> : <X className="mt-0.5 size-4 shrink-0 text-error" aria-label="Failed" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold text-ink">{item?.label ?? r.id}</span>
                  {item && <span className="text-2xs text-mute-2">{SECTION_TITLE[item.section]}</span>}
                </div>
                {r.error && (
                  <p className="text-xs text-[#ffb1c1]">
                    <Ticks text={r.error} />
                  </p>
                )}
                {r.note && (
                  <p className="text-xs text-mute">
                    <Ticks text={r.note} />
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {applied.mcpReload && (
        <div className="flex flex-col gap-1 rounded-md well p-3 text-xs">
          <p className="flex items-start gap-2 font-semibold text-ink-2">
            <Blocks className="mt-px size-3.5 shrink-0 text-mute" aria-hidden />
            {reload}
          </p>
          {applied.mcpReload.errors.map((e) => (
            <p key={e} className="pl-[22px] text-[#ffb1c1]">
              <Ticks text={e} />
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-white/[0.03] p-3 shadow-hairline">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{left.differences ? `Now: ${countsLine(left)}` : `${target} now matches ${source}`}</p>
          <p className="text-xs text-mute">
            {target} compared itself with {source} again after the copy.
            {unknown > 0 ? " Secrets can't be compared, so the ones both hosts have still show." : ""}
          </p>
        </div>
        {left.differences > 0 && (
          <Button size="sm" variant="secondary" onClick={onReview}>
            Review again
          </Button>
        )}
      </div>
    </div>
  );
}

function Failure({ view }: { view: FailureView }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center" role="alert">
      <div className="grid size-12 place-items-center rounded-lg bg-error/12 text-error">
        <TriangleAlert className="size-6" aria-hidden />
      </div>
      <h3 className="font-display text-lg font-bold text-ink">{view.title}</h3>
      <p className="max-w-md text-sm text-ink-2">
        <Ticks text={view.message} />
      </p>
      {view.hint && (
        <p className="max-w-md text-xs text-mute">
          <Ticks text={view.hint} />
        </p>
      )}
    </div>
  );
}
