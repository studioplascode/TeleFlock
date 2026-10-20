import {
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
  NotebookText,
  Search,
  ShieldX,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { BashView, ImageRef, Subagent, ToolItem, ToolView } from "@/core/gen";
import { Chip, cn, Elapsed, formatElapsed, Shimmer, Spinner } from "@/design";
import { languageFor } from "../lib/highlight";
import { CodeBlock, Highlighted, Markdown } from "../markdown/Markdown";
import { SubagentCard, SubagentDialog } from "../subagents/Subagents";
import { useSessionRef } from "../context";
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
  generic: Wrench,
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
  generic: false,
};

export function imageSrc(img: ImageRef): string | undefined {
  return img.data ? `data:${img.mime};base64,${img.data}` : img.url;
}

function bashOutput(item: ToolItem, view: BashView): string {
  // Streaming output arrives on `ToolItem.output` (append field "output"); the view carries the final text.
  const a = view.output ?? "";
  const b = item.output ?? "";
  return b.length > a.length ? b : a;
}

function StatusMeta({ item, extra }: { item: ToolItem; extra?: ReactNode }) {
  const live = item.status === "running" || item.status === "pending";
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-[11.5px] font-semibold whitespace-nowrap text-mute tabular">
      {extra}
      {live ? (
        <span className="flex items-center gap-1.5 text-accent-hi">
          <Spinner size={12} label="running" />
          {item.status === "pending" ? "queued" : <Elapsed since={item.at} />}
        </span>
      ) : item.status === "ok" ? (
        <span className="flex items-center gap-1">
          <CircleCheck className="size-3 text-done/80" />
          {item.durationMs != null && formatElapsed(item.durationMs)}
        </span>
      ) : item.status === "error" ? (
        <span className="flex items-center gap-1 text-error">
          <CircleX className="size-3" />
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
          {v.exitCode != null && <span className={cn("font-mono", v.exitCode === 0 ? "text-done" : "text-error")}>exit {v.exitCode}</span>}
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
    case "task": {
      const live = v.agents.filter((a) => a.status === "running").length;
      const failed = v.agents.filter((a) => a.status === "failed").length;
      return live > 0 ? (
        <span className="text-accent-hi">{live} live</span>
      ) : failed > 0 ? (
        <span className="text-error">{failed} failed</span>
      ) : (
        <span className="text-done">✓ all done</span>
      );
    }
    case "web":
      return <span>{v.sources.length} sources</span>;
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
  const [openState, setOpen] = useState<boolean | null>(null);
  const live = item.status === "running" || item.status === "pending";
  const failed = item.status === "error";
  const open = openState ?? (OPEN_BY_DEFAULT[type] || failed);
  const Icon = ICON[type];
  const hasBody = item.view != null || item.output != null || item.args != null || item.error != null;
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
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        aria-expanded={hasBody ? open : undefined}
        className={cn("focus-ring flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left", hasBody && "hover:bg-white/[0.025]")}
      >
        <span className={cn("grid size-[22px] shrink-0 place-items-center rounded-[8px] bg-white/6 text-mute", live && "st-soft")}>
          <Icon className="size-3" />
        </span>
        <span className="shrink-0 font-mono text-[11.5px] font-semibold text-tool">{item.tool}</span>
        <span className="min-w-0 truncate font-mono text-[11.5px] text-[#e2e2ea]" title={typeof item.title === "string" ? item.title : undefined}>
          {live && type === "generic" ? <Shimmer>{item.title}</Shimmer> : headTitle(item)}
        </span>
        <StatusMeta item={item} extra={summary(item)} />
        {hasBody && <ChevronDown className={cn("size-3.5 shrink-0 text-mute-2 transition-transform duration-300", !open && "-rotate-90")} />}
      </button>
      {item.intent && open && <div className="-mt-1 px-3 pb-1.5 pl-[46px] text-xs text-mute italic">{item.intent}</div>}
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
              return (
                <li key={i}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="group/src focus-ring pressable flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/[0.04]"
                  >
                    <span className="mt-px grid size-5 shrink-0 place-items-center rounded-[6px] bg-accent/15 font-mono text-[10px] font-bold text-accent-hi">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink">
                        <span className="truncate">{s.title || host}</span>
                        <ExternalLink className="size-3 shrink-0 text-mute-2 opacity-0 transition-opacity group-hover/src:opacity-100" />
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-mute-2">{host}</span>
                      {s.snippet && <span className="mt-0.5 line-clamp-2 block text-xs text-mute">{s.snippet}</span>}
                    </span>
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      );
    case "image": {
      const src = imageSrc(v.image);
      return (
        <figure className="p-2">
          {src ? (
            <img
              src={src}
              alt={v.alt ?? item.title}
              width={v.image.width}
              height={v.image.height}
              loading="lazy"
              className="max-h-[420px] w-auto max-w-full rounded-md bg-bg-deep object-contain shadow-hairline"
            />
          ) : (
            <div className="px-1 py-2 text-xs text-mute-2">Image not available</div>
          )}
          {(v.url || v.alt) && (
            <figcaption className="mt-1.5 flex items-center gap-2 px-1 text-2xs text-mute">
              {v.alt && <span className="truncate">{v.alt}</span>}
              {v.url && (
                <a href={v.url} target="_blank" rel="noreferrer noopener" className="truncate font-mono text-accent-hi hover:underline">
                  {v.url}
                </a>
              )}
            </figcaption>
          )}
        </figure>
      );
    }
    case "ask":
      return (
        <div className="flex flex-col gap-3 px-3 py-2.5">
          {v.questions.map((q, i) => (
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
              {q.answer == null && item.status === "running" && <Shimmer className="mt-1.5 block text-xs">Waiting for your answer…</Shimmer>}
            </div>
          ))}
        </div>
      );
    case "markdown":
      return <Markdown text={v.text} streaming={live} className="px-3 py-2.5 text-[12.5px]" />;
  }
}

function TaskBody({ agents }: { agents: Subagent[] }) {
  const { key } = useSessionRef();
  const [openId, setOpenId] = useState<string | null>(null);
  const sub = agents.find((a) => a.id === openId);
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {agents.map((a) => (
        <SubagentCard key={a.id} sub={a} onOpen={() => setOpenId(a.id)} />
      ))}
      <SubagentDialog agentKey={key} sub={sub} open={sub != null} onOpenChange={(o) => !o && setOpenId(null)} />
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
