import type { ToolItem, TranscriptItem } from "@/core/gen";
import { stripAnsi } from "../lib/ansi";
import { countIn, type Needle } from "./match";

/**
 * What Find in a session searches in a transcript row: the text its card shows (prompt and reply
 * text, thinking, tool titles, arguments, outputs without ANSI escapes, errors, the fields of a
 * tool's rich view). tf-hostd's `find/rows.rs` lists the same fields for the rows the client has
 * not loaded. Matches never span two texts. The tool's name and the cards' chrome (author, time,
 * model, status) are not searched. Views still arriving may lack fields: every field is optional
 * here.
 */
export function rowTexts(item: TranscriptItem): string[] {
  const cached = textCache.get(item);
  if (cached) return cached;
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s) out.push(s);
  };
  switch (item.kind) {
    case "user":
      add(item.text);
      break;
    case "assistant":
      add(item.text);
      add(item.error);
      add(item.refusal?.category);
      add(item.refusal?.explanation);
      break;
    case "thinking":
      if (!item.redacted) add(item.text);
      break;
    case "tool":
      toolTexts(item, add);
      break;
    case "notice":
      add(item.text);
      add(item.source);
      break;
    case "compaction":
      add(item.summary);
      break;
    case "mode":
      add(item.text);
      break;
    case "irc":
      add(item.message?.peer);
      add(item.message?.text);
      break;
  }
  textCache.set(item, out);
  return out;
}

const textCache = new WeakMap<TranscriptItem, string[]>();

function toolTexts(t: ToolItem, add: (s: string | null | undefined) => void): void {
  const v = t.view;
  // The header shows the title, except bash (the command's first line) and task (a count) cards.
  if (v?.type !== "bash" && v?.type !== "task") add(t.title);
  add(t.intent);
  if (!v) {
    // The generic card: pretty-printed arguments, then the output.
    const args = t.args == null ? "" : typeof t.args === "string" ? t.args : JSON.stringify(t.args, null, 2);
    if (args !== "{}") add(args);
    if (t.output) add(stripAnsi(t.output));
  } else
    switch (v.type) {
      case "diff":
        for (const f of v.files ?? []) {
          add(f.path);
          add(f.patch);
        }
        break;
      case "bash": {
        const command = v.command ?? "";
        add(command.split("\n")[0]);
        // A multi-line command is shown whole under the header too.
        if (command.includes("\n")) add(command);
        add(v.cwd);
        // Streaming output arrives on the item; the view carries the final text.
        const view = v.output ?? "";
        const out = (t.output?.length ?? 0) > view.length ? (t.output ?? "") : view;
        if (out) add(stripAnsi(out));
        break;
      }
      case "read":
        add(v.path);
        add(v.range);
        add(v.preview);
        break;
      case "search":
        add(v.query);
        for (const h of v.hits ?? []) {
          add(h.path);
          add(h.text);
        }
        break;
      case "todo":
        for (const p of v.phases ?? []) {
          add(p.name);
          for (const task of p.tasks ?? []) {
            add(task.content);
            add(task.blocker);
          }
        }
        break;
      case "task":
        for (const a of v.agents ?? []) {
          add(a.name);
          add(a.description);
          add(a.line);
        }
        break;
      case "web":
        add(v.query);
        add(v.answer);
        for (const s of v.sources ?? []) {
          add(s.title);
          add(s.url);
          add(s.snippet);
        }
        break;
      case "image":
        add(v.alt);
        add(v.url);
        break;
      case "ask":
        for (const q of v.questions ?? []) {
          add(q.question);
          for (const o of q.options ?? []) add(o);
          add(q.answer);
        }
        break;
      case "markdown":
        add(v.text);
        break;
      case "irc":
        add(v.peer);
        add(v.text);
        break;
    }
  add(t.error);
}

const countCache = new WeakMap<TranscriptItem, { key: string; count: number }>();

/** Occurrences of `n` in the row's searchable text (memoised per row object and needle). */
export function rowCount(item: TranscriptItem, n: Needle): number {
  const key = `${n.caseSensitive ? "1" : "0"}${n.text}`;
  const hit = countCache.get(item);
  if (hit && hit.key === key) return hit.count;
  let count = 0;
  for (const t of rowTexts(item)) count += countIn(t, n);
  countCache.set(item, { key, count });
  return count;
}

/** Whether `text` holds the needle (for nested parts of a row that open on their own). */
export function holds(text: string | null | undefined, n: Needle | null): boolean {
  return n != null && !!text && countIn(text, n, 1) > 0;
}
