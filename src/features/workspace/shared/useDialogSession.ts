import { useState } from "react";
import { type UiDialog, useUi } from "@/core";

type DialogOf<K extends UiDialog["kind"]> = Extract<UiDialog, { kind: K }>;

/**
 * Binds a dialog component to `useUi().dialog`. While the dialog is closing, the last payload is
 * kept so exit animations can play; `gen` increments on every fresh open (key the body on it to
 * reset its state).
 */
export function useDialogSession<K extends UiDialog["kind"]>(kind: K): { open: boolean; payload: DialogOf<K> | null; gen: number; close: () => void } {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  const open = dialog?.kind === kind;
  const [last, setLast] = useState<{ d: DialogOf<K> | null; gen: number }>({ d: null, gen: 0 });
  if (open && dialog !== last.d) setLast({ d: dialog as DialogOf<K>, gen: last.gen + 1 });
  return { open, payload: open ? (dialog as DialogOf<K>) : last.d, gen: last.gen, close };
}
