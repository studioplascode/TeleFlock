import {
  ArrowDown,
  Ban,
  Bot,
  ChevronDown,
  CircleCheck,
  CircleX,
  ExternalLink,
  FilePen,
  FileText,
  Globe,
  Image as ImageIcon,
  ListTodo,
  MessageCircleQuestion,
  MessagesSquare,
  NotebookText,
  Search,
  ShieldQuestion,
  ShieldX,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useContext, useMemo, useState } from "react";
import { linkProps, useAgent, useCore, useSession } from "@/core";
import type { BashView, ImageView, Subagent, ToolItem, ToolView } from "@/core/gen";
import { Chip, cn, Elapsed, formatElapsed, Lightbox, LightboxTrigger, Shimmer, spring, Spinner } from "@/design";
import { languageFor } from "../lib/highlight";
import { ImagePlaceholder, useImageSources } from "../lib/images";
import { CodeBlock, Highlighted, Markdown } from "../markdown/Markdown";
import { useSessionUi } from "../state";
import { withRoster } from "../subagents/roster";
import { SubagentCard } from "../subagents/Subagents";
import { SessionCtx, useSessionRef } from "../context";
import { AnsiText } from "./AnsiText";
import { DiffStatText, FileDiffView } from "./DiffBody";
import { TodoPhases, todoCounts } from "./TodoList";

type ViewType = ToolView["type"] | "generic";

const ICON: Record<ViewType, typeof Wrench> = {
  diff: FilePen,
  bash: SquareTerminal,
  read: FileText,
  search: Search,
  todo: ListTodo,
  task: Bot,
  web: Globe,
  image: ImageIcon,
  ask: MessageCircleQuestion,
  markdown: NotebookText,
  irc: MessagesSquare,
  generic: Wrench,
};

/** Tool name → icon kind, for calls whose rich view hasn't arrived yet (or never will). */
const TOOL_KIND: [RegExp, ViewType][] = [
  [/^(bash|shell|exec|python|eval|recipe)/i, "bash"],
  [/^(edit|write|patch|apply|ast_edit|multi_?edit)/i, "diff"],
  [/^(read|view|cat)/i, "read"],
  [/^(grep|find|glob|search|ast_grep|lsp)/i, "search"],
  [/^(web|fetch|browser)/i, "web"],
  [/^(task|agent|subagent)/i, "task"],
  [/^todo/i, "todo"],
  [/^ask/i, "ask"],
  [/^(image|screenshot)/i, "image"],
];

/** Per-kind icon tint so a long run of tool cards scans by shape and colour, not by reading. */
const TONE: Record<ViewType, string> = {
  diff: "bg-add/12 text-add",
  bash: "bg-accent/15 text-accent-hi",
  read: "bg-review/12 text-review",
  search: "bg-warn/12 text-warn",
  todo: "bg-done/12 text-done",
  task: "bg-omp-blue/15 text-omp-blue",
  web: "bg-review/12 text-review",
  image: "bg-omp-pink/15 text-omp-pink",
  ask: "bg-sun-1/15 text-sun-1",
  markdown: "bg-white/8 text-ink-2",
  irc: "bg-omp-pink/15 text-omp-pink",
  generic: "bg-white/6 text-mute",
};

/** Views that start expanded (the rest open on click). */
const OPEN_BY_DEFAULT: Record<ViewType, boolean> = {
  diff: true,
  bash: true,
  read: false,
  search: false,
  todo: true,
  task: true,
  web: true,
  image: true,
  ask: true,
  markdown: true,
  irc: true,
  generic: false,
};

function bashOutput(item: ToolItem, view: BashView): string {
  // Streaming output arrives on `ToolItem.output` (append field "output"); the view carries the final text.
  const a = view.output ?? "";
  const b = item.output ?? "";
  return b.length > a.length ? b : a;
}

