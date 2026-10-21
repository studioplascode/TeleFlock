import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { useAgent, useSettings } from "@/core";
import { Button, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, spring } from "@/design";
import { setArchived } from "./agentActions";

/** `Settings.confirmArchive`: archiving asks first (cards, drops, the selection bar). */
export function useConfirmArchive(): boolean {
  return useSettings((s) => s.confirmArchive);
}

function ConfirmBody({ title, onConfirm, onCancel }: { title: ReactNode; onConfirm(): void; onCancel(): void }) {
  return (
    <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.bouncy} className="flex w-60 flex-col gap-3 p-1">
      <div>
        <p className="text-sm font-bold text-ink">{title}</p>
        <p className="mt-0.5 text-xs text-mute">It moves to Done. You can drag it back any time.</p>
      </div>
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" autoFocus onClick={onConfirm}>
          Archive
        </Button>
      </div>
    </motion.div>
  );
}

/** Card "Archive" action: archives straight away, or asks in a popover when confirmArchive is on. */
export function ArchiveButton({ agentKey, className, children }: { agentKey: string; className?: string; children: ReactNode }) {
  const confirm = useConfirmArchive();
  const name = useAgent(agentKey)?.name ?? "this agent";
  const [open, setOpen] = useState(false);
  const archive = () => void setArchived(agentKey, true).catch(() => {});
  if (!confirm)
    return (
      <button type="button" className={className} onClick={archive}>
        {children}
      </button>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={className}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <ConfirmBody
          title={`Archive ${name}?`}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            setOpen(false);
            archive();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export interface PendingDrop {
  key: string;
  name: string;
  /** Viewport point of the drop. */
  x: number;
  y: number;
}

/** Confirm popover anchored where a card was dropped into Done. */
export function DropConfirm({ pending, onResolve }: { pending: PendingDrop | null; onResolve(ok: boolean): void }) {
  return (
    <Popover open={pending !== null} onOpenChange={(o) => !o && onResolve(false)}>
      <PopoverAnchor asChild>
        <span aria-hidden className="pointer-events-none fixed size-px" style={{ left: pending?.x ?? 0, top: pending?.y ?? 0 }} />
      </PopoverAnchor>
      <PopoverContent side="bottom" align="center">
        {pending && <ConfirmBody title={`Archive ${pending.name}?`} onCancel={() => onResolve(false)} onConfirm={() => onResolve(true)} />}
      </PopoverContent>
    </Popover>
  );
}
