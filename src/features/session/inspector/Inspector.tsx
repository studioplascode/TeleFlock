import { Bot, FileCode2, GitBranch, GitFork, GitMerge, Gauge, ListTodo, MessageCircleQuestion, MessagesSquare, Navigation, Reply, Send, Square, Workflow } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type BtwEntry, type BtwTurnView, core, draftKey, drafts, navigate, parseAgentKey, useAgent, useBtw, useCore, useDraft, useIrcEntries, useSession } from "@/core";
import { SessionCtx } from "../context";
import type { BtwThread, BtwTurn, TreeInfo, TreeNode } from "@/core/gen";
import { Button, cn, EmptyState, formatCompact, IconButton, Input, Shimmer, Sparkline, Spinner, useMediaQuery, useNow } from "@/design";
import { Term } from "@/features/shell/Term";
import { ACTIONS } from "@/features/shell/vocab";
import { errorText, hostCall, usePending } from "../api";
import { ChatThreads, useIrcUnreadCount } from "../irc/ChatThreads";
import { Markdown } from "../markdown/Markdown";
import { type InspectorTab, useSessionUi } from "../state";
import { SubagentCard } from "../subagents/Subagents";
import { DiffStatText } from "../tools/DiffBody";
import { TodoPhases, todoCounts } from "../tools/TodoList";
import { SPENDERS, SpendTile } from "../spend";
import { LimitsMeter, Meter } from "./LimitsTile";

