import { Bot, Coins, FileCode2, GitBranch, GitFork, GitMerge, ListTodo, MessageCircleQuestion, Navigation, Send, Workflow } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { navigate, parseAgentKey, useAgent, useBtw, useSession } from "@/core";
import { SessionCtx } from "../context";
import type { Subagent, TreeInfo, TreeNode } from "@/core/gen";
import {
  cn,
  EmptyState,
  formatCompact,
  formatUsd,
  IconButton,
  Input,
  NumberTicker,
  ProgressRing,
  SegmentedControl,
  Shimmer,
  Sparkline,
  Spinner,
  useNow,
} from "@/design";
import { hostCall, usePending } from "../api";
import { Markdown } from "../markdown/Markdown";
import { type InspectorTab, useSessionUi } from "../state";
import { SubagentCard, SubagentDialog } from "../subagents/Subagents";
import { DiffStatText } from "../tools/DiffBody";
import { TodoPhases, todoCounts } from "../tools/TodoList";

function Pane({ id, title, aside, children, className }: { id: InspectorTab; title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section data-panel={id} className={cn("rounded-[22px] glass px-4 py-3.5 transition-shadow duration-500", className)} aria-label={typeof title === "string" ? title : undefined}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="kicker">{title}</div>
        {aside && <span className="text-[11px] font-bold text-mute">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Mini({ k, v, s, className }: { k: ReactNode; v: ReactNode; s?: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2.5 shadow-hairline", className)}>
      <div className="text-[10.5px] font-bold text-mute">{k}</div>
      <div className="mt-0.5 font-display text-xl font-bold tracking-[-0.03em] text-ink tabular">{v}</div>
      {s && <div className="text-[10.5px] font-semibold text-mute-2 tabular">{s}</div>}
    </div>
  );
}

/** Rolling tok/s history sampled once a second (only while mounted). */
function useTpsHistory(value: number | undefined): number[] {
  const now = useNow(1000);
  const [hist, setHist] = useState<number[]>([]);
  useEffect(() => {
    setHist((h) => [...h.slice(-59), value ?? 0]);
  }, [now, value]);
  return hist;
}

export function OverviewPanel({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const tps = meta?.tps ?? agent?.live.tps;
  const hist = useTpsHistory(tps);
  const ctx = meta?.context ?? agent?.omp?.context;
  const cost = meta?.cost ?? agent?.omp?.cost;
  const todos = todoCounts(meta?.todos ?? []);
  const streaming = agent?.live.streaming === true;
  const peak = Math.max(0, ...hist);
  const ctxStatus = ctx && ctx.pct >= 85 ? "error" : ctx && ctx.pct >= 65 ? "needs-you" : "running";
  return (
    <Pane id="overview" title="Session" aside={<span className={cn("tabular", streaming && "text-accent-hi")}>{tps != null ? `${Math.round(tps)} tok/s` : "—"}</span>}>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2 flex items-center gap-3 rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2.5 shadow-hairline">
          <ProgressRing done={ctx?.pct ?? 0} total={100} size={48} stroke={4.5} status={ctxStatus} label={<span className="text-[11px] font-bold">{ctx ? `${Math.round(ctx.pct)}%` : "—"}</span>} />
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-bold text-mute">Context</div>
            <div className="font-display text-xl font-bold tracking-[-0.03em] text-ink tabular">
              {ctx ? formatCompact(ctx.tokens) : "—"} <span className="text-sm text-mute">/ {ctx ? formatCompact(ctx.window) : "—"}</span>
            </div>
          </div>
        </div>
        <Mini
          k={
            <span className="flex items-center gap-1">
              <Coins className="size-3" /> Cost
            </span>
          }
          v={cost ? <NumberTicker value={cost.usd} format={formatUsd} /> : "—"}
          s={cost ? `${formatCompact(cost.input)} in / ${formatCompact(cost.output)} out` : undefined}
        />
        <Mini
          k={
            <span className="flex items-center gap-1">
              <ListTodo className="size-3" /> Todos
            </span>
          }
          v={todos.total ? `${todos.done}/${todos.total}` : "—"}
          s={
            todos.total ? (
              <span className="mt-1 flex items-center gap-2">
                <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/8" role="progressbar" aria-valuemin={0} aria-valuemax={todos.total} aria-valuenow={todos.done} aria-label="Todos done">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-done transition-[width] duration-700 ease-out" style={{ width: `${(100 * todos.done) / todos.total}%` }} />
                </span>
                {todos.blocked > 0 && <span className="text-sun-1">{todos.blocked} blocked</span>}
              </span>
            ) : undefined
          }
        />
        <div className="col-span-2 rounded-lg bg-[rgb(10_10_16/0.45)] px-3 pt-2 pb-1 shadow-hairline">
          <div className="flex items-center justify-between text-[10.5px] font-bold text-mute">
            <span>Throughput</span>
            <span className="text-mute-2 tabular">{peak > 0 ? `peak ${Math.round(peak)} tok/s · 60s` : "60s"}</span>
          </div>
          <div className="relative">
            <Sparkline values={hist.length > 1 ? hist : [0, 0]} height={34} live={streaming} status={streaming ? "running" : "idle"} />
            {!streaming && peak === 0 && <span className="absolute inset-0 grid place-items-center text-[10.5px] font-semibold text-mute-2">idle · no tokens in the last minute</span>}
          </div>
        </div>
      </div>
    </Pane>
  );
}

export function TodosPanel({ agentKey }: { agentKey: string }) {
  const { meta } = useSession(agentKey);
  const todos = meta?.todos ?? [];
  const c = todoCounts(todos);
  if (todos.length === 0) return null;
  return (
    <Pane id="todos" title="Todos" aside={`${c.done}/${c.total}`}>
      <TodoPhases phases={todos} />
    </Pane>
  );
}

export function SubagentsPanel({ agentKey }: { agentKey: string }) {
  const { meta } = useSession(agentKey);
  const subs = meta?.subagents ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const sub: Subagent | undefined = subs.find((s) => s.id === openId);
  if (subs.length === 0) return null;
  const live = subs.filter((s) => s.status === "running").length;
  return (
    <Pane id="agents" title="Subagents" aside={live ? <span className="text-accent-hi">{live} live</span> : `${subs.length} done`}>
      <div className="flex flex-col gap-1">
        {subs.map((s) => (
          <SubagentCard key={s.id} sub={s} dense onOpen={() => setOpenId(s.id)} />
        ))}
      </div>
      <SubagentDialog agentKey={agentKey} sub={sub} open={sub != null} onOpenChange={(o) => !o && setOpenId(null)} />
    </Pane>
  );
}

export function FilesPanel({ agentKey }: { agentKey: string }) {
  const { hostId } = parseAgentKey(agentKey);
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const files = meta?.files ?? [];
  if (files.length === 0) return null;
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  const review = () => agent && navigate({ name: "review", hostId, workspaceId: agent.workspaceId });
  return (
    <Pane id="files" title="Changed files" aside={<DiffStatText added={added} removed={removed} />}>
      <div className="flex flex-col gap-0.5">
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            onClick={review}
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            className="focus-ring pressable flex items-center gap-2 rounded-[10px] px-1.5 py-1 text-left hover:bg-white/[0.04]"
          >
            <FileCode2 className={cn("size-3.5 shrink-0", f.status === "added" || f.status === "untracked" ? "text-add" : f.status === "deleted" ? "text-del" : "text-mute-2")} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">
              <span className="text-mute-2">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : ""}</span>
              {f.path.slice(f.path.lastIndexOf("/") + 1)}
            </span>
            <DiffStatText added={f.added} removed={f.removed} />
          </button>
        ))}
      </div>
      <button type="button" onClick={review} className="pressable focus-ring mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-white/[0.05] py-2 text-xs font-bold text-ink-2 shadow-hairline hover:bg-white/[0.09]">
        <GitMerge className="size-3.5" /> Review & ship
      </button>
    </Pane>
  );
}

