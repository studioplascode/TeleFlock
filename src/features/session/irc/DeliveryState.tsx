import { Hourglass } from "lucide-react";
import { cn, Tooltip } from "@/design";
import { type Delivery, deliveryNotes } from "./chat";

/**
 * A sent message's state on its delivery line, the same in the transcript's IRC bubbles and on the
 * message board: "✓ delivered", "✓ woke it", "⧗ queued" (omp queued it for a busy recipient, which
 * takes it in when its current step ends), "✓ 2/3 delivered · 1 queued · not to Sweep". `tip`:
 * what it means (`deliveryTip`); `name`: an agent id as the line names it.
 */
export function DeliveryState({ d, tip, name, className }: { d: Extract<Delivery, { label: string }>; tip?: string; name?: (id: string) => string; className?: string }) {
  const body = (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {d.kind === "queued" ? (
        <span className="flex shrink-0 items-center gap-1 text-accent-hi">
          <Hourglass className="size-3" aria-hidden />
          {d.label}
        </span>
      ) : (
        <span className="shrink-0 text-done">✓ {d.label}</span>
      )}
      {deliveryNotes(d, name).map((n) => (
        <span key={n.tone} className={n.tone === "failed" ? "min-w-0 truncate text-error" : "shrink-0 text-accent-hi"}>
          · {n.text}
        </span>
      ))}
    </span>
  );
  if (!tip) return body;
  return <Tooltip content={<span className="block whitespace-pre-line">{tip}</span>}>{body}</Tooltip>;
}
