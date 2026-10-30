import { useEffect } from "react";
import { create } from "zustand";
import { dismissToast, isAndroid, toast } from "@/design";
import { core, onAppEvent } from "@/core";
import type { UpdatePhase, UpdateStatus } from "@/core/gen";

/**
 * App self-update (Tauri backend only; src-tauri/src/update). The shell answers the
 * `app.update*` methods, checks by itself (launch, hourly, back in front) and pushes
 * `{ type: "update" }` events; this module mirrors them.
 */
export const useUpdateStatus = create<{ status: UpdateStatus | null }>()(() => ({ status: null }));

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
    case "ready":
      return s.needsPassword
        ? "Downloaded. Install it when you're ready; it asks for your password."
        : "Downloaded. TeleFlock installs it when you leave the window, or restart now.";
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

/** Versions already announced by `announceManual` (the shell re-reports them on every check). */
const announced = new Set<string>();

/** Manual platforms (macOS) never install by themselves: point at the download once per version. */
function announceManual(status: UpdateStatus | null): void {
  if (!status?.manual || status.phase !== "available" || status.latest === undefined || announced.has(status.latest)) return;
  announced.add(status.latest);
  toast({
    title: `TeleFlock v${status.latest} is available`,
    description: "Download it and replace the app in Applications.",
    action: { label: "Download", onClick: () => void core.app("app.updateInstall", {}).catch(() => {}) },
    duration: 15_000,
  });
}

/** Versions whose "ready" toast was shown (the status is re-pushed on every change). */
const readyShown = new Set<string>();

/** An update downloaded by an automatic check waits for the user while the window is in front. */
function announceReady(status: UpdateStatus | null): void {
  if (status?.phase !== "ready" || status.latest === undefined || readyShown.has(status.latest)) return;
  readyShown.add(status.latest);
  toast({
    title: `TeleFlock v${status.latest} is ready`,
    description: status.needsPassword ? "Installing asks for your password." : "TeleFlock restarts to finish updating.",
    action: { label: status.needsPassword ? "Install" : "Restart now", onClick: () => void core.app("app.updateInstall", {}).catch(() => {}) },
    duration: 30_000,
  });
}

/**
 * Mount once (App). Tauri backend only: shows a progress toast while an update downloads and
 * installs, and on macOS one "vX is available" toast per new version. The checks themselves run
 * in the shell (release builds, `settings.autoUpdate`), with or without a webview.
 */
export function useAutoUpdate(): void {
  useEffect(() => {
    if (core.backend !== "tauri") return;
    const unsub = useUpdateStatus.subscribe((s) => {
      syncToast(s.status);
      announceManual(s.status);
      announceReady(s.status);
    });
    watchUpdates();
    return unsub;
  }, []);
}
