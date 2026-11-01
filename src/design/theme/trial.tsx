import { createElement } from "react";
import { useNow } from "../lib/clock";
import { dismissToast, toast } from "../ui/Toast";
import { customById, type ThemeData } from "./model";
import { presetById } from "./presets";
import { useThemeStore } from "./store";

function themeName(d: ThemeData, id: string): string {
  return presetById(id)?.name ?? customById(d, id)?.name ?? "the previous theme";
}

function TrialCountdown({ until, back }: { until: number; back: string }) {
  const left = Math.max(0, Math.ceil((until - useNow(1000)) / 1000));
  return `Going back to ${back} in ${left} s unless you keep it.`;
}

/**
 * The main window's trial prompt: a toast with Keep while a custom theme is on trial (Settings →
 * Appearance shows the same choice), gone when the trial ends; a note when it ended by itself.
 */
export function watchThemeTrials(): void {
  let toastId: number | undefined;
  useThemeStore.subscribe((s, prev) => {
    if (s.trial === prev.trial) return;
    if (toastId !== undefined) dismissToast(toastId);
    toastId = undefined;
    const ended = prev.trial;
    if (s.trial) {
      const back = themeName(s, s.trial.previous.active);
      toastId = toast({
        title: `Keep “${themeName(s, s.trial.id)}”?`,
        description: createElement(TrialCountdown, { until: s.trial.until, back }),
        action: { label: "Keep", onClick: () => useThemeStore.getState().keep() },
        duration: Math.max(1000, s.trial.until - Date.now()),
      });
    } else if (ended && s.active !== ended.id && Date.now() >= ended.until - 250) {
      toast({ title: `Back to ${themeName(s, s.active)}`, description: `“${themeName(s, ended.id)}” wasn't kept. It's still in Settings → Appearance.` });
    }
  });
}
