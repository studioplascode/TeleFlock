import { Suspense, useEffect } from "react";
import { AmbientGlow, DesignProvider, LogoMark, Shimmer, Spinner, TitleBar, useIsMobile, useMotionPreference } from "@/design";
import { useHosts, useRoute, useSettings, useUi } from "@/core";
import { NewAgentDialog } from "@/features/workspace/NewAgentDialog";
import { NewWorktreeDialog } from "@/features/worktree/NewWorktreeDialog";
import { PastSessionsDialog } from "@/features/history/PastSessionsDialog";
import { FanOutDialog } from "@/features/worktree/FanOutDialog";
import { AnswerNextHud } from "@/features/inbox/AnswerNextHud";
import { HostEditor } from "@/features/hosts/HostEditor";
import { Onboarding } from "@/features/hosts/Onboarding";
import { useNotifyBridge } from "@/features/notify/useNotifyBridge";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { useOverlayBack } from "@/features/shell/backButton";
import { DesktopShell } from "@/features/shell/DesktopShell";
import { useGlobalShortcuts } from "@/features/shell/keyboard";
import { useGlobalMood, useGlobalPulseFeed } from "@/features/shell/liveness";
import { MobileShell } from "@/features/shell/MobileShell";
import { SheetHost } from "@/features/shell/sheets";
import { ShortcutsSheet } from "@/features/shell/ShortcutsSheet";
import { RouteView } from "./routes";

/** Overlays mounted exactly once, above every layout. */
function GlobalOverlays() {
  return (
    <>
      <CommandPalette />
      <AnswerNextHud />
      <NewWorktreeDialog />
      <NewAgentDialog />
      <PastSessionsDialog />
      <FanOutDialog />
      <HostEditor />
      <ShortcutsSheet />
      <SheetHost />
    </>
  );
}

/** Keep the design system's motion preference in sync with the saved `Settings.motion`. */
function useMotionSettingSync(): void {
  const motion = useSettings((s) => s.motion);
  const loaded = useSettings((s) => s.loaded);
  const setPreference = useMotionPreference((s) => s.setPreference);
  useEffect(() => {
    if (loaded) setPreference(motion);
  }, [loaded, motion, setPreference]);
}

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4">
        <LogoMark size={56} animated />
        <Shimmer className="text-sm font-bold">Gathering the flock…</Shimmer>
      </div>
    </div>
  );
}

function Frame() {
  const route = useRoute();
  const mobile = useIsMobile();
  const loaded = useHosts((h) => h.loaded);
  const hostCount = useHosts((h) => h.profiles.length);
  const mood = useGlobalMood();
  const focus = useUi((s) => s.focusMode);
  useMotionSettingSync();
  useNotifyBridge();
  useGlobalPulseFeed();
  useGlobalShortcuts();
  useOverlayBack(mobile);

  if (route.name === "design") {
    return (
      <div className="flex h-full flex-col">
        <TitleBar />
        <main className="relative min-h-0 flex-1">
          <Suspense fallback={<div className="grid h-full place-items-center"><Spinner size={22} /></div>}>
            <RouteView route={route} mobile={mobile} />
          </Suspense>
        </main>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex h-full flex-col">
        <TitleBar />
        <Splash />
      </div>
    );
  }

  if (hostCount === 0) {
    return (
      <div className="flex h-full flex-col">
        <TitleBar />
        <main className="relative min-h-0 flex-1">
          <Onboarding />
        </main>
        <HostEditor />
      </div>
    );
  }

  return (
    <>
      <AmbientGlow mood={mood} intensity={focus ? 0.35 : 1} />
      {mobile ? <MobileShell /> : <DesktopShell />}
      <GlobalOverlays />
    </>
  );
}

/** App root: design providers, then the shell for the current form factor. */
export function App() {
  return (
    <DesignProvider>
      <Frame />
    </DesignProvider>
  );
}
