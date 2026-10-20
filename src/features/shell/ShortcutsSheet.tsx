import { Keyboard } from "lucide-react";
import { motion } from "motion/react";
import { Dialog, DialogContent, Kbd, spring } from "@/design";
import { useUi } from "@/core";
import { SHORTCUTS } from "./keyboard";

/** The `?` sheet: every keyboard shortcut, grouped. Rendered when `useUi().dialog.kind === "shortcuts"`. */
export function ShortcutsSheet() {
  const { dialog, closeDialog } = useUi();
  const open = dialog?.kind === "shortcuts";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent title="Keyboard shortcuts" description="Keyboard-first: everything is a keystroke away." icon={<Keyboard />} width={720}>
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          {SHORTCUTS.map((group, gi) => (
            <motion.section
              key={group.title}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring.smooth, delay: gi * 0.05 }}
            >
              <h3 className="kicker mb-2">{group.title}</h3>
              <ul className="flex flex-col">
                {group.items.map((s) => (
                  <li key={s.label} className="flex h-9 items-center justify-between gap-3 border-b border-line text-sm text-ink-2 last:border-0">
                    <span>{s.label}</span>
                    <span className="flex gap-1">
                      {s.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
