import { useEffect } from "react";
import { create } from "zustand";
import { dismissToast, isAndroid, toast } from "@/design";
import { core, onAppEvent } from "@/core";
import type { UpdatePhase, UpdateStatus } from "@/core/gen";

/**
 * App self-update (Tauri backend only; src-tauri/src/update). The shell answers the
 * `app.update*` methods and pushes `{ type: "update" }` events; this module mirrors them.
 */
export const useUpdateStatus = create<{ status: UpdateStatus | null }>()(() => ({ status: null }));

/** Wait after launch before checking, so the check never competes with startup. */
const LAUNCH_DELAY_MS = 4000;

let watching = false;

/** Mirrors the shell's update status into `useUpdateStatus` (idempotent; Tauri only). */
export function watchUpdates(): void {
  if (watching || core.backend !== "tauri") return;
  watching = true;
  onAppEvent((e) => {
    if (e.type === "update") useUpdateStatus.setState({ status: e.status });
  });
  core.app("app.updateStatus", {}).then(
    // An event that arrived meanwhile is newer than this answer.
    (status) => useUpdateStatus.setState((s) => (s.status ? s : { status })),
    () => {},
  );
}

/** One line describing an install in progress (toast body, Settings status). */
export function installLine(s: UpdateStatus): string {
  switch (s.phase) {
    case "downloading":
      return s.progress === undefined ? "Downloading…" : `Downloading… ${s.progress}%`;
    case "installing":
      return isAndroid ? "Confirm the update in Android's installer." : "Installing. TeleFlock restarts by itself.";
    case "needsPermission":
      return "Allow TeleFlock to install apps in Android settings, then come back.";
    default:
      return "";
  }
}

const TOAST_PHASES: Partial<Record<UpdatePhase, true>> = { downloading: true, installing: true, needsPermission: true };

function ToastLine() {
  const status = useUpdateStatus((s) => s.status);
  return <span className="tabular">{status ? installLine(status) : ""}</span>;
}

let toastId: number | null = null;

function syncToast(status: UpdateStatus | null): void {
  const show = status !== null && status.latest !== undefined && TOAST_PHASES[status.phase] === true;
  if (show && toastId === null) {
    toastId = toast({ title: `Updating TeleFlock to v${status.latest}`, description: <ToastLine />, status: "running", duration: Number.POSITIVE_INFINITY });
  } else if (!show && toastId !== null) {
    // Failures stay quiet (Settings → Updates shows them); just drop the progress toast.
    dismissToast(toastId);
    toastId = null;
  }
}

/**
 * Mount once (App). Tauri backend only: a few seconds after launch asks the shell for its
 * launch check (once per process, release builds, `settings.autoUpdate`), and shows a progress
 * toast while an update downloads and installs.
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    if (core.backend !== "tauri") return;
    watchUpdates();
    const unsub = useUpdateStatus.subscribe((s) => syncToast(s.status));
    const timer = setTimeout(() => {
      core.app("app.updateCheck", { launch: true, install: false }).then(
        // Manual platforms (macOS) never install by themselves: point at the download once.
        (s) => {
          if (s.manual && s.phase === "available") {
            toast({
              title: `TeleFlock v${s.latest} is available`,
              description: "Download it and replace the app in Applications.",
              action: { label: "Download", onClick: () => void core.app("app.updateInstall", {}).catch(() => {}) },
              duration: 15_000,
            });
          }
        },
        (err: unknown) => console.warn("[update] launch check failed", err),
      );
    }, LAUNCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, []);
}
