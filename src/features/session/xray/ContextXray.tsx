import { ChevronDown, ChevronRight, ImageOff, Layers, RefreshCw, ScanSearch, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { core, getTranscript, parseAgentKey, toApiError, useAgent, useSession } from "@/core";
import type { ContextXray as Xray, XrayCategory } from "@/core/gen";
import { BottomSheet, Button, cn, Dialog, DialogContent, EmptyState, formatAge, IconButton, Input, Skeleton, toast, useIsMobile, useNow } from "@/design";
import { openTerminal } from "@/features/board/agentActions";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { hostCall, usePending } from "../api";
import { useSessionUi } from "../state";
import { biggestOutputs, roomText, sharePct, suggestFocus, toolRowOf, XRAY_COLOR, xraySegments } from "./xray";

const int = new Intl.NumberFormat("en-US");

const SOURCE_NOTE: Record<Xray["source"], string> = {
  omp: "omp's own /context breakdown. Category totals split what is used by omp's estimates; the entries inside may not add up to them.",
  estimate: "Estimated by TeleFlock's bridge (this omp has no /context viewer): omp's reported usage, split by each part's size.",
  usage: "omp's reported totals only.",
};

/** Native `/context`: the session dialog `context` (desktop dialog, phone bottom sheet). */
export function ContextXray({ agentKey }: { agentKey: string }) {
  const open = useSessionUi((s) => s.dialog[agentKey] === "context");
  return open ? <XrayView agentKey={agentKey} /> : null;
}

interface Load {
  data?: Xray;
  error?: { code: string; message: string; hint?: string };
  loading: boolean;
}

function XrayView({ agentKey }: { agentKey: string }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const mobile = useIsMobile();
  const agent = useAgent(agentKey);
  const { meta } = useSession(agentKey);
  const [load, setLoad] = useState<Load>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const close = () => useSessionUi.getState().openDialog(agentKey, null);
  useEffect(() => {
    let live = true;
    setLoad((l) => ({ ...l, loading: true }));
    core
      .host(hostId)
      .call("session.context", { agentId })
      .then(
        (data) => live && setLoad({ data, loading: false }),
        (e: unknown) => {
          if (!live) return;
          const err = toApiError(e);
          setLoad({ loading: false, error: { code: err.code, message: err.message, hint: err.hint } });
        },
      );
    return () => {
      live = false;
    };
  }, [hostId, agentId, nonce]);
  // omp's count moves after a compaction, a shake or a turn: read the breakdown again once it settles.
  const tokens = agent?.omp?.context?.tokens;
  const shown = useRef(tokens);
  useEffect(() => {
    if (tokens === shown.current) return;
    shown.current = tokens;
    const t = window.setTimeout(() => setNonce((n) => n + 1), 1500);
    return () => window.clearTimeout(t);
  }, [tokens]);

  const [focus, setFocus] = useState(() => suggestFocus(meta, getTranscript(agentKey).items));
  const [busy, run] = usePending();
  const compact = async () => {
    const r = await run(hostCall(hostId, "agent.compact", { agentId, instructions: focus.trim() || undefined }, { success: "Compacting…" }));
    if (r.ok) setNonce((n) => n + 1);
  };
  const data = load.data;
  const images = data?.dropImages ? data.images : 0;
  const dropImages = async () => {
    const ok = await confirmAction({
      title: `Drop ${images} image${images === 1 ? "" : "s"} from ${agent?.name ?? "this session"}?`,
      body: "omp's /shake images removes every image block from the session's context. The agent can no longer see them, and this can't be undone.",
      confirmLabel: `Drop ${images} image${images === 1 ? "" : "s"}`,
      danger: true,
    });
    if (!ok) return;
    const r = await run(hostCall(hostId, "agent.slash", { agentId, command: "/shake images" }, { success: `Dropping ${images} image${images === 1 ? "" : "s"}…` }));
    if (r.ok) window.setTimeout(() => setNonce((n) => n + 1), 1500);
  };
  const inTerminal = () => {
    void hostCall(hostId, "agent.slash", { agentId, command: "/context" });
    openTerminal(agentKey, mobile);
    close();
  };
  const jump = (callId: string) => {
    const row = toolRowOf(getTranscript(agentKey).items, callId);
    if (!row) {
      toast({ title: "Not in the loaded transcript", description: "Scroll up in the transcript to load older turns.", status: "idle" });
      return;
    }
    useSessionUi.getState().focusItem(agentKey, row);
    close();
  };

  const body = load.error ? (
    <Fallback agentKey={agentKey} error={load.error} onTerminal={inTerminal} />
  ) : !data ? (
    <Skeleton className="h-64 rounded-lg" />
  ) : (
    <XrayBody x={data} loading={load.loading} onRefresh={() => setNonce((n) => n + 1)} onJump={jump} />
  );
  const actions = load.error ? null : (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      <div className="min-w-56 flex-1">
        <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Focus: what the summary should keep" aria-label="Compaction focus" className="w-full" />
      </div>
      <Button variant="primary" icon={<Layers />} loading={busy} disabled={meta ? !meta.caps.compact : false} onClick={() => void compact()}>
        {focus.trim() ? "Compact with focus" : "Compact"}
      </Button>
      {images > 0 && (
        <Button icon={<ImageOff />} disabled={busy} onClick={() => void dropImages()} title="omp's /shake images: drops every image block from the session">
          Drop {images} image{images === 1 ? "" : "s"}
        </Button>
      )}
    </div>
  );
  const description = `What fills ${agent?.name ?? "this agent"}'s context window`;
  if (mobile)
    return (
      <BottomSheet open onOpenChange={(o) => !o && close()} title="Context X-ray" description={description} maxHeight="92dvh" autoFocus={false} footer={actions}>
        {body}
      </BottomSheet>
    );
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent icon={<ScanSearch />} title="Context X-ray" description={description} width={780} footer={actions} onOpenAutoFocus={(e) => e.preventDefault()}>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** No breakdown (an older bridge, no bridge, a parked agent): omp's status-line totals and the terminal way. */
function Fallback({ agentKey, error, onTerminal }: { agentKey: string; error: NonNullable<Load["error"]>; onTerminal: () => void }) {
  const ctx = useAgent(agentKey)?.omp?.context;
  return (
    <div className="flex flex-col gap-3">
      {ctx && (
        <div className="rounded-lg bg-white/[0.04] px-3 py-2.5 shadow-hairline">
          <div className="font-display text-xl font-bold tabular">
            {int.format(ctx.tokens)} <span className="text-sm font-semibold text-mute">of {int.format(ctx.window)} tokens · {Math.round(ctx.pct)}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/8">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, ctx.pct)}%` }} />
          </div>
        </div>
      )}
      <EmptyState
        compact
        title={error.code === "unsupported" ? "No breakdown from this agent's omp" : error.code === "unknown_method" ? "This host predates the context X-ray" : "Couldn't read the breakdown"}
        description={error.code === "unknown_method" ? "Update TeleFlock on the host." : error.hint ? `${error.message}. ${error.hint}.` : error.message}
        action={
          <Button icon={<SquareTerminal />} onClick={onTerminal}>
            Show omp's /context in the terminal
          </Button>
        }
      />
    </div>
  );
}

function XrayBody({ x, loading, onRefresh, onJump }: { x: Xray; loading: boolean; onRefresh: () => void; onJump: (callId: string) => void }) {
  const now = useNow(10_000);
  const [open, setOpen] = useState<string | null>(null);
  const segments = xraySegments(x);
  const outputs = biggestOutputs(x);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-display text-2xl font-bold tabular">
          {int.format(x.used)}
          <span className="text-sm font-semibold text-mute">
            {" "}
            of {int.format(x.window)} tokens · {x.window > 0 ? Math.round((x.used / x.window) * 100) : 0}%
          </span>
        </div>
        <div className="flex items-center gap-1 text-[12px] font-semibold text-mute">
          {roomText(x)}
          <IconButton label="Read again" size="sm" onClick={onRefresh}>
            <RefreshCw className={cn(loading && "opacity-40")} />
          </IconButton>
        </div>
      </div>
      <div className="relative">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/6" role="img" aria-label={`Context: ${int.format(x.used)} of ${int.format(x.window)} tokens used`}>
          {segments.map((s) => (
            <span
              key={s.id}
              title={`${s.label} · ${int.format(s.tokens)} tokens (${sharePct(s.tokens, x.window)})`}
              className="h-full shrink-0"
              style={{
                width: `${x.window > 0 ? (s.tokens / x.window) * 100 : 0}%`,
                background: s.id === "buffer" ? `repeating-linear-gradient(135deg, ${s.color}99 0 3px, transparent 3px 7px)` : s.color,
              }}
            />
          ))}
        </div>
        {x.threshold !== undefined && x.window > 0 && (
          <span className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-sun-1" style={{ left: `${(x.threshold / x.window) * 100}%` }} title={`Auto-compaction at ${int.format(x.threshold)} tokens`} />
        )}
      </div>
      {x.categories.length > 0 && (
        <div className="flex flex-col" role="list" aria-label="Context by category">
          {x.categories.map((c) => (
            <CategoryRow key={c.id} c={c} window={x.window} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onJump={onJump} />
          ))}
          <PlainRow color={XRAY_COLOR.buffer as string} hatched label="Auto-compact buffer" tokens={x.buffer} window={x.window} />
          <PlainRow color={XRAY_COLOR.free as string} label="Free space" tokens={x.free} window={x.window} />
        </div>
      )}
      {outputs.length > 0 && (
        <div>
          <div className="kicker mb-1.5">Biggest tool outputs</div>
          <div className="flex flex-col gap-1">
            {outputs.map((e) => (
              <EntryRow key={e.id} label={e.label} tokens={e.tokens} preview={e.preview} callId={e.callId} onJump={onJump} />
            ))}
          </div>
        </div>
      )}
      <p className="text-[11px] leading-snug text-mute-2">
        {SOURCE_NOTE[x.source]} {x.model && <>Model {x.model}. </>}
        {x.snapcompactSaved ? <>Snapcompact saves ~{int.format(x.snapcompactSaved)} tokens on the wire. </> : null}
        Read {formatAge(now - x.at)}.
      </p>
    </div>
  );
}

function CategoryRow({ c, window, open, onToggle, onJump }: { c: XrayCategory; window: number; open: boolean; onToggle: () => void; onJump: (callId: string) => void }) {
  const more = c.top.length > 0 || c.children.length > 0;
  return (
    <div role="listitem">
      <button
        type="button"
        disabled={!more}
        aria-expanded={more ? open : undefined}
        onClick={onToggle}
        className="focus-ring flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] enabled:hover:bg-white/[0.04] disabled:cursor-default"
      >
        <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: XRAY_COLOR[c.id] ?? "#8b8b9e" }} />
        <span className="min-w-0 flex-1 truncate font-semibold text-ink-2">{c.label}</span>
        <span className="font-mono text-[12px] text-ink tabular">{c.tokens === undefined ? "—" : int.format(c.tokens)}</span>
        <span className="w-14 text-right font-mono text-[11.5px] text-mute-2 tabular">{c.tokens === undefined ? "" : sharePct(c.tokens, window)}</span>
        <span className="w-3.5 text-mute-2 [&_svg]:size-3.5">{more && (open ? <ChevronDown /> : <ChevronRight />)}</span>
      </button>
      {open && (
        <div className="mb-2 ml-5 flex flex-col gap-1 border-l border-white/8 pl-3">
          {c.children.length > 0 && (
            <div className="flex flex-wrap gap-1.5 py-1 text-[11.5px] text-mute">
              {c.children.map((k) => (
                <span key={k.label} className="rounded-full bg-white/6 px-2 py-0.5 font-semibold">
                  {k.label} <span className="font-mono tabular">{k.tokens === undefined ? "—" : int.format(k.tokens)}</span>
                  <span className="text-mute-2"> · {k.entries}×</span>
                </span>
              ))}
            </div>
          )}
          {c.top.map((e) => (
            <EntryRow key={e.id} label={e.label} info={e.info} tokens={e.tokens} preview={e.preview} callId={e.callId} onJump={onJump} />
          ))}
          {c.entries > c.top.length && <div className="text-[11px] text-mute-2">… and {c.entries - c.top.length} smaller</div>}
        </div>
      )}
    </div>
  );
}