function Pane({ id, title, label, aside, children, className }: { id: InspectorTab; title: ReactNode; label?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section data-panel={id} className={cn("rounded-[22px] glass px-4 py-3.5 transition-shadow duration-500", className)} aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="kicker">{title}</div>
        {aside && <span className="text-[11px] font-bold text-mute">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** Tile chrome inside the Session pane. */
const TILE = "rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2.5 shadow-hairline";

/** Rolling tok/s history: one sample per second of the latest value, 60 s (only while mounted; the clock pauses while the window is inactive). */
function useTpsHistory(value: number | undefined): number[] {
  const now = useNow(1000);
  const [hist, setHist] = useState<{ at: number; values: number[] }>({ at: 0, values: [] });
  const latest = value ?? 0;
  // one sample per clock tick (not per tps patch), so the history always spans 60 s
  useEffect(() => {
    setHist((h) => (h.at === now ? h : { at: now, values: [...h.values.slice(-59), latest] }));
  }, [now, latest]);
  return hist.values;
}

export function OverviewPanel({ agentKey }: { agentKey: string }) {
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  // Every spender's live output (main + subagents + advisor), as tf-hostd sums it.
  const tps = agent?.live.tps;
  const split = agent?.live.tpsSplit;
  const hist = useTpsHistory(tps);
  const ctx = meta?.context ?? agent?.omp?.context;
  const cost = meta?.cost ?? agent?.omp?.cost;
  const producing = tps != null && tps > 0;
  const peak = Math.max(0, ...hist);
  return (
    <Pane id="overview" title="Session">
      <div className="flex flex-col gap-2">
        {/* Can it keep going: context used and subscription left, as bars that say which way they count. */}
        <div className={cn(TILE, "flex flex-wrap gap-x-4 gap-y-2.5")} aria-label="Can it keep going">
          <Meter
            term={<Term id="context">ctx</Term>}
            reading={ctx ? `${Math.round(ctx.pct)}% used` : "—"}
            fill={ctx?.pct ?? 0}
            status={ctx && ctx.pct >= 85 ? "error" : ctx && ctx.pct >= 65 ? "needs-you" : undefined}
            label={ctx ? `Context ${Math.round(ctx.pct)}% used` : "Context unknown"}
            detail={ctx ? `${formatCompact(ctx.tokens)} / ${formatCompact(ctx.window)}` : undefined}
          />
          <LimitsMeter agentKey={agentKey} tps={tps ?? undefined} />
        </div>
        <SpendTile cost={cost} />
        <div className={cn(TILE, "pt-2 pb-1.5")} aria-label="Throughput">
          <div className="flex items-baseline justify-between gap-2 text-[10.5px] font-bold text-mute">
            <span>Throughput · 60s</span>
            <span className="text-mute-2 tabular">
              {producing ? <span className="text-accent-hi">now {Math.round(tps)} tok/s</span> : meta?.tps != null ? `last turn ${Math.round(meta.tps)} tok/s` : "now 0"}
              {peak > 0 && ` · peak ${Math.round(peak)}`}
            </span>
          </div>
          <div className="relative">
            <Sparkline values={hist.length > 1 ? hist : [0, 0]} height={34} live={producing} status={producing ? "running" : "idle"} />
            {!producing && peak === 0 && <span className="absolute inset-0 grid place-items-center text-[10.5px] font-semibold text-mute-2">idle · no tokens in the last minute</span>}
          </div>
          {split && (
            <div className="flex flex-wrap gap-x-3 text-[10.5px] font-semibold text-mute-2 tabular" aria-label="Throughput by source">
              {SPENDERS.map((s) => (
                <span key={s.key} className="flex items-center gap-1">
                  <span className={cn("size-1.5 rounded-full", s.dot)} />
                  {s.term}
                  <span className={split[s.key] > 0 ? "text-accent-hi" : undefined}>{split[s.key] > 0 ? Math.round(split[s.key]) : "—"}</span>
                </span>
              ))}
            </div>
          )}
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
    <Pane
      id="todos"
      title="Todos"
      aside={
        <span className="tabular">
          {c.done}/{c.total}
          {c.blocked > 0 && <span className="text-sun-1"> · {c.blocked} blocked</span>}
        </span>
      }
    >
      <TodoPhases phases={todos} />
    </Pane>
  );
}

export function SubagentsPanel({ agentKey }: { agentKey: string }) {
  const { meta } = useSession(agentKey);
  const subs = meta?.subagents ?? [];
  if (subs.length === 0) return null;
  const live = subs.filter((s) => s.status === "running").length;
  return (
    <Pane
      id="agents"
      title={
        <Term id="subagent" className="[text-transform:inherit]">
          Subagents
        </Term>
      }
      label="Subagents"
      aside={live ? <span className="text-accent-hi">{live} live</span> : `${subs.length} done`}
    >
      <div className="flex flex-col gap-1">
        {subs.map((s) => (
          <SubagentCard key={s.id} sub={s} dense onOpen={() => useSessionUi.getState().openSubagent(agentKey, s.id)} />
        ))}
      </div>
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
        <GitMerge className="size-3.5" /> {ACTIONS.review.label}
      </button>
    </Pane>
  );
}

interface TreeRow {
  node: TreeNode;
  depth: number;
  leaf: boolean;
}

interface TreeLayout {
  rows: TreeRow[];
  /** Rows that open a branch lane (their parent sits in a shallower lane). */
  forks: number;
  /** Row of the current leaf, -1 if none. */
  leafIndex: number;
}

const NO_TREE: TreeLayout = { rows: [], forks: 0, leafIndex: -1 };

function layoutTree(tree: TreeInfo): TreeLayout {
  const children = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];
  const ids = new Set(tree.nodes.map((n) => n.id));
  for (const n of tree.nodes) {
    const parent = n.parentId !== undefined && ids.has(n.parentId) ? n.parentId : undefined;
    if (parent === undefined) roots.push(n);
    else if (children.has(parent)) children.get(parent)!.push(n);
    else children.set(parent, [n]);
  }
  const rows: TreeRow[] = [];
  // Iterative DFS; the on-path child continues the current lane, other children branch right.
  const stack: { n: TreeNode; depth: number }[] = roots.reverse().map((n) => ({ n, depth: 0 }));
  while (stack.length) {
    const { n, depth } = stack.pop()!;
    rows.push({ node: n, depth, leaf: n.id === tree.leafId });
    const kids = [...(children.get(n.id) ?? [])].sort((a, b) => Number(b.onPath) - Number(a.onPath) || a.at - b.at);
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i]!, depth: i === 0 ? depth : depth + 1 });
  }
  const depthOf = new Map(rows.map((r) => [r.node.id, r.depth]));
  let forks = 0;
  let leafIndex = -1;
  rows.forEach((r, i) => {
    if (r.depth > 0 && (depthOf.get(r.node.parentId ?? "") ?? 0) < r.depth) forks++;
    if (r.leaf) leafIndex = i;
  });
  return { rows, forks, leafIndex };
}

