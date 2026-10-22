import { Keyboard } from "lucide-react";
import { motion } from "motion/react";
import { Dialog, DialogContent, Kbd, spring } from "@/design";
import { useUi } from "@/core";
import { GLOSSARY } from "./glossary";
import { SHORTCUTS } from "./keyboard";

/** The `?` sheet: every keyboard shortcut, grouped, then the glossary. Rendered when `useUi().dialog.kind === "shortcuts"`. */
export function ShortcutsSheet() {
  const { dialog, closeDialog } = useUi();
  const open = dialog?.kind === "shortcuts";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent title="Keyboard shortcuts" description="Keyboard-first: everything is a keystroke away. The words TeleFlock uses are explained at the end." icon={<Keyboard />} width={760}>
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
                  <li key={s.label} className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1 text-sm text-ink-2 last:border-0">
                    <span>{s.label}</span>
                    <span className="flex shrink-0 gap-1">
                      {s.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.section>
          ))}
          <motion.section
            className="sm:col-span-2"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.smooth, delay: SHORTCUTS.length * 0.05 }}
          >
            <h3 className="kicker mb-2">Terms</h3>
            <dl className="grid gap-x-8 sm:grid-cols-2">
              {Object.values(GLOSSARY).map((t) => (
                <div key={t.term} className="border-b border-line py-2 text-sm">
                  <dt className="font-bold text-ink">{t.term}</dt>
                  <dd className="text-xs text-mute">{t.text}</dd>
                </div>
              ))}
            </dl>
          </motion.section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
