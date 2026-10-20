import { type ReactNode, useState } from "react";
import { cn } from "../lib/cn";

const MAX_LIVE_CHUNKS = 8;

interface Chunk {
  key: number;
  text: string;
}

interface StreamState {
  source: string;
  settled: string;
  chunks: Chunk[];
  nextKey: number;
}

export interface StreamTextProps {
  /** Full text so far. Appending fades the new tail in; any non-append change re-renders plainly. */
  text: string;
  /** Show the caret while tokens are still arriving. */
  streaming?: boolean;
  className?: string;
}

/** Streaming assistant text: each new token chunk fades in from purple, with a glowing caret. */
export function StreamText({ text, streaming = false, className }: StreamTextProps) {
  const [state, setState] = useState<StreamState>({ source: text, settled: text, chunks: [], nextKey: 0 });
  if (text !== state.source) {
    // Adjust state during render (React's sanctioned pattern for deriving from changed props).
    if (text.startsWith(state.source)) {
      const chunks = [...state.chunks, { key: state.nextKey, text: text.slice(state.source.length) }];
      let settled = state.settled;
      while (chunks.length > MAX_LIVE_CHUNKS) settled += chunks.shift()?.text ?? "";
      setState({ source: text, settled, chunks, nextKey: state.nextKey + 1 });
    } else {
      setState({ source: text, settled: text, chunks: [], nextKey: state.nextKey + 1 });
    }
  }
  return (
    <span className={cn("whitespace-pre-wrap", className)} aria-live={streaming ? "polite" : undefined}>
      {state.settled}
      {state.chunks.map((c) => (
        <span key={c.key} className="tf-token">
          {c.text}
        </span>
      ))}
      {streaming && <Caret />}
    </span>
  );
}

/** Glowing block caret. */
export function Caret({ className }: { className?: string }) {
  return <span className={cn("tf-caret tf-loop", className)} aria-hidden />;
}

/** Shimmering label for in-progress states ("Thinking…", "Running bash…"). */
export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("tf-shimmer-text tf-loop", className)}>{children}</span>;
}
