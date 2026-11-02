import { ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cn, Dialog, DialogContent, Spinner, useIsMobile } from "@/design";
import { openLink, useHosts, useUi } from "@/core";
import { Markdown } from "@/features/session/markdown/Markdown";
import { lastTypedAt, startTypingTracker } from "./typing";
import {
  canShowNow,
  checkWhatsNew,
  dismissWhatsNew,
  type ReleaseNote,
  releasePageUrl,
  RELEASES_PAGE,
  showWaiting,
  useWhatsNew,
  type WhatsNewView,
} from "./releaseNotes";

/** How often a ready modal re-checks whether the screen is quiet enough to appear. */
const IDLE_POLL_MS = 1000;

/**
 * Mount once (App, every platform). Starts the once-per-launch check that decides whether the
 * running version's release notes are due, as soon as the app core has loaded its hosts: a real
 * (non-demo) host is what tells an install that predates the version record from a fresh one.
 * Never blocks anything: the request runs in the background.
 */
export function useWhatsNewCheck(): void {
  const loaded = useHosts((h) => h.loaded);
  const existing = useHosts((h) => h.profiles.some((p) => p.kind !== "demo"));
  useEffect(() => startTypingTracker(), []);
  useEffect(() => {
    if (loaded) void checkWhatsNew(existing);
  }, [loaded, existing]);
}

/** Whether a dialog, sheet, the palette or the Answer-next HUD is open right now. */
function overlayOpen(): boolean {
  const ui = useUi.getState();
  if (ui.dialog || ui.paletteOpen || ui.answerNextOpen) return true;
  return document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function ReleaseSection({ release, heading }: { release: ReleaseNote; heading: boolean }) {
  const date = formatDate(release.date);
  return (
    <section className={cn(heading && "border-t border-line pt-4 first:border-0 first:pt-0")}>
      {heading ? (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
          <h3 className="font-display text-lg font-bold text-ink">v{release.version}</h3>
          {date && <span className="text-xs text-mute">{date}</span>}
        </div>
      ) : (
        date && <p className="mb-2 text-xs text-mute">{date}</p>
      )}
      {release.body ? <Markdown text={release.body} /> : <p className="text-sm text-mute">No release notes were published for this version.</p>}
    </section>
  );
}

function Body({ view }: { view: WhatsNewView }) {
  if (view.kind === "loading") {
    return (
      <div className="flex items-center gap-2.5 py-6 text-sm text-mute" role="status">
        <Spinner size={16} /> Loading the release notes…
      </div>
    );
  }
  if (view.kind === "link") {
    return (
      <p className="text-sm text-ink-2">
        TeleFlock updated to v{view.version}. The release notes couldn't be loaded from GitHub just now; you can read what changed on the release page.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {view.releases.map((r) => (
        <ReleaseSection key={r.version} release={r} heading={view.releases.length > 1} />
      ))}
    </div>
  );
}

/** The newest release's page, or the version's page when there are no notes. */
function githubUrl(view: WhatsNewView): string {
  if (view.kind === "notes" && view.releases[0]) return view.releases[0].url;
  return view.kind === "loading" || view.kind === "link" ? releasePageUrl(view.version) : RELEASES_PAGE;
}

/**
 * "What's new in TeleFlock x.y.z": the GitHub release notes of every version since the last one
 * this device showed (or the running version's, opened from Settings or the palette). A centred
 * dialog on desktop, a full-screen sheet on phones. Mounted once in the global overlays; it only
 * appears when nothing else is open and the user has stopped typing.
 */
export function WhatsNew() {
  const view = useWhatsNew((s) => s.view);
  const waiting = useWhatsNew((s) => s.waiting);
  const mobile = useIsMobile();
  // The last view stays rendered while the dialog animates out.
  const [last, setLast] = useState<WhatsNewView | null>(view);
  if (view && view !== last) setLast(view);
  const shown = view ?? last;

  useEffect(() => {
    if (!waiting || view) return;
    const tick = () => {
      if (canShowNow({ overlayOpen: overlayOpen(), lastTypedAt: lastTypedAt(), now: Date.now() })) showWaiting();
    };
    tick();
    const id = setInterval(tick, IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [waiting, view]);

  return (
    <Dialog open={view !== null} onOpenChange={(o) => !o && dismissWhatsNew()}>
      <DialogContent
        title={shown ? `What's new in TeleFlock ${shown.version}` : "What's new"}
        description={shown?.kind === "notes" && shown.releases.length > 1 ? `Everything since the version you last used: ${shown.releases.length} releases, newest first.` : undefined}
        icon={<Sparkles />}
        width={720}
        className="max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:p-4 max-md:pt-[max(1rem,env(safe-area-inset-top))]"
        style={mobile ? { maxWidth: "none", top: 0, left: 0, paddingBottom: "max(1rem, env(safe-area-inset-bottom))" } : undefined}
        footer={
          <>
            {shown && (
              <Button variant="secondary" icon={<ExternalLink />} onClick={() => openLink(githubUrl(shown))}>
                Read on GitHub
              </Button>
            )}
            <Button variant="primary" data-autofocus onClick={dismissWhatsNew}>
              Got it
            </Button>
          </>
        }
      >
        {shown && <Body view={shown} />}
      </DialogContent>
    </Dialog>
  );
}
