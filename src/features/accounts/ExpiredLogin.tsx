import { KeyRound, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, cn, useIsMobile } from "@/design";
import { expiredLogin } from "@/features/usage/limitsUi";

/**
 * A login omp stopped using, as Accounts and Usage both show it: one plain sentence, Re-link,
 * and omp's own reason (`invalid_grant …`) behind Details for whoever wants it.
 */
export function ExpiredLogin({ provider, reason, onRelink }: { provider: string; reason?: string; onRelink?: () => void }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const { title, action, detail } = expiredLogin(provider, reason);
  return (
    <div data-status="error" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg st-soft px-3 py-2 text-xs font-semibold" data-expired-login>
      <KeyRound className="size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 basis-48 break-words">
        <span title={detail}>{title}</span>
        <span className="block font-medium text-mute">
          {action}
          {detail && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="relative ml-1.5 rounded-xs font-bold text-mute-2 underline-offset-2 touch-hit focus-ring hover:text-ink hover:underline"
            >
              {open ? "Hide details" : "Details"}
            </button>
          )}
        </span>
        {open && detail && <code className="mt-1.5 block font-mono text-[11px] font-medium break-all text-mute">{detail}</code>}
      </div>
      {onRelink && (
        <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={onRelink} className={cn(mobile && "w-full")}>
          Re-link
        </Button>
      )}
    </div>
  );
}
