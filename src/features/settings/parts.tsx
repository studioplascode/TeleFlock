import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { cn, fadeRise, Input, spring, Tile } from "@/design";
import { core, useHostIds, useHosts } from "@/core";
import type { ModelInfo, ThinkingLevel } from "@/core/gen";

export const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/** A settings card: icon, title, description and divided rows. */
export function Section({ icon, title, description, children, index, action }: { icon: ReactNode; title: string; description?: string; children: ReactNode; index: number; action?: ReactNode }) {
  return (
    <motion.section {...fadeRise} transition={{ ...spring.smooth, delay: index * 0.05 }}>
      <Tile className="p-5">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent/16 text-accent-hi [&_svg]:size-4">{icon}</span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-bold">{title}</h2>
            {description && <p className="text-xs text-mute">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        <div className="flex flex-col divide-y divide-line">{children}</div>
      </Tile>
    </motion.section>
  );
}

/** One setting. `wide` controls (segmented, selects, text) take the full row on phones. */
export function Row({ label, description, children, htmlFor, wide }: { label: string; description?: ReactNode; children: ReactNode; htmlFor?: string; wide?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-1 last:pb-1">
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor={htmlFor} className="block text-sm font-bold text-ink">
          {label}
        </label>
        {description && <div className="text-xs text-mute">{description}</div>}
      </div>
      <div className={cn("flex shrink-0 items-center gap-2", wide && "max-md:w-full max-md:[&>*]:w-full")}>{children}</div>
    </div>
  );
}

/** Text setting committed on blur / Enter (not per keystroke). */
export function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void; id?: string; placeholder?: string; type?: string; className?: string; "aria-label"?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/** Models of the active host (the host filter, else the first online host) from `host.models`. */
export function useModels(): ModelInfo[] {
  const ids = useHostIds();
  const { status, filter } = useHosts();
  const online = filter !== "all" && status[filter]?.phase === "online" ? filter : ids.find((id) => status[id]?.phase === "online");
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    if (!online) return;
    let live = true;
    core
      .host(online)
      .call("host.models", {})
      .then(
        (c) => live && setModels(c.models),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [online]);
  return models;
}
