import { Ban, Check } from "lucide-react";
import type { ModelAccess } from "@/core/gen";
import { Tooltip } from "@/design";
import { modelAccessLines } from "./limitsUi";

/**
 * Which models an account serves or is refused, as the agents' requests showed it (hostd's model
 * access, architecture §3.22): one small line per model, on the Accounts and Usage pages. Nothing when
 * nothing current is known.
 */
export function ModelAccessLines({ models }: { models?: ModelAccess[] }) {
  const lines = modelAccessLines(models);
  if (lines.length === 0) return null;
  return (
    <ul data-testid="model-access" className="flex flex-col gap-0.5 text-[11px] font-semibold">
      {lines.map((l) => (
        <li key={l.model}>
          <Tooltip content={l.denied ? "The provider refused this model on this account; auto-resume does not count it for this model" : "An agent's request on this account was answered"}>
            <span data-status={l.denied ? "needs-you" : undefined} className={l.denied ? "inline-flex items-center gap-1 st-text" : "inline-flex items-center gap-1 text-mute"}>
              {l.denied ? <Ban className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />}
              {l.text}
            </span>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}