/** hostd re-sends the whole tree with every session meta: it only counts as new once the leaf or the node count moves. */
function sameTree(a: TreeInfo | undefined, b: TreeInfo | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.leafId === b.leafId && a.nodes.length === b.nodes.length);
}

/** Rows have a fixed height so only those in view (plus TREE_OVERSCAN) render: long sessions have thousands of entries. */
const TREE_ROW_PX = 24;
/** Touch screens show each row's actions inline (24 px buttons). */
const TREE_ROW_TOUCH_PX = 30;
const TREE_VIEW_PX = 300;
const TREE_OVERSCAN = 8;

export function TreePanel({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const tree = useCore((s) => s.sessions[agentKey]?.meta?.tree, sameTree);
  const canTree = useCore((s) => s.sessions[agentKey]?.meta?.caps.tree ?? false);
  const canBranch = useCore((s) => s.sessions[agentKey]?.meta?.caps.branch ?? false);
  const canFork = useCore((s) => s.sessions[agentKey]?.meta?.caps.fork ?? false);
  const [busy, run] = usePending();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { rows, forks, leafIndex } = useMemo(() => (tree ? layoutTree(tree) : NO_TREE), [tree]);
  const rowPx = useMediaQuery("(pointer: coarse)") ? TREE_ROW_TOUCH_PX : TREE_ROW_PX;
  const [top, setTop] = useState(0);
  const first = Math.max(0, top - TREE_OVERSCAN);
  const last = Math.min(rows.length, top + Math.ceil(TREE_VIEW_PX / rowPx) + TREE_OVERSCAN);
  useEffect(() => {
    // Centre the leaf in the tree's own box (scrollIntoView would also scroll the inspector rail).
    const box = scrollRef.current;
    if (box && leafIndex >= 0) box.scrollTop = leafIndex * rowPx - box.clientHeight / 2;
  }, [tree?.leafId]);
  if (!canTree && !tree) return null;
  return (
    <Pane id="tree" title="Session tree" aside={forks ? `${forks} branch${forks === 1 ? "" : "es"}` : undefined}>
      {!tree || rows.length === 0 ? (
        <EmptyState compact title="No tree yet" description="Branch or fork from any message once the session has turns." />
      ) : (
        <div ref={scrollRef} onScroll={(e) => setTop(Math.floor(e.currentTarget.scrollTop / rowPx))} className="relative -mx-1 overflow-y-auto px-1" style={{ maxHeight: TREE_VIEW_PX }}>
          {/* Clips the rows' enlarged button hit areas: they would add scroll height and scroll a short tree's first row out of view. */}
          <div className="relative overflow-hidden" style={{ height: rows.length * rowPx }}>
            {rows.slice(first, last).map(({ node, depth, leaf }, i) => (
              <div
                key={node.id}
                data-leaf={leaf}
                className={cn("group/node absolute inset-x-0 isolate flex items-center gap-2 rounded-[10px] pr-1 hover:bg-white/[0.04]", leaf && "bg-accent/10")}
                style={{ top: (first + i) * rowPx, height: rowPx, paddingLeft: 6 + depth * 14 }}
              >
                {Array.from({ length: depth }, (_, d) => (
                  <span key={d} className="absolute top-0 bottom-0 w-px bg-review/30" style={{ left: 9 + d * 14 }} aria-hidden />
                ))}
                <span
                  className={cn(
                    "relative z-raised size-2 shrink-0 rounded-full",
                    leaf ? "bg-sun shadow-[0_0_0_3px_rgb(255_61_119/0.25)]" : node.onPath ? "bg-ink-2" : depth > 0 ? "bg-review" : "bg-mute-2",
                  )}
                />
                <span className={cn("min-w-0 flex-1 truncate text-[11.5px]", node.onPath ? "font-semibold text-ink-2" : "text-mute", node.kind === "user" && "font-bold")}>
                  {node.kind === "user" ? "› " : node.kind === "compaction" || node.kind === "summary" ? "≡ " : ""}
                  {node.label.replace(/\*\*|__|`/g, "")}
                </span>
                {node.children > 1 && <span className="shrink-0 font-mono text-[10px] text-review">⑂{node.children}</span>}
                <span className="absolute inset-y-0 right-1 z-raised flex items-center gap-0.5 rounded-[8px] bg-[rgb(24_24_32/0.96)] pl-1 opacity-0 transition-opacity group-focus-within/node:opacity-100 group-hover/node:opacity-100 [@media(pointer:coarse)]:static [@media(pointer:coarse)]:shrink-0 [@media(pointer:coarse)]:bg-transparent [@media(pointer:coarse)]:opacity-100">
                  {canTree && !leaf && (
                    <IconButton label="Go to this point" size="sm" className="size-6" disabled={busy} onClick={() => void run(hostCall(hostId, "agent.navigate", { agentId, entryId: node.id }, { success: "Moved in tree" }))}>
                      <Navigation />
                    </IconButton>
                  )}
                  {canBranch && (
                    <IconButton label="Branch from here" size="sm" className="size-6" disabled={busy} onClick={() => void run(hostCall(hostId, "agent.branch", { agentId, entryId: node.id }, { success: "Branched" }))}>
                      <GitBranch />
                    </IconButton>
                  )}
                  {canFork && (
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
        </div>
      )}
      <div className="mt-2 text-[10.5px] text-mute-2">
        <span className="[@media(pointer:coarse)]:hidden">Hover a node to go there, branch, or fork.</span>
        <span className="hidden [@media(pointer:coarse)]:inline">Go to, branch, or fork from any node.</span>
      </div>
    </Pane>
  );
}

/** One side conversation as shown: omp's `/btw` history overlaid by what streamed live, oldest turn first. */
interface BtwRow {
  id: string;
  turns: BtwTurnView[];
}

function historyTurn(t: BtwTurn): BtwTurnView {
  // Same wording as a live turn that ended badly (hostd appends `⚠ <error>`).
  const trouble = t.status === "complete" || t.status === "running" ? "" : `⚠ ${t.error ?? t.status}`;
  return { question: t.question, text: trouble ? `${t.answer}${t.answer ? "\n\n" : ""}${trouble}` : t.answer, done: t.status !== "running" };
}

/** History conversations (oldest first), then ones seen only live (newer); returned newest first. */
function btwRows(history: BtwThread[], live: Record<string, BtwEntry>): BtwRow[] {
  const rows: BtwRow[] = [];
  const known = new Set<string>();
  for (const th of history) {
    known.add(th.btwId);
    const streamed = live[th.btwId]?.turns ?? [];
    const turns: BtwTurnView[] = [];
    for (let i = 0; i < Math.max(th.turns.length, streamed.length); i++) {
      const s = streamed[i];
      const h = th.turns[i];
      const t = s ? { ...s, question: s.question ?? h?.question } : h && historyTurn(h);
      if (t) turns.push(t);
    }
    rows.push({ id: th.btwId, turns });
  }
  for (const [id, e] of Object.entries(live)) {
    if (!known.has(id)) rows.push({ id, turns: e.turns.filter((t): t is BtwTurnView => t !== undefined) });
  }
  return rows.reverse();
}

export function BtwPanel({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const live = useBtw(agentKey);
  const key = draftKey("btw.question", agentKey);
  const [q, setQ] = useDraft(key);
  const [busy, run] = usePending();
  const enabled = meta?.caps.btw ?? false;
  const sessionId = meta?.sessionId;
  // omp's /btw history: earlier conversations, asked here or in the terminal.
  const [history, setHistory] = useState<{ sessionId?: string; threads: BtwThread[]; error?: string }>({ threads: [] });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    core
      .host(hostId)
      .call("agent.btwHistory", { agentId })
      .then(
        (h) => alive && setHistory({ sessionId, threads: h.threads }),
        (e: unknown) => alive && setHistory({ sessionId, threads: [], error: errorText(e).title }),
      );
    return () => {
      alive = false;
    };
  }, [hostId, agentId, enabled, sessionId]);
  const rows = btwRows(history.sessionId === sessionId ? history.threads : [], live);
  // omp answers one side question at a time.
  const running = rows.some((r) => r.turns.some((t) => !t.done));
  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    const res = await run(hostCall(hostId, "agent.btw", { agentId, question }, { failure: "btw failed" }));
    if (res.ok) {
      // Only what was asked: anything typed while asking stays in the draft.
      const cur = drafts.get(key);
      drafts.set(key, cur.startsWith(q) ? cur.slice(q.length).trimStart() : cur);
    }
  };
  return (
    <Pane
      id="btw"
      title={
        <>
          <Term id="btw" className="[text-transform:inherit]">
            btw
          </Term>{" "}
          · side question
        </>
      }
      label="btw · side question"
      aside={<MessageCircleQuestion className="size-3.5" aria-label="Answered from the session's context without adding to it; also in omp's /btw" />}
    >
      <div className="flex flex-col gap-2.5">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running) void ask();
            }
          }}
          disabled={!enabled}
          placeholder={!enabled ? "btw unavailable for this session" : "Ask without interrupting…"}
          aria-label="Side question"
          trailing={
            <IconButton label={running ? "Wait for the side question that is answering" : "Ask"} size="sm" onClick={() => void ask()} disabled={!enabled || !q.trim() || busy || running}>
              {busy ? <Spinner size={13} /> : <Send />}
            </IconButton>
          }
        />
        {rows.map((row) => (
          <BtwConversation key={row.id} row={row} hostId={hostId} agentId={agentId} canFollowUp={enabled && !running} />
        ))}
        {history.error && history.sessionId === sessionId && <div className="text-[11px] text-mute-2">Earlier side questions unavailable: {history.error}</div>}
      </div>
    </Pane>
  );
}

/** One side conversation: its turns, then Cancel while answering or a follow-up box (omp's `f`). */
function BtwConversation({ row, hostId, agentId, canFollowUp }: { row: BtwRow; hostId: string; agentId: string; canFollowUp: boolean }) {
  const [reply, setReply] = useState<string | null>(null);
  const [busy, run] = usePending();
  const answering = row.turns.some((t) => !t.done);
  const send = async () => {
    const question = reply?.trim();
    if (!question) return;
    const res = await run(hostCall(hostId, "agent.btw", { agentId, question, btwId: row.id }, { failure: "Follow-up failed" }));
    if (res.ok) setReply(null);
  };
  return (
    <div className="rounded-lg bg-[rgb(10_10_16/0.45)] px-3 py-2 shadow-hairline" data-btw={row.id}>
      {row.turns.map((t, i) => (
        <div key={i} className={cn(i > 0 && "mt-2 border-t border-white/6 pt-2")}>
          <div className="text-xs font-bold text-ink">
            {i > 0 && <span className="text-mute">↳ </span>}
            {t.question ?? "…"}
          </div>
          <div className="mt-1">
            {t.text ? (
              <Markdown text={t.text} streaming={!t.done} className="text-[12.5px]" />
            ) : (
              <Shimmer className="text-xs">{t.done ? "No answer" : "Thinking…"}</Shimmer>
            )}
          </div>
        </div>
      ))}
      {answering ? (
        <div className="mt-1 flex justify-end">
          <Button size="sm" variant="ghost" icon={<Square />} loading={busy} onClick={() => void run(hostCall(hostId, "agent.btwCancel", { agentId, btwId: row.id }, { failure: "Cancel failed" }))}>
            Cancel
          </Button>
        </div>
      ) : reply === null ? (
        <div className="mt-1 flex justify-end">
          <Button size="sm" variant="ghost" icon={<Reply />} disabled={!canFollowUp} onClick={() => setReply("")}>
            Follow up
          </Button>
        </div>
      ) : (
        <Input
          autoFocus
          className="mt-2"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setReply(null);
            }
          }}
          placeholder="Follow up on this answer…"
          aria-label="Follow-up question"
          trailing={
            <IconButton label="Send follow-up" size="sm" onClick={() => void send()} disabled={!canFollowUp || !reply.trim() || busy}>
              {busy ? <Spinner size={13} /> : <Send />}
            </IconButton>
          }
        />
      )}
    </div>
  );
}

/** Agent ↔ agent IRC of this session, grouped by peer (hidden until there is any). */
export function ChatPanel({ agentKey }: { agentKey: string }) {
  const entries = useIrcEntries(agentKey);
  const unread = useIrcUnreadCount(agentKey);
  if (entries.length === 0) return null;
  const peers = new Set(entries.map((e) => e.message.peer)).size;
  return (
    <Pane id="chat" title="Agent chat · IRC" aside={unread > 0 ? <span className="text-accent-hi">{unread} new</span> : `${peers} peer${peers === 1 ? "" : "s"}`}>
      <ChatThreads agentKey={agentKey} />
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
      <ChatPanel agentKey={agentKey} />
      <BtwPanel agentKey={agentKey} />
      <TreePanel agentKey={agentKey} />
    </aside>
    </SessionCtx.Provider>
  );
}

const TABS: { value: InspectorTab; label: string; icon: ReactNode }[] = [
  { value: "overview", label: "Session", icon: <Gauge /> },
  { value: "todos", label: "Todos", icon: <ListTodo /> },
  { value: "agents", label: "Agents", icon: <Bot /> },
  { value: "files", label: "Files", icon: <FileCode2 /> },
  { value: "chat", label: "Chat", icon: <MessagesSquare /> },
  { value: "btw", label: "btw", icon: <MessageCircleQuestion /> },
  { value: "tree", label: "Tree", icon: <Workflow /> },
];

/** Mobile inspector body (inside a BottomSheet): one panel at a time, picked from labelled tabs. */
export function InspectorTabs({ agentKey }: { agentKey: string }) {
  const tab = useSessionUi((s) => s.tab[agentKey]) ?? "overview";
  const { meta } = useSession(agentKey);
  const chats = useIrcEntries(agentKey).length;
  const unread = useIrcUnreadCount(agentKey);
  const empty =
    (tab === "todos" && !meta?.todos.length) ||
    (tab === "agents" && !meta?.subagents.length) ||
    (tab === "chat" && !chats) ||
    (tab === "files" && !meta?.files.length);
  return (
    <SessionCtx.Provider value={{ ...parseAgentKey(agentKey), key: agentKey }}>
    <div className="flex flex-col gap-3 pb-2">
      <div role="tablist" aria-label="Inspector" className="grid grid-cols-7 gap-0.5 rounded-md well p-1">
        {TABS.map((t) => {
          const on = t.value === tab;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => useSessionUi.getState().setTab(agentKey, t.value)}
              className={cn(
                "relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-sm px-0.5 text-[10px] font-bold transition-colors focus-ring [&_svg]:size-4",
                on ? "bg-tile-4 text-ink shadow-d1" : "text-mute",
              )}
            >
              {t.icon}
              <span className="max-w-full truncate">{t.label}</span>
              {t.value === "chat" && unread > 0 && (
                <span className="absolute top-1 right-1.5 size-2 rounded-full bg-accent shadow-[0_0_6px_rgb(163_92_240/0.9)]" aria-label={`${unread} unread`} />
              )}
            </button>
          );
        })}
      </div>
      {tab === "overview" && <OverviewPanel agentKey={agentKey} />}
      {tab === "todos" && <TodosPanel agentKey={agentKey} />}
      {tab === "agents" && <SubagentsPanel agentKey={agentKey} />}
      {tab === "chat" && <ChatPanel agentKey={agentKey} />}
      {tab === "files" && <FilesPanel agentKey={agentKey} />}
      {tab === "tree" && <TreePanel agentKey={agentKey} />}
      {tab === "btw" && <BtwPanel agentKey={agentKey} />}
      {empty && (
        <EmptyState
          compact
          title={tab === "todos" ? "No todos" : tab === "agents" ? "No subagents" : tab === "chat" ? "No agent chat yet" : "No changed files"}
          description={tab === "chat" ? "Messages this agent and its subagents send each other over omp IRC show up here." : undefined}
        />
      )}
    </div>
    </SessionCtx.Provider>
  );
}