interface TreeRow {
  node: TreeNode;
  depth: number;
  leaf: boolean;
}

function flattenTree(tree: TreeInfo): TreeRow[] {
  const children = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  const ids = new Set(tree.nodes.map((n) => n.id));
  for (const n of tree.nodes) {
    if (n.parentId && ids.has(n.parentId)) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
    else roots.push(n);
  }
  const out: TreeRow[] = [];
  // Iterative DFS; the on-path child continues the current lane, other children branch right.
  const stack: { n: TreeNode; depth: number }[] = roots.reverse().map((n) => ({ n, depth: 0 }));
  while (stack.length) {
    const { n, depth } = stack.pop()!;
    out.push({ node: n, depth, leaf: n.id === tree.leafId });
    const kids = [...(children.get(n.id) ?? [])].sort((a, b) => Number(b.onPath) - Number(a.onPath) || a.at - b.at);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i]!, depth: i === 0 ? depth : depth + 1 });
  }
  return out;
}

export function TreePanel({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const tree = meta?.tree;
  const [busy, run] = usePending();
  const caps = meta?.caps;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = tree ? flattenTree(tree) : [];
  useEffect(() => {
    // Scroll only the tree's own box (scrollIntoView would also scroll the inspector rail).
    const box = scrollRef.current;
    const leaf = box?.querySelector<HTMLElement>("[data-leaf=true]");
    if (box && leaf) box.scrollTop = leaf.offsetTop - box.clientHeight / 2;
  }, [tree?.leafId]);
  if (!caps?.tree && !tree) return null;
  const forks = rows.filter((r) => r.depth > 0 && (rows.find((x) => x.node.id === r.node.parentId)?.depth ?? 0) < r.depth).length;
  return (
    <Pane id="tree" title="Session tree" aside={forks ? `${forks} branch${forks === 1 ? "" : "es"}` : undefined}>
      {!tree || rows.length === 0 ? (
        <EmptyState compact title="No tree yet" description="Branch or fork from any message once the session has turns." />
      ) : (
        <div ref={scrollRef} className="relative -mx-1 max-h-[300px] overflow-y-auto px-1">
          {rows.map(({ node, depth, leaf }) => (
            <div
              key={node.id}
              data-leaf={leaf}
              className={cn("group/node relative flex items-center gap-2 rounded-[10px] py-[3px] pr-1 hover:bg-white/[0.04]", leaf && "bg-accent/10")}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {Array.from({ length: depth }, (_, i) => (
                <span key={i} className="absolute top-0 bottom-0 w-px bg-review/30" style={{ left: 9 + i * 14 }} aria-hidden />
              ))}
              <span
                className={cn(
                  "relative z-[1] size-2 shrink-0 rounded-full",
                  leaf ? "bg-sun shadow-[0_0_0_3px_rgb(255_61_119/0.25)]" : node.onPath ? "bg-ink-2" : depth > 0 ? "bg-review" : "bg-mute-2",
                )}
              />
              <span className={cn("min-w-0 flex-1 truncate text-[11.5px]", node.onPath ? "font-semibold text-ink-2" : "text-mute", node.kind === "user" && "font-bold")}>
                {node.kind === "user" ? "› " : node.kind === "compaction" || node.kind === "summary" ? "≡ " : ""}
                {node.label.replace(/\*\*|__|`/g, "")}
              </span>
              {node.children > 1 && <span className="shrink-0 font-mono text-[10px] text-review">⑂{node.children}</span>}
              <span className="hidden shrink-0 items-center gap-0.5 group-focus-within/node:flex group-hover/node:flex">
                {caps?.tree && !leaf && (
                  <IconButton label="Go to this point" size="sm" className="size-6" disabled={busy} onClick={() => void run(hostCall(hostId, "agent.navigate", { agentId, entryId: node.id }, { success: "Moved in tree" }))}>
                    <Navigation />
                  </IconButton>
                )}
                {caps?.branch && (
                  <IconButton label="Branch from here" size="sm" className="size-6" disabled={busy} onClick={() => void run(hostCall(hostId, "agent.branch", { agentId, entryId: node.id }, { success: "Branched" }))}>
                    <GitBranch />
                  </IconButton>
                )}
                {caps?.fork && (
                  <IconButton
                    label="Fork from here into a new pane"
                    size="sm"
                    className="size-6"
                    disabled={busy}
                    onClick={() => void run(hostCall(hostId, "agent.fork", { agentId, entryId: node.id, placement: "pane" }, { success: "Forked into a new pane" }))}
                  >
                    <GitFork />
                  </IconButton>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 text-[10.5px] text-mute-2">Hover a node to go there, branch, or fork.</div>
    </Pane>
  );
}

export function BtwPanel({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const asked = useSessionUi((s) => s.btw[agentKey]) ?? [];
  const answers = useBtw(agentKey);
  const [q, setQ] = useState("");
  const [busy, run] = usePending();
  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    const res = await run(hostCall(hostId, "agent.btw", { agentId, question }, { failure: "btw failed" }));
    if (res.ok) {
      useSessionUi.getState().addBtw(agentKey, res.value.btwId, question);
      setQ("");
    }
  };
  const disabled = meta ? !meta.caps.btw : true;
  return (
    <Pane id="btw" title="btw · side question" aside={<MessageCircleQuestion className="size-3.5" aria-label="Answered from the session's context without adding to it" />}>
      <div className="flex flex-col gap-2.5">
        {[...asked].reverse().map((b) => {
          const a = answers[b.id];
          return (
            <div key={b.id} className="rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2 shadow-hairline">
              <div className="text-xs font-bold text-ink">{b.question}</div>
              <div className="mt-1">
                {a && a.text ? (
                  <Markdown text={a.text} streaming={!a.done} className="text-[12.5px]" />
                ) : (
                  <Shimmer className="text-xs">{a?.done ? "No answer" : "Thinking…"}</Shimmer>
                )}
              </div>
            </div>
          );
        })}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask();
            }
          }}
          disabled={disabled}
          placeholder={disabled ? "btw unavailable for this session" : "Ask without interrupting…"}
          aria-label="Side question"
          trailing={
            <IconButton label="Ask" size="sm" onClick={() => void ask()} disabled={disabled || !q.trim() || busy}>
              {busy ? <Spinner size={13} /> : <Send />}
            </IconButton>
          }
        />
      </div>
    </Pane>
  );
}

/** Desktop right rail: every inspector panel stacked; `tab` changes scroll to (and flash) a panel. */
export function Inspector({ agentKey, className }: { agentKey: string; className?: string }) {
  const tab = useSessionUi((s) => s.tab[agentKey]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tab) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-panel="${tab}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    el.animate([{ boxShadow: "0 0 0 2px rgb(163 92 240 / 0.7), 0 0 30px rgb(163 92 240 / 0.4)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1100, easing: "ease-out" });
    el.querySelector<HTMLInputElement>("input")?.focus();
  }, [tab]);
  return (
    <SessionCtx.Provider value={{ ...parseAgentKey(agentKey), key: agentKey }}>
    <aside ref={ref} aria-label="Inspector" className={cn("flex min-h-0 flex-col gap-3 overflow-y-auto pb-4 no-scrollbar", className)}>
      <OverviewPanel agentKey={agentKey} />
      <TodosPanel agentKey={agentKey} />
      <SubagentsPanel agentKey={agentKey} />
      <FilesPanel agentKey={agentKey} />
      <BtwPanel agentKey={agentKey} />
      <TreePanel agentKey={agentKey} />
    </aside>
    </SessionCtx.Provider>
  );
}

const TABS: { value: InspectorTab; label: ReactNode }[] = [
  { value: "overview", label: "Overview" },
  { value: "todos", label: <ListTodo className="size-4" aria-label="Todos" /> },
  { value: "agents", label: <Bot className="size-4" aria-label="Subagents" /> },
  { value: "files", label: <FileCode2 className="size-4" aria-label="Files" /> },
  { value: "tree", label: <Workflow className="size-4" aria-label="Tree" /> },
  { value: "btw", label: <MessageCircleQuestion className="size-4" aria-label="btw" /> },
];

/** Mobile inspector body (inside a BottomSheet): one panel at a time. */
export function InspectorTabs({ agentKey }: { agentKey: string }) {
  const tab = useSessionUi((s) => s.tab[agentKey]) ?? "overview";
  const setTab = (t: InspectorTab) => useSessionUi.getState().setTab(agentKey, t);
  const { meta } = useSession(agentKey);
  const empty =
    (tab === "todos" && !meta?.todos.length) || (tab === "agents" && !meta?.subagents.length) || (tab === "files" && !meta?.files.length);
  return (
    <SessionCtx.Provider value={{ ...parseAgentKey(agentKey), key: agentKey }}>
    <div className="flex flex-col gap-3 pb-2">
      <SegmentedControl value={tab} onValueChange={setTab} options={TABS} fill size="sm" />
      {tab === "overview" && <OverviewPanel agentKey={agentKey} />}
      {tab === "todos" && <TodosPanel agentKey={agentKey} />}
      {tab === "agents" && <SubagentsPanel agentKey={agentKey} />}
      {tab === "files" && <FilesPanel agentKey={agentKey} />}
      {tab === "tree" && <TreePanel agentKey={agentKey} />}
      {tab === "btw" && <BtwPanel agentKey={agentKey} />}
      {empty && <EmptyState compact title={tab === "todos" ? "No todos" : tab === "agents" ? "No subagents" : "No changed files"} />}
    </div>
    </SessionCtx.Provider>
  );
}
