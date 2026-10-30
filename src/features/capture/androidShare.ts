import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";
import { isAndroid, isTauri, toast } from "@/design";
import { openPrefilledTask } from "./prefill";
import { composeShared, type TaskImage } from "./task";

/*
 * Android's share sheet → Dispatch. The Kotlin plugin (`Share.kt`) reads each share sent to
 * TeleFlock (text, a link, a subject, images) and keeps it until the page takes it: at start (a
 * share can launch the app cold) and whenever it announces a new one (`share` event).
 */

/** One share as the plugin hands it over (`take_shares`). */
export interface SharedPayload {
  id: string;
  text?: string;
  subject?: string;
  images: TaskImage[];
  /** Items left out (not images, unreadable, too large, past 8 images). */
  skipped?: number;
}

const PLUGIN = "teleflock-android";

/** One share → Dispatch, prefilled for the repo it is about or the last one. */
export async function handleShare(s: SharedPayload): Promise<void> {
  const { text, repo } = composeShared(s);
  if (!text && !s.images.length) {
    if (s.skipped) toast({ title: "Nothing TeleFlock can use was shared", description: "Share text, a link or images.", status: "error" });
    return;
  }
  await openPrefilledTask({ text, images: s.images, source: "share", ...(repo ? { repo } : {}) });
  if (s.skipped) toast({ title: `${s.skipped} shared item${s.skipped === 1 ? " was" : "s were"} left out`, description: "Only text, links and images (up to 8, 20 MB each and 32 MB together) come along.", status: "idle" });
}

/**
 * Every share on its own: one that fails (the prefill threw) is told to the user and doesn't take the
 * rest down with it. The plugin hands shares over for good, so what is dropped here is gone.
 */
export async function handleShares(shares: readonly SharedPayload[], handle: (s: SharedPayload) => Promise<void> = handleShare): Promise<void> {
  for (const s of shares) {
    try {
      await handle(s);
    } catch (e) {
      console.warn("share: couldn't open a shared item", e);
      toast({ title: "Couldn't open a shared item", description: `${e instanceof Error ? e.message : String(e)}. Share it again.`, status: "error" });
    }
  }
}

/** Takes the shares waiting in the plugin, now and on every `share` event. Android only; returns the stop. */
export function startShareInbox(): () => void {
  if (!isTauri() || !isAndroid) return () => {};
  let chain = Promise.resolve();
  const pull = () => {
    chain = chain
      .then(async () => {
        const { shares } = await invoke<{ shares: SharedPayload[] }>(`plugin:${PLUGIN}|take_shares`);
        await handleShares(shares);
      })
      .catch((e: unknown) => console.warn("share: couldn't take the shared items", e));
  };
  let listener: PluginListener | null = null;
  let stopped = false;
  addPluginListener(PLUGIN, "share", pull).then(
    (l) => {
      if (stopped) void l.unregister();
      else listener = l;
    },
    (e: unknown) => console.warn("share: no share events", e),
  );
  pull();
  return () => {
    stopped = true;
    void listener?.unregister();
  };
}
