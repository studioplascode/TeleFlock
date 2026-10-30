import { Archive, Database, HardDrive, Image, Play, RotateCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { CleanupStorage, GcCategory, GcRun } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, Spinner, Tile, cn, formatAge, useNow } from "@/design";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { tildify } from "@/features/workspace/shared/paths";
import type { StorageQuery } from "./useCleanup";

const CATEGORIES: readonly GcCategory[] = ["blobs", "wal", "compress"];

const META: Record<GcCategory, { label: string; icon: ReactNode; about: string }> = {
  blobs: { label: "Unreferenced blobs", icon: <Image />, about: "Images and attachments no session refers to any more." },
  wal: { label: "Database write-ahead logs", icon: <Database />, about: "Folds the history and model databases' logs back into them." },
  compress: { label: "Compress idle sessions", icon: <Archive />, about: "Session files idle for a week, compressed by the file system in place (APFS, NTFS); they stay resumable." },
};

/** What a check found for one category: its line, and whether applying it would do anything. */
function found(c: GcCategory, run: GcRun): { text: string; todo: boolean } {
  if (c === "blobs") {
    const b = run.blobs;
    if (!b) return { text: "not checked", todo: false };
    return b.wouldDelete > 0 ? { text: `${b.wouldDelete} file${b.wouldDelete === 1 ? "" : "s"}, ${formatBytes(b.bytes)}`, todo: true } : { text: "none", todo: false };
  }
  if (c === "wal") {
    const w = run.wal;
    if (!w) return { text: "not checked", todo: false };
    return w.walBytes > 0 ? { text: `${formatBytes(w.walBytes)} to fold in`, todo: true } : { text: "nothing to fold in", todo: false };
  }
  const z = run.compress;
  if (!z) return { text: "not checked", todo: false };
  if (!z.supported) return { text: "this file system doesn't compress in place (APFS and NTFS do)", todo: false };
  return z.wouldCompress > 0
    ? { text: `${z.wouldCompress} file${z.wouldCompress === 1 ? "" : "s"} in ${z.sessions} session${z.sessions === 1 ? "" : "s"}, ${formatBytes(z.allocatedBefore)} on disk`, todo: true }
    : { text: "nothing idle to compress", todo: false };
}

/** What an apply did, in one line. */
function didWords(run: GcRun): string {
  const parts: string[] = [];
  if (run.blobs) parts.push(`deleted ${run.blobs.deleted} blob${run.blobs.deleted === 1 ? "" : "s"} (${formatBytes(run.blobs.bytes)})`);
  if (run.wal) parts.push(run.wal.checkpointed ? "folded the database logs in" : "left the database logs (busy)");
  if (run.compress) parts.push(run.compress.supported ? `compressed ${run.compress.compressed} file${run.compress.compressed === 1 ? "" : "s"}` : "compression unsupported");
  return parts.join(" · ") || "nothing to do";
}

function Errors({ run }: { run: GcRun }) {
  if (run.errors.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs break-words text-error/90">
      {run.errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

/**
 * omp's own storage cleanup (`omp gc`) on this host, limited to what is not a session: a dry-run check,
 * then Apply for the ticked categories. Sessions are only measured, never archived or deleted.
 */
export function StorageSection({ q, hostName, home }: { q: StorageQuery; hostName: string; home?: string }) {
  const now = useNow(30_000);
  const data: CleanupStorage | undefined = q.data;
  const check = data?.check;
  const running = data?.running;
  const busy = q.starting || !!running;
  const [picked, setPicked] = useState<Record<string, GcCategory[]>>({});
  const todo = check ? CATEGORIES.filter((c) => found(c, check).todo) : [];
  const key = check ? String(check.startedAt) : "";
  const chosen = picked[key] ?? todo;

  const apply = async () => {
    if (!check || chosen.length === 0) return;
    const ok = await confirmAction({
      title: `Apply omp's storage cleanup on ${hostName}?`,
      body: (
        <>
          <ul className="mb-2 list-disc pl-5">
            {chosen.map((c) => (
              <li key={c}>
                {META[c].label}: {found(c, check).text}
              </li>
            ))}
          </ul>
          Sessions are not touched.
        </>
      ),
      confirmLabel: "Apply",
    });
    if (ok) q.apply(chosen);
  };

  let body: ReactNode;
  if (data?.unavailable) body = <p className="text-xs text-mute">{data.unavailable}.</p>;
  else if (!check && !running)
    body = <p className="text-xs text-mute">A check is a dry run: omp reports what it would clean and changes nothing.</p>;
  else if (!check) body = null;
  else
    body = (
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col divide-y divide-line rounded-md well">
          {CATEGORIES.map((c) => {
            const f = found(c, check);
            const on = chosen.includes(c);
            return (
              <li key={c}>
                <label className={cn("flex items-start gap-3 px-3 py-2.5", f.todo ? "cursor-pointer" : "opacity-70")}>
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[#a35cf0]"
                    checked={on}
                    disabled={!f.todo || busy}
                    onChange={(e) => setPicked({ [key]: e.target.checked ? [...chosen, c] : chosen.filter((x) => x !== c) })}
                  />
                  <span className="grid size-6 shrink-0 place-items-center rounded-sm bg-white/6 text-mute [&_svg]:size-3.5">{META[c].icon}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-semibold text-ink">{META[c].label}</span>
                    <span className="text-2xs text-mute-2">{META[c].about}</span>
                  </span>
                  <span className={cn("max-w-[45%] text-right text-xs", f.todo ? "font-semibold text-ink-2" : "text-mute")}>{f.text}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <Errors run={check} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xs text-mute-2">Checked {formatAge(now - (check.finishedAt ?? check.startedAt))}</span>
          <Button size="sm" variant="primary" icon={<Play />} className="ml-auto" disabled={busy || chosen.length === 0} onClick={() => void apply()}>
            Apply {chosen.length > 0 ? `(${chosen.length})` : ""}
          </Button>
        </div>
      </div>
    );

  const applied = data?.applied;
  return (
    <section aria-label="omp storage" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold">
          <HardDrive className="size-4 text-mute" /> omp storage
        </h2>
        <Button size="sm" variant="secondary" icon={busy ? <Spinner /> : <RotateCw />} className="ml-auto" disabled={busy || !!data?.unavailable || !data} onClick={q.check}>
          {running ? (running.apply ? "Applying…" : "Checking…") : check ? "Check again" : "Check"}
        </Button>
      </div>
      <Tile className="flex flex-col gap-3 p-4 max-md:p-3.5">
        <p className="text-xs text-mute">
          omp's own cleanup, limited to what is not a session: unreferenced blobs, the databases' write-ahead logs and filesystem compression of idle sessions.
          Sessions are never archived or deleted here.
        </p>
        {data?.sessions && (
          <p className="text-xs text-ink-2">
            Sessions kept: <b>{formatBytes(data.sessions.bytes)}</b> in {data.sessions.files.toLocaleString()} files under{" "}
            <span className="font-mono text-mute">{tildify(`${data.agentDir}/sessions`, home)}</span>
          </p>
        )}
        {body}
        {applied && (
          <div className="flex flex-col gap-1 border-t border-line pt-2">
            <p className="text-xs text-ink-2">
              Applied {formatAge(now - (applied.finishedAt ?? applied.startedAt))}: {didWords(applied)}
            </p>
            <Errors run={applied} />
          </div>
        )}
        {q.error && <p className="text-xs text-error/90">{q.error.hint ? `${q.error.message} · ${q.error.hint}` : q.error.message}</p>}
      </Tile>
    </section>
  );
}