function EntryRow(p: { label: string; info?: string; tokens: number; preview: string; callId?: string; onJump: (callId: string) => void }) {
  return (
    <div className="rounded-md bg-white/[0.03] px-2.5 py-1.5">
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-semibold text-ink-2" title={p.info}>
          {p.label}
        </span>
        <span className="font-mono text-mute tabular">{int.format(p.tokens)} tok</span>
        {p.callId && (
          <button type="button" className="focus-ring rounded-sm text-[11px] font-bold text-accent-hi hover:underline" onClick={() => p.onJump(p.callId as string)}>
            Show
          </button>
        )}
      </div>
      {p.preview && <div className="mt-0.5 line-clamp-2 font-mono text-[11px] leading-snug break-all text-mute-2">{p.preview}</div>}
    </div>
  );
}

function PlainRow({ color, hatched, label, tokens, window }: { color: string; hatched?: boolean; label: string; tokens: number; window: number }) {
  return (
    <div role="listitem" className="flex items-center gap-2 px-1.5 py-1.5 text-[13px]">
      <span
        className="size-2.5 shrink-0 rounded-[3px] shadow-hairline"
        style={{ background: hatched ? `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 4px)` : color }}
      />
      <span className="min-w-0 flex-1 truncate text-mute">{label}</span>
      <span className="font-mono text-[12px] text-ink-2 tabular">{int.format(tokens)}</span>
      <span className="w-14 text-right font-mono text-[11.5px] text-mute-2 tabular">{sharePct(tokens, window)}</span>
      <span className="w-3.5" />
    </div>
  );
}
