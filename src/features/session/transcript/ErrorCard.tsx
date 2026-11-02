import { CircleAlert, ShieldAlert } from "lucide-react";
import type { AssistantItem } from "@/core/gen";
import { RefusalActions } from "./RefusalActions";

/** How a provider refusal reads (the board's activity and notifications use the same words). */
export function refusalTitle(refusal: NonNullable<AssistantItem["refusal"]>): string {
  const what = refusal.kind === "sensitive" ? "Flagged by safety filters" : "Refused";
  return refusal.category ? `${what} · ${refusal.category}` : what;
}

/**
 * Why a turn failed, under its text (or alone, for a failure before any output): a provider
 * refusal with its category, explanation and what to do about it (the latest one also offers to go
 * on with another model, `RefusalActions`), else the provider's error with the HTTP status it
 * answered with. The row's own text (error, category, explanation) is plain DOM
 * text that transcript Find counts; labels around it carry `data-find-skip`.
 */
export function ErrorCard({ item }: { item: AssistantItem }) {
  const refusal = item.refusal;
  if (refusal) {
    return (
      <div className="mt-1.5 rounded-md bg-sun-2/[0.08] px-3 py-2 text-xs text-error-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-sun-2)_35%,transparent)]">
        <div role="alert">
          <div className="flex items-center gap-2 font-bold">
            <ShieldAlert className="size-3.5 shrink-0" />
            <span>
              <span data-find-skip>{refusal.kind === "sensitive" ? "Flagged by safety filters" : "Refused"}</span>
              {refusal.category && (
                <>
                  <span data-find-skip> · </span>
                  <span>{refusal.category}</span>
                </>
              )}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-ink/85">{refusal.explanation ?? item.error}</p>
          <p data-find-skip className="mt-1.5 text-2xs font-semibold text-mute">
            The provider declined this request. Rephrase it, or switch to another model and try again.
          </p>
        </div>
        <RefusalActions item={item} />
      </div>
    );
  }
  return (
    <div role="alert" className="mt-1.5 flex items-start gap-2 rounded-md bg-error/10 px-3 py-2 text-xs text-error-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-error)_30%,transparent)]">
      <CircleAlert className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div data-find-skip className="flex items-center gap-2 font-bold">
          {item.stopReason === "aborted" ? "Stopped" : "Request failed"}
          {item.errorStatus != null && <span className="rounded-xs bg-error/20 px-1.5 font-mono text-[10.5px] font-semibold tabular">HTTP {item.errorStatus}</span>}
        </div>
        <span className="mt-0.5 block whitespace-pre-wrap">{item.error}</span>
      </div>
    </div>
  );
}
