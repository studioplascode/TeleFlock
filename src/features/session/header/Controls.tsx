import {
  Bell,
  BellOff,
  Brain,
  Check,
  ChevronDown,
  Columns2,
  Download,
  Focus,
  GitFork,
  Layers,
  ListChecks,
  MoreHorizontal,
  Pencil,
  PlugZap,
  Power,
  Send,
  Sparkles,
  Square,
  SquarePlus,
  SquareTerminal,
  Target,
  X,
  Zap,
} from "lucide-react";
import { Slot } from "@radix-ui/react-slot";
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { draftKey, parseAgentKey, useAgent, useDraft, useSession, useUi } from "@/core";
import type { ModelInfo, SessionMeta, ThinkingLevel } from "@/core/gen";
import { openTerminal } from "@/features/board/agentActions";
import { fuzzyScore } from "@/features/palette/fuzzy";
import { GLOSSARY } from "@/features/shell/glossary";
import { haptic } from "@/features/shell/haptics";
import { Term } from "@/features/shell/Term";
import { ACTIONS, type ActionDef } from "@/features/shell/vocab";
import type { SessionDialog } from "../state";
import {
  BottomSheet,
  Button,
  cn,
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatCompact,
  useIsMobile,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Shimmer,
  Spinner,
  toast,
  Tooltip,
} from "@/design";
import { hostCall, useMute, usePending } from "../api";
import { THINKING_LEVELS } from "../composer/slash";
import { useSessionUi } from "../state";
import { useModels } from "./useModels";

const chipBase =
  "pressable focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-bold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--color-line-2)] disabled:opacity-45 max-md:gap-1 max-md:px-2";