/** Pending call: "awaiting you" when it's the call an approval is gating, else queued. */
function PendingLabel() {
  const session = useContext(SessionCtx);
  const gated = useAgent(session?.key ?? "")?.needs?.kind === "approval";
  return gated ? (
    <span className="flex items-center gap-1.5 text-sun-1">
      <ShieldQuestion className="tf-loop size-3 animate-breathe [--tf-breath:1.6s]" />
      awaiting you
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-accent-hi">
      <Spinner size={12} label="queued" />
      queued
    </span>
  );
}

function StatusMeta({ item, extra, settled }: { item: ToolItem; extra?: ReactNode; settled: boolean }) {
  // Finished while on screen: the result icon pops in instead of just appearing.
  const pop = settled ? { initial: { scale: 0.2, opacity: 0 }, animate: { scale: 1, opacity: 1, transition: spring.bouncy } } : {};
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11.5px] font-semibold whitespace-nowrap text-mute tabular">
      {extra}
      {item.status === "pending" ? (
        <PendingLabel />
      ) : item.status === "running" ? (
        <span className="flex items-center gap-1.5 text-accent-hi">
          <Spinner size={12} label="running" />
          <Elapsed since={item.at} />
        </span>
      ) : item.status === "ok" ? (
        <span className="flex items-center gap-1">
          <motion.span className="grid" {...pop}>
            <CircleCheck className="size-3 text-done/80" />
          </motion.span>
          {item.durationMs != null && formatElapsed(item.durationMs)}
        </span>
      ) : item.status === "error" ? (
        <span className="flex items-center gap-1 text-error">
          <motion.span className="grid" {...pop}>
            <CircleX className="size-3" />
          </motion.span>
          failed
        </span>
      ) : item.status === "denied" ? (
        <span className="flex items-center gap-1 text-sun-2">
          <ShieldX className="size-3" />
          denied
        </span>
      ) : (
        <span className="flex items-center gap-1 text-mute-2">
          <Ban className="size-3" />
          aborted
        </span>
      )}
    </span>
  );
}

/** Header summary to the right of the title, per view. */
function summary(item: ToolItem): ReactNode {
  const v = item.view;
  if (!v) return null;
  switch (v.type) {
    case "diff": {
      const a = v.files.reduce((s, f) => s + f.added, 0);
      const r = v.files.reduce((s, f) => s + f.removed, 0);
      return (
        <>
          {v.files.length > 1 && <span>{v.files.length} files</span>}
          <DiffStatText added={a} removed={r} />
        </>
      );
    }
    case "bash":
      return (
        <>
          {v.background && <Chip className="h-5 px-1.5 text-[10px]">bg</Chip>}
          {v.timedOut && <span className="text-warn">timed out</span>}
          {v.exitCode != null && item.status !== "running" && item.status !== "pending" && (
            <span className={cn("font-mono", v.exitCode === 0 ? "text-done" : "text-error")}>exit {v.exitCode}</span>
          )}
        </>
      );
    case "read":
      return <span>{v.lines != null ? `${v.lines} lines` : v.range}</span>;
    case "search":
      return (
        <span>
          {v.matches} match{v.matches === 1 ? "" : "es"} · {v.files} file{v.files === 1 ? "" : "s"}
        </span>
      );
    case "todo": {
      const c = todoCounts(v.phases);
      return (
        <span>
          {c.done}/{c.total}
        </span>
      );
    }
    case "task":
      return <TaskSummary agents={v.agents} />;
    case "web":
      return <span>{v.sources.length} source{v.sources.length === 1 ? "" : "s"}</span>;
    default:
      return null;
  }
}

function headTitle(item: ToolItem): ReactNode {
  const v = item.view;
  if (v?.type === "bash") return <Highlighted code={v.command.split("\n")[0] ?? ""} lang="sh" />;
  if (v?.type === "task") return <span className="font-sans">{v.agents.length} subagent{v.agents.length === 1 ? "" : "s"}</span>;
  return item.title;
}

