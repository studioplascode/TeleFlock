import { useMemo } from "react";
import { needleOf } from "./match";
import type { TranscriptFind } from "./painter";
import { useFind } from "./store";

/** What a transcript of `scope` paints while Find is open there (`undefined` while closed or empty). */
export function useTranscriptFind(scope: string): TranscriptFind | undefined {
  const open = useFind(scope, (s) => s.open);
  const query = useFind(scope, (s) => s.query);
  const caseSensitive = useFind(scope, (s) => s.caseSensitive);
  const active = useFind(scope, (s) => s.active);
  const nonce = useFind(scope, (s) => s.nonce);
  const rows = useFind(scope, (s) => s.rows);
  const needle = useMemo(() => (open ? needleOf(query, caseSensitive) : null), [open, query, caseSensitive]);
  return useMemo(() => (needle ? { needle, active, nonce, rows } : undefined), [needle, active, nonce, rows]);
}
