import { FileCode2, ShieldAlert } from "lucide-react";
import type { ScriptListing } from "./model";

/**
 * The body of the dialog before a skill version that ships scripts is installed (`scripts_need_consent`):
 * the files omp listed, and what running them means. The dialog's danger button retries with `allowScripts`.
 */
export function ScriptsConsent({ listing, hostName }: { listing: readonly ScriptListing[]; hostName: string }) {
  const files = listing.flatMap((l) => l.files);
  const others = listing.filter((l) => l.files.length === 0 && l.title);
  return (
    <div className="flex flex-col gap-3">
      <p>
        This version comes with {files.length === 1 ? "a script" : "scripts"}. omp sessions that use the skill may run {files.length === 1 ? "it" : "them"} on {hostName}{" "}
        <span className="font-bold text-ink">with your rights there</span>: {files.length === 1 ? "it" : "they"} can read, change and send anything your account can. Install it only
        if you trust its publisher.
      </p>
      {files.length > 0 && (
        <ul className="flex max-h-52 flex-col gap-1 overflow-y-auto rounded-md well px-3 py-2.5" aria-label="Files it ships">
          {listing.map((l) =>
            l.files.map((f) => (
              <li key={`${l.title}:${f.path}`} className="flex min-w-0 items-center gap-2 font-mono text-2xs text-ink-2">
                <FileCode2 className="size-3.5 shrink-0 text-mute-2" aria-hidden />
                <span className="min-w-0 truncate" title={f.path}>
                  {f.path}
                </span>
                {f.executable && <span className="ml-auto shrink-0 rounded-full bg-warn/12 px-1.5 py-px font-sans text-[10px] font-bold text-warn">executable</span>}
              </li>
            )),
          )}
        </ul>
      )}
      {others.map((l) => (
        <p key={l.title} className="font-mono text-2xs text-mute">
          {l.title}
        </p>
      ))}
      <p className="flex items-start gap-2 text-xs text-mute">
        <ShieldAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden />
        <span>Without scripts nothing is installed: omp installs a version whole or not at all.</span>
      </p>
    </div>
  );
}