/** Rich card for one tool call. Every `ToolView` has a renderer; anything else gets args/output. */
export function ToolCard({ item }: { item: ToolItem }) {
  const type: ViewType = item.view?.type ?? "generic";
  // The rich view often lands only when the call finishes: pick the icon from the tool name meanwhile.
  const kind: ViewType = type !== "generic" ? type : (TOOL_KIND.find(([re]) => re.test(item.tool))?.[1] ?? "generic");
  const [openState, setOpen] = useState<boolean | null>(null);
  const live = item.status === "running" || item.status === "pending";
  const failed = item.status === "error";
  // Remember a live → done transition seen on screen, to play the one-shot settle flash.
  const [wasLive, setWasLive] = useState(live);
  const [settled, setSettled] = useState(false);
  if (wasLive !== live) {
    setWasLive(live);
    if (!live) setSettled(true);
  }
  const open = openState ?? (OPEN_BY_DEFAULT[type] || failed);
  const Icon = ICON[kind];
  const hasBody = item.view != null || item.output != null || item.args != null || item.error != null;
  // While the pinned ask card under the transcript is open, its tool call is one line pointing there.
  const sessionKey = useContext(SessionCtx)?.key;
  const pinned = useSession(kind === "ask" && live && sessionKey ? sessionKey : "").ui;
  if (pinned && (pinned.callId == null || pinned.callId === item.callId) && openState === null)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        className="focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-[16px] bg-[rgb(10_10_16/0.5)] px-3 py-1.5 text-left shadow-[inset_0_0_0_1px_rgb(255_122_24/0.3)] hover:bg-white/[0.025] max-md:gap-2 max-md:px-2.5"
      >
        <span className={cn("grid size-[22px] shrink-0 place-items-center rounded-[8px]", TONE.ask)}>
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 font-mono text-[11.5px] font-semibold text-tool">{item.tool}</span>
        <span className="flex min-w-0 items-center gap-1 truncate text-[11.5px] font-semibold text-sun-1">
          · answering below
          <ArrowDown className="size-3 shrink-0" />
        </span>
        <ChevronDown className="ml-auto size-3.5 shrink-0 -rotate-90 text-mute-2" />
      </button>
    );
  return (
    <div
      data-status={live ? "running" : failed ? "error" : undefined}
      className={cn(
        "relative overflow-hidden rounded-[16px] bg-[rgb(10_10_16/0.5)] shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow duration-500",
        live && "shadow-[inset_0_0_0_1px_rgb(163_92_240/0.35),0_0_24px_-10px_rgb(163_92_240/0.6)]",
        failed && "shadow-[inset_0_0_0_1px_rgb(255_77_94/0.3)]",
      )}
    >
      {live && <span className="tf-loop live-gradient absolute inset-x-0 top-0 h-[2px]" aria-hidden />}
      {settled && (item.status === "ok" || failed) && (
        <span
          aria-hidden
          className={cn(
            "tf-keep pointer-events-none absolute inset-0 rounded-[16px] animate-[tf-flash_1.1s_ease-out_forwards]",
            failed
              ? "bg-error/[0.07] shadow-[inset_0_0_0_1.5px_rgb(255_77_94/0.75),inset_0_0_32px_-8px_rgb(255_77_94/0.5)]"
              : "bg-done/[0.05] shadow-[inset_0_0_0_1.5px_rgb(52_211_153/0.6),inset_0_0_32px_-8px_rgb(52_211_153/0.4)]",
          )}
        />
      )}
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        aria-expanded={hasBody ? open : undefined}
        className={cn("focus-ring flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left max-md:gap-2 max-md:px-2.5 max-md:py-1.5", hasBody ? "hover:bg-white/[0.025]" : "cursor-default")}
      >
        <span className={cn("grid size-[22px] shrink-0 place-items-center rounded-[8px] transition-colors duration-500", live ? "st-soft" : failed ? "bg-error/14 text-error" : TONE[kind])}>
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 font-mono text-[11.5px] font-semibold text-tool">{item.tool}</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-[#e2e2ea]" title={typeof item.title === "string" ? item.title : undefined}>
          {live && type === "generic" ? <Shimmer>{item.title}</Shimmer> : headTitle(item)}
        </span>
        <StatusMeta item={item} extra={summary(item)} settled={settled} />
        {hasBody && <ChevronDown className={cn("size-3.5 shrink-0 text-mute-2 transition-transform duration-300", !open && "-rotate-90")} />}
      </button>
      {item.intent && open && <div className="-mt-1 px-3 pb-1.5 pl-[46px] text-xs text-mute italic max-md:-mt-0.5 max-md:pl-10">{item.intent}</div>}
      {open && hasBody && (
        <div className="border-t border-line">
          <ToolBody item={item} />
          {item.error && <div className="border-t border-error/20 bg-error/[0.06] px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-[#ff9aab]">{item.error}</div>}
          {item.truncated && <div className="border-t border-line px-3 py-1 text-2xs font-semibold text-mute-2">Output truncated by omp</div>}
        </div>
      )}
    </div>
  );
}

