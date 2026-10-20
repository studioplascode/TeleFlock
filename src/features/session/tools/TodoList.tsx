import { Check, Minus, OctagonAlert } from "lucide-react";
import type { TodoPhase, TodoStatus } from "@/core/gen";
import { cn } from "@/design";

export function todoCounts(phases: readonly TodoPhase[]): { done: number; total: number; blocked: number } {
  let done = 0;
  let total = 0;
  let blocked = 0;
  for (const p of phases)
    for (const t of p.tasks) {
      if (t.status === "abandoned") continue;
      total++;
      if (t.status === "completed") done++;
      if (t.status === "blocked") blocked++;
    }
  return { done, total, blocked };
}

function TodoMark({ status }: { status: TodoStatus }) {
  switch (status) {
    case "completed":
      return (
        <span className="grid size-[15px] shrink-0 place-items-center rounded-full bg-done/20 text-done">
          <Check className="size-2.5" strokeWidth={3.5} />
        </span>
      );
    case "inProgress":
      return (
        <span className="relative grid size-[15px] shrink-0 place-items-center" aria-label="in progress">
          <span className="tf-loop absolute inset-0 animate-spin-slow rounded-full [background:conic-gradient(var(--color-accent)_0_40%,rgb(255_255_255/0.1)_0)] shadow-[0_0_10px_rgb(163_92_240/0.55)]" />
          <span className="absolute inset-[3px] rounded-full bg-tile-1" />
        </span>
      );
    case "blocked":
      return <OctagonAlert className="size-[15px] shrink-0 text-sun-1" aria-label="blocked" />;
    case "abandoned":
      return (
        <span className="grid size-[15px] shrink-0 place-items-center rounded-full bg-white/5 text-mute-2">
          <Minus className="size-2.5" />
        </span>
      );
    default:
      return <span className="block size-[15px] shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--color-mute-2)]" aria-label="pending" />;
  }
}

/** Phase checklist (tool card + inspector). */
export function TodoPhases({ phases, className }: { phases: readonly TodoPhase[]; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {phases.map((p, pi) => {
        const c = todoCounts([p]);
        const active = p.tasks.some((t) => t.status === "inProgress");
        return (
          <div key={pi}>
            <div className="mb-1 flex items-center gap-2">
              <span className={cn("kicker", active && "text-accent-hi")}>{p.name}</span>
              <span className="ml-auto font-mono text-2xs text-mute-2 tabular">
                {c.done}/{c.total}
              </span>
            </div>
            <ul className="flex flex-col gap-[3px]">
              {p.tasks.map((t, ti) => (
                <li
                  key={ti}
                  className={cn(
                    "flex items-start gap-2 text-[12.5px] leading-[1.35]",
                    t.status === "completed" && "text-mute",
                    t.status === "inProgress" && "font-bold text-[#e9dcff]",
                    t.status === "abandoned" && "text-mute-2 line-through",
                    t.status === "blocked" && "text-[#ffc29a]",
                    t.status === "pending" && "text-ink-2",
                  )}
                >
                  <span className="mt-px">
                    <TodoMark status={t.status} />
                  </span>
                  <span className="min-w-0 flex-1">
                    {t.content}
                    {t.blocker && <span className="ml-1.5 text-2xs font-bold text-sun-1">· {t.blocker}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
