import {
  Brain,
  Check,
  ChevronDown,
  Columns2,
  Download,
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
  Target,
  X,
  Zap,
  Bell,
  BellOff,
  Focus,
} from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { draftKey, parseAgentKey, useAgent, useDraft, useSession, useUi } from "@/core";
import type { ModelInfo, SessionMeta, ThinkingLevel } from "@/core/gen";
import { fuzzyScore } from "@/features/palette/fuzzy";
import type { SessionDialog } from "../state";
import {
  BottomSheet,
  cn,
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  formatCompact,
  useIsMobile,
  Popover,
  PopoverContent,
  PopoverTrigger,
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
  "pressable focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-bold whitespace-nowrap shadow-[inset_0_0_0_1px_var(--color-line-2)] disabled:opacity-45";

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

export function ModelPicker({ agentKey, mobile = false }: { agentKey: string; mobile?: boolean }) {
  const { meta } = useSession(agentKey);
  const open = useSessionUi((s) => s.dialog[agentKey] === "model");
  const setOpen = (o: boolean) => useSessionUi.getState().openDialog(agentKey, o ? "model" : null);
  const disabled = !meta?.caps.model;
  const trigger = (
    <ControlChip disabled={disabled} aria-label="Model" title={disabled ? "Model can't be changed right now" : "Switch model (/model)"} onClick={mobile ? () => setOpen(true) : undefined}>
      <Sparkles className="size-3.5 text-accent-hi" />
      <span className={cn("truncate", mobile ? "max-w-[112px]" : "max-w-[160px]")}>{modelLabel(meta)}</span>
      <ChevronDown className="size-3 text-mute" />
    </ControlChip>
  );
  if (mobile)
    return (
      <>
        {trigger}
        <BottomSheet open={open} onOpenChange={setOpen} title="Model" description="Session-only switch (omp /switch)" autoFocus={false}>
          <ModelList agentKey={agentKey} onDone={() => setOpen(false)} mobile />
        </BottomSheet>
      </>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] overflow-hidden p-0">
        <ModelList agentKey={agentKey} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

// ---------- thinking ----------

const LEVEL_HINT: Partial<Record<ThinkingLevel, string>> = { off: "No reasoning", minimal: "Fastest", low: "Light", medium: "Balanced", high: "Deep", xhigh: "Deeper", max: "Maximum", auto: "Model decides" };

export function ThinkingPicker({ agentKey, mobile = false }: { agentKey: string; mobile?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const { catalog } = useModels(hostId, meta?.caps.thinking === true);
  const [busy, run] = usePending();
  const [open, setOpen] = useState(false);
  const model = catalog?.models.find((m) => m.provider === meta?.model?.provider && m.id === meta?.model?.id);
  const levels = model && model.thinking.length > 0 ? model.thinking : THINKING_LEVELS;
  const set = (level: ThinkingLevel) => void run(hostCall(hostId, "agent.setThinking", { agentId, level }, { success: `Thinking → ${level}` }));
  const chip = (
    <ControlChip disabled={!meta?.caps.thinking || busy} aria-label="Thinking level" title="Thinking level (/effort)" onClick={mobile ? () => setOpen(true) : undefined}>
      {busy ? <Spinner size={12} /> : <Brain className="size-3.5 text-omp-blue" />}
      {meta?.thinking ?? "thinking"}
      <ChevronDown className="size-3 text-mute" />
    </ControlChip>
  );
  if (mobile)
    return (
      <>
        {chip}
        <BottomSheet open={open} onOpenChange={setOpen} title="Thinking" description="Reasoning effort for this session (/effort)">
          <div role="radiogroup" aria-label="Thinking level" className="flex flex-col gap-1.5">
            {levels.map((l) => {
              const on = l === meta?.thinking;
              return (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    if (!on) set(l);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex min-h-14 items-center gap-3 rounded-lg px-4 text-left pressable focus-ring",
                    on ? "bg-accent/12 shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]" : "bg-white/[0.035]",
                  )}
                >
                  <Brain className={cn("size-5 shrink-0", on ? "text-accent-hi" : "text-omp-blue")} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-md font-bold text-ink">{l}</span>
                    <span className="block text-xs text-mute">{LEVEL_HINT[l]}</span>
                  </span>
                  {on && <Check className="size-5 shrink-0 text-accent-hi" aria-hidden />}
                </button>
              );
            })}
          </div>
        </BottomSheet>
      </>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{chip}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuLabel>Thinking</DropdownMenuLabel>
        {levels.map((l) => (
          <DropdownMenuItem key={l} onSelect={() => set(l)} icon={l === meta?.thinking ? <Check className="text-accent-hi" /> : <span className="size-4" />}>
            <span className="font-bold">{l}</span>
            <span className="ml-2 text-2xs text-mute-2">{LEVEL_HINT[l]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------- plan / fast ----------

export function PlanToggle({ agentKey, compact = false }: { agentKey: string; compact?: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const [busy, run] = usePending();
  const mode = meta?.mode ?? "normal";
  const on = mode !== "normal";
  return (
    <Tooltip content={mode === "plan" ? "Plan mode on — click to leave" : mode === "planPaused" ? "Plan mode paused — click to leave" : "Enter plan mode"} shortcut="/plan">
      <ControlChip
        on={on}
        aria-pressed={on}
        disabled={!meta?.caps.plan || busy}
        onClick={() => void run(hostCall(hostId, "agent.setPlan", { agentId, on: !on }, { success: on ? "Plan mode off" : "Plan mode on" }))}
      >
        {busy ? <Spinner size={12} /> : <ListChecks className="size-3.5" />}
        {!compact && (mode === "planPaused" ? "Plan paused" : "Plan")}
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
    <Tooltip content={on ? "Fast mode on (priority tier)" : "Fast mode off"} shortcut="/fast">
      <ControlChip on={on} aria-pressed={on} disabled={!meta?.caps.fast || busy} onClick={() => void run(hostCall(hostId, "agent.setFast", { agentId, on: !on }, { success: on ? "Fast off" : "Fast on" }))}>
        {busy ? <Spinner size={12} /> : <Zap className={cn("size-3.5", on && "fill-current text-warn")} />}
        {!compact && "Fast"}
      </ControlChip>
    </Tooltip>
  );
}

export function GoalChip({ agentKey, compact = false }: { agentKey: string; compact?: boolean }) {
  const { meta } = useSession(agentKey);
  const goal = meta?.goal;
  const pct = goal?.budget && goal.tokensUsed != null ? Math.min(100, Math.round((goal.tokensUsed / goal.budget) * 100)) : null;
  return (
    <ControlChip
      on={goal != null && goal.status === "active"}
      disabled={!meta?.caps.goal}
      onClick={() => useSessionUi.getState().openDialog(agentKey, "goal")}
      title={goal ? `Goal: ${goal.objective}` : "Set a goal (/goal)"}
      className="relative overflow-hidden"
    >
      <Target className={cn("size-3.5", goal?.status === "active" && "tf-loop animate-breathe text-accent-hi")} />
      {!compact && <span className="max-w-[180px] truncate">{goal ? goal.objective : "Goal"}</span>}
      {goal?.status === "paused" && !compact && <span className="text-mute">· paused</span>}
      {pct != null && <span className="absolute bottom-0 left-0 h-[2px] bg-omp" style={{ width: `${pct}%` }} aria-hidden />}
    </ControlChip>
  );
}

// ---------- actions ----------

/** Everything else: compact, fork, handoff, export, rename, new session, connect, terminal, stop. */
export function ActionsMenu({ agentKey, trigger }: { agentKey: string; trigger?: ReactNode }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const caps = meta?.caps;
  const mute = useMute(agentKey);
  const mobile = useIsMobile();
  const open = (d: SessionDialog) => useSessionUi.getState().openDialog(agentKey, d);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button type="button" aria-label="Session actions" className={cn(chipBase, "w-8 justify-center bg-white/[0.05] px-0 text-ink-2 hover:bg-white/[0.09]")}>
            <MoreHorizontal className="size-4" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px]">
        {agent?.omp?.link === "notShared" && (
          <>
            <DropdownMenuItem icon={<PlugZap />} onSelect={() => void hostCall(hostId, "agent.connect", { agentId }, { success: "Connecting to session…" })}>
              Connect session
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Session</DropdownMenuLabel>
        <DropdownMenuItem icon={<Layers />} onSelect={() => open("compact")} disabled={!caps?.compact} shortcut="/compact">
          Compact…
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Send />} onSelect={() => open("handoff")} disabled={!caps?.handoff} shortcut="/handoff">
          Handoff…
        </DropdownMenuItem>
        <DropdownMenuItem icon={<GitFork />} onSelect={() => void hostCall(hostId, "agent.fork", { agentId, placement: "inPlace" }, { success: "Forked in place" })} disabled={!caps?.fork}>
          Fork in place
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Columns2 />} onSelect={() => void hostCall(hostId, "agent.fork", { agentId, placement: "pane" }, { success: "Forked into a new pane" })} disabled={!caps?.fork}>
          Fork into new pane
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Pencil />} onSelect={() => open("rename")} shortcut="/rename">
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Download />}
          onSelect={() => void hostCall(hostId, "agent.export", { agentId }).then((r) => r.ok && toast({ title: "Session exported", description: r.value.path, status: "done" }))}
          disabled={!caps?.export}
          shortcut="/export"
        >
          Export HTML
        </DropdownMenuItem>
        <DropdownMenuItem icon={<SquarePlus />} onSelect={() => open("newSession")} shortcut="/new">
          New session…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={mute.muted ? <Bell /> : <BellOff />} onSelect={() => void mute.toggle()}>
          {mute.muted ? "Unmute notifications" : "Mute notifications"}
        </DropdownMenuItem>
        {!mobile && (
          <DropdownMenuItem icon={<Focus />} onSelect={() => useUi.getState().setFocusMode(!useUi.getState().focusMode)} shortcut="F">
            Focus mode
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={<Columns2 />} onSelect={() => useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent?.paneId })} shortcut="Ctrl \">
          Open terminal in split
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Stop</DropdownMenuLabel>
        <DropdownMenuItem icon={<Square />} onSelect={() => void hostCall(hostId, "agent.abort", { agentId }, { success: "Stopped" })} disabled={caps?.abort === false} shortcut="Esc">
          Interrupt turn
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Power />} onSelect={() => void hostCall(hostId, "agent.stop", { agentId, mode: "exit" }, { success: "omp exited" })}>
          Exit omp (keep pane)
        </DropdownMenuItem>
        <DropdownMenuItem icon={<X />} danger onSelect={() => void hostCall(hostId, "agent.stop", { agentId, mode: "closePane" }, { success: "Pane closed" })}>
          Close pane
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
