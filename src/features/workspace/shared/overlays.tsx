import { AlertTriangle, PencilLine } from "lucide-react";
import { type ReactNode, useState } from "react";
import { create } from "zustand";
import { useDraft } from "@/core";
import { Button, Input } from "@/design";
import { ResponsiveDialog } from "./ResponsiveDialog";

/*
 * Imperative confirm / text-prompt overlays, so plain action functions (sidebar menu, palette)
 * can ask the user without owning any UI. `OpsOverlayHost` renders them; NewAgentDialog mounts it.
 */

interface ConfirmRequest {
  id: number;
  type: "confirm";
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface PromptRequest {
  id: number;
  type: "prompt";
  title: string;
  body?: ReactNode;
  label: string;
  initial: string;
  /** Draft key the typed text persists under until the caller clears it (after its action succeeds). */
  draftKey: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
}

type OverlayRequest = ConfirmRequest | PromptRequest;

const useOverlays = create<{ current: OverlayRequest | null; queue: OverlayRequest[] }>()(() => ({ current: null, queue: [] }));
let nextId = 1;

// Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
function enqueue(req: OverlayRequest) {
  useOverlays.setState((s) => (s.current ? { queue: [...s.queue, req] } : { current: req }));
}

function settle() {
  useOverlays.setState((s) => ({ current: s.queue[0] ?? null, queue: s.queue.slice(1) }));
}

export function confirmAction(opts: { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => enqueue({ id: nextId++, type: "confirm", confirmLabel: opts.confirmLabel ?? "Confirm", ...opts, resolve }));
}

export function promptText(opts: {
  title: string;
  body?: ReactNode;
  label: string;
  initial?: string;
  /** Where the typed text persists (`draftKey(...)` with the edited item's identity); clear it once the action succeeded. */
  draftKey: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) =>
    enqueue({ id: nextId++, type: "prompt", initial: opts.initial ?? "", confirmLabel: opts.confirmLabel ?? "Save", ...opts, resolve }),
  );
}

export function OpsOverlayHost() {
  const current = useOverlays((s) => s.current);
  if (!current) return null;
  return current.type === "confirm" ? <ConfirmOverlay key={current.id} req={current} /> : <PromptOverlay key={current.id} req={current} />;
}

function ConfirmOverlay({ req }: { req: ConfirmRequest }) {
  const finish = (ok: boolean) => {
    req.resolve(ok);
    settle();
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && finish(false)}
      title={req.title}
      icon={req.danger ? <AlertTriangle /> : undefined}
      width={460}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button variant={req.danger ? "danger" : "primary"} onClick={() => finish(true)} autoFocus>
            {req.confirmLabel}
          </Button>
        </div>
      }
    >
      {req.body && <div className="text-sm leading-relaxed text-ink-2">{req.body}</div>}
    </ResponsiveDialog>
  );
}

function PromptOverlay({ req }: { req: PromptRequest }) {
  const [value, setValue] = useDraft(req.draftKey, req.initial);
  const [touched, setTouched] = useState(false);
  const error = req.validate?.(value) ?? (value.trim() ? null : `${req.label} can't be empty`);
  const finish = (v: string | null) => {
    req.resolve(v);
    settle();
  };
  const submit = () => {
    setTouched(true);
    if (!error) finish(value.trim());
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && finish(null)}
      title={req.title}
      icon={<PencilLine />}
      width={460}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={touched && !!error}>
            {req.confirmLabel}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {req.body && <div className="text-sm text-mute">{req.body}</div>}
        <label className="text-2xs font-bold tracking-[0.02em] text-mute" htmlFor="ops-prompt">
          {req.label}
        </label>
        <Input
          id="ops-prompt"
          autoFocus
          value={value}
          invalid={touched && !!error}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        {touched && error && <p className="text-xs font-semibold text-error">{error}</p>}
      </form>
    </ResponsiveDialog>
  );
}