function ToolBody({ item }: { item: ToolItem }) {
  const v = item.view;
  const live = item.status === "running";
  if (!v) return <GenericBody item={item} />;
  switch (v.type) {
    case "diff":
      return (
        <div>
          {v.files.map((f) => (
            <FileDiffView key={f.path} file={f} defaultOpen={v.files.length <= 3} />
          ))}
        </div>
      );
    case "bash": {
      const out = bashOutput(item, v);
      return (
        <div>
          {(v.command.includes("\n") || v.cwd) && (
            <div className="border-b border-line px-3 py-1.5 font-mono text-[11px] text-ink-2">
              {v.cwd && <div className="mb-0.5 text-2xs text-mute-2">in {v.cwd}</div>}
              {v.command.includes("\n") && (
                <pre className="whitespace-pre-wrap">
                  <Highlighted code={v.command} lang="sh" />
                </pre>
              )}
            </div>
          )}
          {out ? (
            <AnsiText text={out} follow={live} />
          ) : (
            <div className="px-3 py-2 font-mono text-[11px] text-mute-2">{live ? <Shimmer>waiting for output…</Shimmer> : "(no output)"}</div>
          )}
        </div>
      );
    }
    case "read":
      return (
        <div>
          <div className="flex items-center gap-2 px-3 pt-2 font-mono text-[11px] text-mute">
            <span className="truncate">{v.path}</span>
            {v.range && <span className="text-mute-2">:{v.range}</span>}
          </div>
          {v.preview ? <CodeBlock code={v.preview} lang={v.lang ?? languageFor(v.path) ?? "text"} className="mx-2 mb-2" maxHeight={300} /> : <div className="px-3 pb-2" />}
        </div>
      );
    case "search": {
      const groups = new Map<string, { line?: number; text?: string }[]>();
      for (const h of v.hits) {
        const g = groups.get(h.path) ?? [];
        g.push(h);
        groups.set(h.path, g);
      }
      return (
        <div className="max-h-[320px] overflow-y-auto py-1.5">
          <div className="px-3 pb-1 font-mono text-[11px] text-mute">
            <span className="text-mute-2">query</span> {v.query}
          </div>
          {[...groups].map(([path, hits]) => (
            <div key={path} className="px-3 py-1">
              <div className="truncate font-mono text-[11.5px] font-semibold text-ink-2">{path}</div>
              {hits.map(
                (h, i) =>
                  (h.text || h.line != null) && (
                    <div key={i} className="flex gap-2 font-mono text-[11px] leading-[1.6]">
                      <span className="w-10 shrink-0 text-right text-mute-2 tabular">{h.line}</span>
                      <span className="min-w-0 truncate text-mute">
                        <Highlighted code={h.text ?? ""} lang={languageFor(path)} />
                      </span>
                    </div>
                  ),
              )}
            </div>
          ))}
        </div>
      );
    }
    case "todo":
      return <TodoPhases phases={v.phases} className="px-3 py-2.5" />;
    case "task":
      return <TaskBody agents={v.agents} />;
    case "web":
      return (
        <div className="px-3 py-2">
          {v.query && (
            <div className="mb-1.5 font-mono text-[11px] text-mute">
              <span className="text-mute-2">query</span> {v.query}
            </div>
          )}
          {v.answer && <Markdown text={v.answer} className="mb-2 text-[12.5px]" />}
          <ol className="flex flex-col gap-1">
            {v.sources.map((s, i) => {
              let host = s.url;
              try {
                host = new URL(s.url).host.replace(/^www\./, "");
              } catch {
                /* keep the raw url */
              }
              const link = linkProps(s.url);
              const body = (
                <>
                  <span className="mt-px grid size-5 shrink-0 place-items-center rounded-[6px] bg-accent/15 font-mono text-[10px] font-bold text-accent-hi">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink">
                      <span className="truncate">{s.title || host}</span>
                      {link && <ExternalLink className="size-3 shrink-0 text-mute-2 opacity-0 transition-opacity group-hover/src:opacity-100" />}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] text-mute-2">{host}</span>
                    {s.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-mute">{s.snippet}</span>}
                  </span>
                </>
              );
              return (
                <li key={i}>
                  {link ? (
                    <a {...link} className="group/src focus-ring pressable flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
                      {body}
                    </a>
                  ) : (
                    // Non-http(s) source: shown, never followable.
                    <div className="flex items-start gap-2.5 px-2 py-1.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      );
    case "image":
      return <ImageBody view={v} title={item.title} />;
    case "ask":
      return (
        <div className="flex flex-col gap-3 px-3 py-2.5">
          {v.questions.map((q, i) =>
            q.answer == null && item.status === "running" ? (
              // The sunset card under the transcript carries the options; don't repeat them here.
              <div key={i} className="flex flex-wrap items-center gap-2">
                {q.question !== item.title && <span className="min-w-0 text-[13px] font-bold text-ink">{q.question}</span>}
                <span className="inline-flex items-center gap-1.5 rounded-full bg-sun-1/12 px-2.5 py-1 text-[11.5px] font-bold text-sun-1 shadow-[inset_0_0_0_1px_rgb(255_122_24/0.3)]">
                  <ArrowDown className="tf-loop size-3 animate-bounce" />
                  Answer in the card below · {q.options.length} option{q.options.length === 1 ? "" : "s"}
                </span>
              </div>
            ) : (
              <div key={i}>
                <div className="text-[13px] font-bold text-ink">{q.question}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {q.options.map((o) => {
                    const chosen = q.answer != null && (q.answer === o || q.answer.split(/\s*,\s*/).includes(o));
                    return (
                      <span
                        key={o}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-semibold",
                          chosen ? "bg-sun text-white shadow-glow-sun" : "bg-white/5 text-mute shadow-hairline",
                        )}
                      >
                        {chosen && "✓ "}
                        {o}
                      </span>
                    );
                  })}
                </div>
                {q.answer != null && !q.options.some((o) => q.answer === o || q.answer?.split(/\s*,\s*/).includes(o)) && (
                  <div className="mt-1.5 rounded-md bg-white/[0.04] px-2.5 py-1.5 text-xs text-ink-2 shadow-hairline">
                    <span className="kicker mr-2">answer</span>
                    {q.answer}
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      );
    case "markdown":
      return <Markdown text={v.text} streaming={live} className="px-3 py-2.5 text-[12.5px]" />;
    // Transcript rows render IRC as chat bubbles (../irc/IrcBubble); this is the bare card body.
    case "irc":
      return <Markdown text={v.text} className="px-3 py-2.5 text-[12.5px]" />;
  }
}

/** Max thumbnail height (px) of an image tool view. */
const IMAGE_MAX_H = 420;

function ImageBody({ view: v, title }: { view: ImageView; title: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const images = useMemo(() => [v.image], [v.image]);
  const [source] = useImageSources(images);
  const src = source?.state === "ready" ? source.src : undefined;
  const urlLink = linkProps(v.url);
  const alt = v.alt ?? title;
  const { width: w, height: h } = v.image;
  // The trigger button shrink-wraps the image, so it needs a definite width: from the reported size
  // (scaled down to the height cap) when known; otherwise the button spans the card and the image fills it
  // (an SVG with only a viewBox has no intrinsic width to shrink-wrap).
  const thumbWidth = w && h ? Math.min(w, (IMAGE_MAX_H * w) / h) : undefined;
  return (
    <figure className="p-2">
      {src ? (
        <>
          <LightboxTrigger className={thumbWidth ? "inline-block max-w-full align-top" : "w-full"} onClick={() => setOpen(0)}>
            <img
              src={src}
              alt={alt}
              width={w}
              height={h}
              loading="lazy"
              style={{ width: thumbWidth, maxHeight: IMAGE_MAX_H }}
              className={cn("max-w-full rounded-md bg-bg-deep object-contain shadow-hairline", thumbWidth ? "h-auto" : "w-auto")}
            />
          </LightboxTrigger>
          <Lightbox images={[{ src, alt, width: w, height: h }]} index={open} onIndexChange={setOpen} />
        </>
      ) : (
        <ImagePlaceholder state={source?.state === "loading" ? "loading" : "unavailable"} />
      )}
      {(v.url || v.alt) && (
        <figcaption className="mt-1.5 flex items-center gap-2 px-1 text-2xs text-mute">
          {v.alt && <span className="truncate">{v.alt}</span>}
          {v.url &&
            (urlLink ? (
              <a {...urlLink} className="truncate font-mono text-accent-hi hover:underline">
                {v.url}
              </a>
            ) : (
              <span className="truncate font-mono">{v.url}</span>
            ))}
        </figcaption>
      )}
    </figure>
  );
}

/** A task card's subagents with the session's roster laid over those it still shows running (`withRoster`). */
function useRosterAgents(agents: Subagent[]): Subagent[] {
  const key = useContext(SessionCtx)?.key;
  // Only cards with a running agent subscribe (the roster changes with every progress update).
  const watch = key != null && agents.some((a) => a.status === "running") ? key : undefined;
  const roster = useCore((s) => (watch != null ? s.sessions[watch]?.meta?.subagents : undefined));
  return useMemo(() => withRoster(agents, roster), [agents, roster]);
}

function TaskSummary({ agents: card }: { agents: Subagent[] }) {
  const agents = useRosterAgents(card);
  const live = agents.filter((a) => a.status === "running").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const estimates = agents.flatMap((a) => (a.status === "running" && a.completionPct != null ? [a.completionPct] : []));
  const done = estimates.length > 0 ? Math.round(estimates.reduce((s, p) => s + p, 0) / estimates.length) : undefined;
  return live > 0 ? (
    <span className="text-accent-hi" title={done != null ? "The running subagents' own estimate of how far along their task is (omp asks every few minutes)" : undefined}>
      {live} live{done != null && ` · ${estimates.length > 1 ? "~" : ""}${done}% done`}
    </span>
  ) : failed > 0 ? (
    <span className="text-error">{failed} failed</span>
  ) : (
    <span className="text-done">✓ all done</span>
  );
}

function TaskBody({ agents: card }: { agents: Subagent[] }) {
  const { key } = useSessionRef();
  const agents = useRosterAgents(card);
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {agents.map((a) => (
        <SubagentCard key={a.id} sub={a} onOpen={() => useSessionUi.getState().openSubagent(key, a.id, agents)} />
      ))}
    </div>
  );
}

function GenericBody({ item }: { item: ToolItem }) {
  const args = item.args == null ? "" : typeof item.args === "string" ? item.args : JSON.stringify(item.args, null, 2);
  return (
    <div>
      {args && args !== "{}" && (
        <div className="px-1">
          <div className="kicker px-2 pt-2">args</div>
          <CodeBlock code={args} lang="json" className="mx-1 mt-1 mb-2" maxHeight={260} />
        </div>
      )}
      {item.output != null && item.output !== "" && (
        <div className="border-t border-line">
          <div className="kicker px-3 pt-2">output</div>
          <AnsiText text={item.output} follow={item.status === "running"} />
        </div>
      )}
      {!args && !item.output && !item.error && <div className="px-3 py-2 text-2xs text-mute-2">No details</div>}
    </div>
  );
}