function ControlChip({ on, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return (
    <button
      type="button"
      className={cn(chipBase, on ? "bg-accent/18 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.45)]" : "bg-white/[0.05] text-ink-2 hover:bg-white/[0.09]", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The explicit state of a toggle chip ("on" / "off" / "none"), drawn like a switch's label. */
function StateTag({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[9.5px] font-extrabold tracking-wider uppercase transition-colors duration-200 max-md:px-1",
        on ? "bg-accent text-white shadow-[0_0_8px_rgb(163_92_240/0.55)]" : "bg-white/8 text-mute",
      )}
    >
      {children}
    </span>
  );
}

export function modelLabel(meta: SessionMeta | undefined): string {
  const m = meta?.model;
  return m ? (m.label ?? m.id) : "model";
}

// ---------- model picker ----------

const RECENT_MAX = 5;
const recentKey = (hostId: string) => `tf.recentModels.${hostId}`;

function readRecents(hostId: string): string[] {
  try {
    const v: unknown = JSON.parse(globalThis.localStorage?.getItem(recentKey(hostId)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(hostId: string, model: string): void {
  try {
    const next = [model, ...readRecents(hostId).filter((m) => m !== model)].slice(0, RECENT_MAX);
    globalThis.localStorage?.setItem(recentKey(hostId), JSON.stringify(next));
  } catch {
    /* storage unavailable: recents just don't persist */
  }
}

interface ModelRow {
  /** Unique cmdk value (`group|selector`). */
  value: string;
  /** `provider/id[:level]` passed to setModel. */
  selector: string;
  title: string;
  sub: string;
  ctx?: number;
  role?: string;
}

/**
 * Searchable model list: fuzzy match on provider, id and label; with an empty query the current
 * model, recents and role bindings are pinned above the per-provider catalog.
 */
function ModelList({ agentKey, onDone, mobile = false }: { agentKey: string; onDone: () => void; mobile?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const { catalog, error, loading } = useModels(hostId);
  const [busy, run] = usePending();
  const [query, setQuery, clearQuery] = useDraft(draftKey("search.model", hostId));
  const [sel, setSel] = useState("");
  const current = meta?.model ? `${meta.model.provider}/${meta.model.id}` : "";
  const recents = readRecents(hostId);

  /** `provider/id[:level]` (role bindings carry a level). */
  const pick = async (selector: string) => {
    const [model = selector, level] = selector.split(":");
    const thinking = THINKING_LEVELS.find((l) => l === level);
    const res = await run(hostCall(hostId, "agent.setModel", { agentId, model, thinking }, { success: `Model → ${selector}`, failure: "Model change failed" }));
    if (res.ok) {
      pushRecent(hostId, model);
      clearQuery();
      onDone();
    }
  };

  const models = catalog?.models ?? [];
  const info = (id: string): ModelInfo | undefined => models.find((m) => `${m.provider}/${m.id}` === id);
  const modelRow = (group: string, m: ModelInfo): ModelRow => {
    const id = `${m.provider}/${m.id}`;
    return { value: `${group}|${id}`, selector: id, title: m.label ?? m.id, sub: id, ctx: m.contextWindow };
  };
  const roleRows: ModelRow[] = (catalog?.roles ?? []).map((r) => ({ value: `role|${r.role}`, selector: r.model, title: `@${r.role}`, sub: r.model, role: r.role }));

  const q = query.trim();
  const groups: { heading: string; rows: ModelRow[] }[] = [];
  if (q) {
    // Every query word must fuzzy-match one field on its own ("ant op" → anthropic + opus).
    const words = q.split(/\s+/);
    const score = (fields: string[]): number | null => {
      let sum = 0;
      for (const w of words) {
        let best: number | null = null;
        for (const f of fields) {
          const s = fuzzyScore(w, f);
          if (s !== null && (best === null || s > best)) best = s;
        }
        if (best === null) return null;
        sum += best;
      }
      return sum / words.length;
    };
    const scored: [number, ModelRow][] = [];
    for (const m of models) {
      const s = score([m.label ?? m.id, m.id, m.provider]);
      if (s !== null) scored.push([s, modelRow("match", m)]);
    }
    for (const r of roleRows) {
      const s = score([r.title, r.role ?? "", r.sub]);
      if (s !== null) scored.push([s * 0.95, r]);
    }
    groups.push({ heading: "Matches", rows: scored.sort((a, b) => b[0] - a[0]).map(([, r]) => r) });
  } else {
    const cur = info(current);
    if (cur) groups.push({ heading: "Current", rows: [modelRow("current", cur)] });
    const rec = recents.filter((id) => id !== current).flatMap((id) => {
      const m = info(id);
      return m ? [modelRow("recent", m)] : [];
    });
    if (rec.length) groups.push({ heading: "Recent", rows: rec });
    if (roleRows.length) groups.push({ heading: "Roles", rows: roleRows });
    const byProvider = new Map<string, ModelRow[]>();
    for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), modelRow(m.provider, m)]);
    for (const [provider, rows] of byProvider) groups.push({ heading: provider, rows });
  }
  const first = groups[0]?.rows[0]?.value ?? "";
  const flat = groups.flatMap((g) => g.rows);
  // Keep the highlighted row valid as the list changes under the query.
  const active = flat.some((r) => r.value === sel) ? sel : first;

  return (
    <Command loop shouldFilter={false} value={active} onValueChange={setSel} className="max-h-[min(60vh,460px)]">
      <CommandInput
        placeholder={`Search ${models.length || ""} models · provider, id or name`}
        // Phone: the list first; the keyboard only comes up when the search field is tapped.
        autoFocus={!mobile}
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          setSel("");
        }}
      />
      <CommandList className="max-h-none flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-mute">
            <Spinner size={14} /> <Shimmer>Loading models from host…</Shimmer>
          </div>
        )}
        {error && <div className="px-4 py-6 text-sm text-error">{error}</div>}
        {catalog && flat.length === 0 && <div className="py-10 text-center text-sm text-mute">No model matches “{q}”</div>}
        {groups.map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.rows.map((r) => {
              const isCurrent = !r.role && r.selector === current;
              return (
                <CommandItem
                  key={r.value}
                  value={r.value}
                  onSelect={() => void pick(r.selector)}
                  disabled={busy}
                  aria-current={isCurrent || undefined}
                  className={cn(mobile && "min-h-12", isCurrent && "bg-accent/10 text-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.3)]")}
                  icon={r.role ? <Sparkles /> : isCurrent ? <Check className="text-accent-hi" /> : <span className="size-4" />}
                >
                  <span className="font-bold">{r.title}</span>
                  <span className="ml-2 font-mono text-2xs text-mute-2">{r.sub}</span>
                  {r.ctx != null && <span className="ml-2 text-2xs text-mute-2 tabular">{formatCompact(r.ctx)} ctx</span>}
                  {isCurrent && <span className="ml-2 rounded-full bg-accent/20 px-1.5 text-[9.5px] font-bold tracking-wider text-accent-hi uppercase">current</span>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

export function ModelPicker({ agentKey }: { agentKey: string }) {
  const { meta } = useSession(agentKey);
  const open = useSessionUi((s) => s.dialog[agentKey] === "model");
  const setOpen = (o: boolean) => useSessionUi.getState().openDialog(agentKey, o ? "model" : null);
  const disabled = !meta?.caps.model;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ControlChip disabled={disabled} aria-label="Model" title={disabled ? "Model can't be changed right now" : "Switch model (/model)"}>
          <Sparkles className="size-3.5 text-accent-hi" />
          <span className="max-w-[160px] truncate">{modelLabel(meta)}</span>
          <ChevronDown className="size-3 text-mute" />
        </ControlChip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] overflow-hidden p-0">
        <ModelList agentKey={agentKey} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

// ---------- thinking ----------

const LEVEL_HINT: Partial<Record<ThinkingLevel, string>> = { off: "No reasoning", minimal: "Fastest", low: "Light", medium: "Balanced", high: "Deep", xhigh: "Deeper", max: "Maximum", auto: "Model decides" };

/** The thinking levels the session's model offers (all of omp's when unknown) and a setter. */
function useThinking(agentKey: string) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const enabled = meta?.caps.thinking === true;
  const { catalog } = useModels(hostId, enabled);
  const [busy, run] = usePending();
  const model = catalog?.models.find((m) => m.provider === meta?.model?.provider && m.id === meta?.model?.id);
  const levels = model && model.thinking.length > 0 ? model.thinking : THINKING_LEVELS;
  const set = (level: ThinkingLevel) => void run(hostCall(hostId, "agent.setThinking", { agentId, level }, { success: `Thinking → ${level}` }));
  return { levels, set, busy, enabled, current: meta?.thinking };
}

export function ThinkingPicker({ agentKey }: { agentKey: string }) {
  const t = useThinking(agentKey);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ControlChip disabled={!t.enabled || t.busy} aria-label="Thinking level" title="Thinking level (/effort)">
          {t.busy ? <Spinner size={12} /> : <Brain className="size-3.5 text-omp-blue" />}
          {t.current ?? "thinking"}
          <ChevronDown className="size-3 text-mute" />
        </ControlChip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuLabel>Thinking</DropdownMenuLabel>
        {t.levels.map((l) => (
          <DropdownMenuItem key={l} onSelect={() => t.set(l)} icon={l === t.current ? <Check className="text-accent-hi" /> : <span className="size-4" />}>
            <span className="font-bold">{l}</span>
            <span className="ml-2 text-2xs text-mute-2">{LEVEL_HINT[l]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Phone: model and thinking in one chip (`gpt-5.5 · xhigh ▾`) so the whole control row fits a
 * 393 px screen. Its sheet puts the thinking level (segmented) above the searchable model list.
 */
export function ModelThinkingChip({ agentKey }: { agentKey: string }) {
  const { meta } = useSession(agentKey);
  const open = useSessionUi((s) => s.dialog[agentKey] === "model");
  const setOpen = (o: boolean) => useSessionUi.getState().openDialog(agentKey, o ? "model" : null);
  const t = useThinking(agentKey);
  const canModel = meta?.caps.model === true;
  return (
    <>
      <ControlChip
        disabled={!canModel && !t.enabled}
        aria-label={`Model ${modelLabel(meta)}, thinking ${t.current ?? "unknown"}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {t.busy ? <Spinner size={12} /> : <Sparkles className="size-3.5 text-accent-hi" />}
        <span className="max-w-[92px] truncate">{modelLabel(meta)}</span>
        {t.current && <span className="text-mute">· {t.current}</span>}
        <ChevronDown className="size-3 text-mute" />
      </ControlChip>
      <BottomSheet open={open} onOpenChange={setOpen} title="Model & thinking" description="For this session only (omp /switch, /effort)" autoFocus={false}>
        {t.enabled && (
          <div className="mb-3 flex flex-col gap-1.5">
            <span className="kicker">
              <Term id="thinking" />
            </span>
            <div className="-mx-1 overflow-x-auto px-1 no-scrollbar">
              <SegmentedControl
                aria-label="Thinking level"
                size="sm"
                value={(t.current ?? "") as ThinkingLevel}
                onValueChange={(l) => l !== t.current && t.set(l)}
                options={t.levels.map((l) => ({ value: l, label: l, disabled: t.busy }))}
              />
            </div>
            {t.current && LEVEL_HINT[t.current] && (
              <span className="text-xs text-mute">
                {t.current}: {LEVEL_HINT[t.current]}
              </span>
            )}
          </div>
        )}
        {canModel ? <ModelList agentKey={agentKey} onDone={() => setOpen(false)} mobile /> : <p className="py-4 text-sm text-mute">The model can't be changed right now.</p>}
      </BottomSheet>
    </>
  );
}

// ---------- plan / fast / goal ----------

export function PlanToggle({ agentKey, compact = false }: { agentKey: string; compact?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const [busy, run] = usePending();
  const mode = meta?.mode ?? "normal";
  const on = mode !== "normal";
  const state = mode === "plan" ? "on" : mode === "planPaused" ? "paused" : "off";
  return (
    <Tooltip content={`${GLOSSARY.plan.text} Click to turn it ${on ? "off" : "on"}.`} shortcut="/plan">
      <ControlChip
        on={on}
        aria-pressed={on}
        aria-label={`Plan mode ${state}`}
        disabled={!meta?.caps.plan || busy}
        onClick={() => void run(hostCall(hostId, "agent.setPlan", { agentId, on: !on }, { success: on ? "Plan mode off" : "Plan mode on" }))}
      >
        {busy ? <Spinner size={12} /> : <ListChecks className="size-3.5 max-md:hidden" />}
        {!compact && "Plan"}
        <StateTag on={mode === "plan"}>{state}</StateTag>
      </ControlChip>
    </Tooltip>
  );
}

export function FastToggle({ agentKey, compact = false }: { agentKey: string; compact?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const [busy, run] = usePending();
  const on = meta?.fast === true;
  return (
    <Tooltip content={`${GLOSSARY.fast.text} Click to turn it ${on ? "off" : "on"}.`} shortcut="/fast">
      <ControlChip
        on={on}
        aria-pressed={on}
        aria-label={`Fast mode ${on ? "on" : "off"}`}
        disabled={!meta?.caps.fast || busy}
        onClick={() => void run(hostCall(hostId, "agent.setFast", { agentId, on: !on }, { success: on ? "Fast off" : "Fast on" }))}
      >
        {busy ? <Spinner size={12} /> : <Zap className={cn("size-3.5 max-md:hidden", on && "fill-current text-warn")} />}
        {!compact && "Fast"}
        <StateTag on={on}>{on ? "on" : "off"}</StateTag>
      </ControlChip>
    </Tooltip>
  );
}

export function GoalChip({ agentKey, compact = false }: { agentKey: string; compact?: boolean }) {
  const { meta } = useSession(agentKey);
  const goal = meta?.goal;
  const active = goal?.status === "active";
  const pct = goal?.budget && goal.tokensUsed != null ? Math.min(100, Math.round((goal.tokensUsed / goal.budget) * 100)) : null;
  return (
    <Tooltip content={goal ? `${GLOSSARY.goal.text} Now: ${goal.objective}` : `${GLOSSARY.goal.text} None set; click to set one.`} shortcut="/goal">
      <ControlChip
        on={active}
        disabled={!meta?.caps.goal}
        onClick={() => useSessionUi.getState().openDialog(agentKey, "goal")}
        aria-label={goal ? `Goal: ${goal.objective}${goal.status === "paused" ? " (paused)" : ""}` : "Goal: none"}
        className="relative overflow-hidden"
      >
        <Target className={cn("size-3.5 max-md:hidden", active && "tf-loop animate-breathe text-accent-hi")} />
        {!compact && <span className={cn(goal && "text-mute")}>Goal</span>}
        {goal ? !compact && <span className="max-w-[180px] truncate max-md:max-w-[88px]">{goal.objective}</span> : <StateTag on={false}>none</StateTag>}
        {goal?.status === "paused" && <StateTag on={false}>paused</StateTag>}
        {pct != null && <span className="absolute bottom-0 left-0 h-[2px] bg-omp" style={{ width: `${pct}%` }} aria-hidden />}
      </ControlChip>
    </Tooltip>
  );
}

// ---------- actions ----------

interface MenuAction {
  key: string;
  icon: ReactNode;
  /** Label, description line and slash/shortcut hint (from `ACTIONS`). */
  def: ActionDef;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

interface MenuGroup {
  label?: string;
  items: MenuAction[];
}

/** One sheet row: icon tile, label, description line (phone ⋯ sheet). */
function SheetAction({ action, onPick }: { action: MenuAction; onPick: () => void }) {
  return (
    <button
      type="button"
      disabled={action.disabled}
      onClick={onPick}
      className="flex min-h-13 w-full items-center gap-3 rounded-lg bg-white/[0.035] px-3 py-1.5 text-left pressable focus-ring disabled:opacity-40"
    >
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-md bg-white/[0.06] [&_svg]:size-4.5", action.danger ? "text-[#ff8aa5]" : "text-accent-hi")}>{action.icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-md font-bold", action.danger ? "text-[#ff8aa5]" : "text-ink")}>{action.def.label}</span>
        {action.def.description && <span className="block truncate text-xs text-mute">{action.def.description}</span>}
      </span>
    </button>
  );
}

/**
 * Session commands, notifications, view, stop and end-session actions. Desktop: a dropdown with a
 * description line under every item. Phone: a bottom sheet (thumb reach, no keyboard hints).
 * Close pane asks first.
 */
export function ActionsMenu({ agentKey, trigger }: { agentKey: string; trigger?: ReactNode }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const caps = meta?.caps;
  const mute = useMute(agentKey);
  const mobile = useIsMobile();
  const [sheet, setSheet] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const open = (d: SessionDialog) => useSessionUi.getState().openDialog(agentKey, d);
  const working = agent?.column === "running";

  const groups: MenuGroup[] = [];
  if (agent?.omp?.link === "notShared")
    groups.push({
      items: [
        {
          key: "connect",
          icon: <PlugZap />,
          def: { label: "Connect session", description: "Join it so TeleFlock can show it live" },
          run: () => void hostCall(hostId, "agent.connect", { agentId }, { success: "Connecting to session…" }),
        },
      ],
    });
  groups.push({
    label: "Session",
    items: [
      { key: "compact", icon: <Layers />, def: ACTIONS.compact, disabled: !caps?.compact, run: () => open("compact") },
      { key: "handoff", icon: <Send />, def: ACTIONS.handoff, disabled: !caps?.handoff, run: () => open("handoff") },
      {
        key: "forkInPlace",
        icon: <GitFork />,
        def: ACTIONS.forkInPlace,
        disabled: !caps?.fork,
        run: () => void hostCall(hostId, "agent.fork", { agentId, placement: "inPlace" }, { success: "Forked in place" }),
      },
      {
        key: "forkNewPane",
        icon: <Columns2 />,
        def: ACTIONS.forkNewPane,
        disabled: !caps?.fork,
        run: () => void hostCall(hostId, "agent.fork", { agentId, placement: "pane" }, { success: "Forked into a new pane" }),
      },
      { key: "rename", icon: <Pencil />, def: ACTIONS.rename, run: () => open("rename") },
      {
        key: "exportHtml",
        icon: <Download />,
        def: ACTIONS.exportHtml,
        disabled: !caps?.export,
        run: () => void hostCall(hostId, "agent.export", { agentId }).then((r) => r.ok && toast({ title: "Session exported", description: r.value.path, status: "done" })),
      },
      { key: "newSession", icon: <SquarePlus />, def: ACTIONS.newSession, run: () => open("newSession") },
    ],
  });
  const view: MenuAction[] = [{ key: "mute", icon: mute.muted ? <Bell /> : <BellOff />, def: mute.muted ? ACTIONS.unmute : ACTIONS.mute, run: () => void mute.toggle() }];
  if (mobile) view.push({ key: "terminal", icon: <SquareTerminal />, def: ACTIONS.terminal, run: () => openTerminal(agentKey, true) });
  else
    view.push(
      { key: "focus", icon: <Focus />, def: ACTIONS.focusMode, run: () => useUi.getState().setFocusMode(!useUi.getState().focusMode) },
      {
        key: "terminalBeside",
        icon: <SquareTerminal />,
        def: ACTIONS.terminalBeside,
        run: () => (agent?.parked ? openTerminal(agentKey, false) : useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent?.paneId })),
      },
    );
  groups.push({ items: view });
  groups.push({
    items: [
      {
        key: "stopTurn",
        icon: <Square />,
        def: ACTIONS.stopTurn,
        disabled: caps?.abort === false || !working,
        run: () => void hostCall(hostId, "agent.abort", { agentId }, { success: "Turn stopped" }),
      },
    ],
  });
  groups.push({
    label: "End session",
    items: [
      { key: "exitOmp", icon: <Power />, def: ACTIONS.exitOmp, run: () => void hostCall(hostId, "agent.stop", { agentId, mode: "exit" }, { success: "omp exited" }) },
      { key: "closePane", icon: <X />, def: ACTIONS.closePane, danger: true, run: () => setConfirmClose(true) },
    ],
  });

  const defaultTrigger = (
    <button type="button" aria-label="Session actions" className={cn(chipBase, "w-8 justify-center bg-white/[0.05] px-0 text-ink-2 hover:bg-white/[0.09] max-md:px-0")}>
      <MoreHorizontal className="size-4" />
    </button>
  );

  const confirm = (
    <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
      <DialogContent
        icon={<X />}
        width={460}
        title="Close this pane?"
        description={`omp quits and ${agent?.name ?? "the agent"}'s herdr pane closes. The session stays saved on the host; resume it from Past sessions.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<X />}
              onClick={() => {
                setConfirmClose(false);
                void hostCall(hostId, "agent.stop", { agentId, mode: "closePane" }, { success: "Pane closed" });
              }}
            >
              Close pane
            </Button>
          </>
        }
      />
    </Dialog>
  );

  if (mobile)
    return (
      <>
        <Slot
          aria-haspopup="dialog"
          onClick={() => {
            haptic("select");
            setSheet(true);
          }}
        >
          {trigger ?? defaultTrigger}
        </Slot>
        <BottomSheet open={sheet} onOpenChange={setSheet} title={agent?.name ?? "Session"} description="Session actions">
          <div className="flex flex-col gap-3">
            {groups.map((g, i) => (
              <div key={g.label ?? i} className="flex flex-col gap-1">
                {g.label && <div className="kicker px-1 pb-0.5">{g.label}</div>}
                {g.items.map((a) => (
                  <SheetAction
                    key={a.key}
                    action={a}
                    onPick={() => {
                      haptic("select");
                      setSheet(false);
                      a.run();
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </BottomSheet>
        {confirm}
      </>
    );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger ?? defaultTrigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[340px]">
          {groups.map((g, i) => (
            <DropdownMenuGroup key={g.label ?? i}>
              {i > 0 && <DropdownMenuSeparator />}
              {g.label && <DropdownMenuLabel>{g.label}</DropdownMenuLabel>}
              {g.items.map((a) => (
                <DropdownMenuItem key={a.key} icon={a.icon} danger={a.danger} disabled={a.disabled} onSelect={a.run} shortcut={a.def.slash ?? a.def.shortcut} className="h-auto min-h-9 py-1.5">
                  <span className="block truncate">{a.def.label}</span>
                  {a.def.description && <span className="block text-[11px] leading-snug font-medium whitespace-normal text-mute-2">{a.def.description}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirm}
    </>
  );
}
