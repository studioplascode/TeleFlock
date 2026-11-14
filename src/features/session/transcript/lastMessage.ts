import type { TranscriptItem } from "@/core/gen";

/** The row the transcript's "last message" pill jumps to. */
export interface LastMessage {
  id: string;
  /** `assistant`: the agent's text; `user`: a prompt (the user's, or a subagent's task). */
  kind: "assistant" | "user";
}

/**
 * The newest message of a transcript, met going up from the bottom: the agent's last text or the
 * last prompt, whichever comes first. Thinking, tool calls, notices, compactions, mode and IRC rows
 * are passed over, and so are rows that are no message to read from its start: a text row without
 * text (streaming hasn't brought any yet, or only an error: a failed attempt, a provider limit) and
 * omp's system turns (todo reminders, async results).
 */
export function lastMessage(ids: readonly string[], itemOf: (id: string) => TranscriptItem | undefined): LastMessage | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i] as string;
    const item = itemOf(id);
    if (item?.kind === "assistant" && /\S/.test(item.text)) return { id, kind: "assistant" };
    if (item?.kind === "user" && !item.synthetic) return { id, kind: "user" };
  }
  return null;
}

export const sameLastMessage = (a: LastMessage | null, b: LastMessage | null): boolean => a?.id === b?.id && a?.kind === b?.kind;
