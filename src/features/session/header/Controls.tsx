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
} from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { parseAgentKey, useAgent, useSession, useUi } from "@/core";
import type { ModelInfo, SessionMeta, ThinkingLevel } from "@/core/gen";
import type { SessionDialog } from "../state";
import {
  BottomSheet,
  cn,
  Command,
  CommandEmpty,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  Shimmer,
  Spinner,
  toast,
  Tooltip,
} from "@/design";
import { hostCall, usePending } from "../api";
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

function ModelList({ agentKey, onDone }: { agentKey: string; onDone: () => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const { catalog, error, loading } = useModels(hostId);
  const [busy, run] = usePending();
  const current = meta?.model ? `${meta.model.provider}/${meta.model.id}` : "";
  const pick = async (model: string) => {
    const res = await run(hostCall(hostId, "agent.setModel", { agentId, model }, { success: `Model → ${model}`, failure: "Model change failed" }));
    if (res.ok) onDone();
  };
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of catalog?.models ?? []) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  return (
    <Command loop className="max-h-[min(60vh,460px)]">
      <CommandInput placeholder="Search models…" autoFocus />
      <CommandList className="max-h-none flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-mute">
            <Spinner size={14} /> <Shimmer>Loading models from host…</Shimmer>
          </div>
        )}
        {error && <div className="px-4 py-6 text-sm text-error">{error}</div>}
        {catalog && <CommandEmpty>No model matches</CommandEmpty>}
        {catalog && catalog.roles.length > 0 && (
          <CommandGroup heading="Roles">
            {catalog.roles.map((r) => (
              <CommandItem key={r.role} value={`@${r.role} ${r.model}`} onSelect={() => void pick(r.model.split(":")[0] ?? r.model)} disabled={busy} icon={<Sparkles />}>
                <span className="font-bold">@{r.role}</span>
                <span className="ml-2 font-mono text-2xs text-mute">{r.model}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {[...byProvider].map(([provider, models]) => (
          <CommandGroup key={provider} heading={provider}>
            {models.map((m) => {
              const id = `${m.provider}/${m.id}`;
              return (
                <CommandItem key={id} value={`${id} ${m.label ?? ""}`} onSelect={() => void pick(id)} disabled={busy} icon={id === current ? <Check className="text-accent-hi" /> : <span className="size-4" />}>
                  <span className="font-bold">{m.label ?? m.id}</span>
                  <span className="ml-2 font-mono text-2xs text-mute-2">{m.id}</span>
                  {m.contextWindow != null && <span className="ml-2 text-2xs text-mute-2 tabular">{formatCompact(m.contextWindow)} ctx</span>}
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
      <span className="max-w-[160px] truncate">{modelLabel(meta)}</span>
      <ChevronDown className="size-3 text-mute" />
    </ControlChip>
  );
  if (mobile)
    return (
      <>
        {trigger}
        <BottomSheet open={open} onOpenChange={setOpen} title="Model" description="Session-only switch (omp /switch)">
          <ModelList agentKey={agentKey} onDone={() => setOpen(false)} />
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

export function ThinkingPicker({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const { catalog } = useModels(hostId, meta?.caps.thinking === true);
  const [busy, run] = usePending();
  const model = catalog?.models.find((m) => m.provider === meta?.model?.provider && m.id === meta?.model?.id);
  const levels = model && model.thinking.length > 0 ? model.thinking : THINKING_LEVELS;
  const set = (level: ThinkingLevel) => void run(hostCall(hostId, "agent.setThinking", { agentId, level }, { success: `Thinking → ${level}` }));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ControlChip disabled={!meta?.caps.thinking || busy} aria-label="Thinking level" title="Thinking level (/effort)">
          {busy ? <Spinner size={12} /> : <Brain className="size-3.5 text-omp-blue" />}
          {meta?.thinking ?? "thinking"}
          <ChevronDown className="size-3 text-mute" />
        </ControlChip>
      </DropdownMenuTrigger>
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
        <DropdownMenuItem icon={<Pencil />} onSelect={() => open("rename")} disabled={!caps?.rename} shortcut="/rename">
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
