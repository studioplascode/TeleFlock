import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { core, toApiError } from "@/core";
import type { DictationMicrophoneAccess } from "@/core/gen";
import { isAndroid, isTauri, toast } from "@/design";
import { type AndroidMicPermission, androidMicBlock, type MicBlock, type MicScope, micBlock } from "./micAccess";

const PLUGIN = "plugin:teleflock-android|";

/** The app core's answer (`dictation.microphoneAccess`); null from a core without it (the Android app, a build without the engine, a core from before it). */
export async function readMicAccess(): Promise<DictationMicrophoneAccess | null> {
  try {
    return await core.app("dictation.microphoneAccess", {});
  } catch {
    return null;
  }
}

/** What blocks the microphone for `scope` now: Android's permission in the Android app, else the app core's answer (with the desktop window's). */
export async function checkMicBlock(scope: MicScope): Promise<MicBlock | null> {
  if (isTauri() && isAndroid) {
    const { recordAudio } = await invoke<{ recordAudio: AndroidMicPermission }>(`${PLUGIN}microphone_permission`);
    return androidMicBlock(recordAudio);
  }
  const access = await readMicAccess();
  return access && micBlock(access, scope);
}

/** Runs `block`'s button: the system's microphone settings (Android: the app's info), or allowing the window's microphone. */
async function undo(block: MicBlock): Promise<void> {
  if (block.action?.run === "allowWindow") await core.app("dictation.allowWindowMicrophone", {});
  else if (isTauri() && isAndroid) await invoke(`${PLUGIN}open_app_settings`);
  else await core.app("dictation.openMicrophoneSettings", {});
}

/** Calls `check` whenever the window comes back to the front (back from the system's settings) while `active`. */
function useOnFront(active: boolean, check: () => void): void {
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    if (!active) return;
    const onFocus = () => latest.current();
    const onVisible = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active]);
}

/** A block on screen, with its button. */
export interface MicBlocked {
  block: MicBlock;
  /** The button's call is running. */
  busy: boolean;
  /** Runs the button, then checks again: allowing the window's microphone lifts the block at once; the system's page needs the user, and the window coming back checks. */
  act(): void;
  /** Hides it (until the next refusal, or the next check that finds it). */
  dismiss(): void;
}

/** The block shown, checked again on `recheck`; `act` runs its button. */
function useMicBlockState(scope: MicScope) {
  const [block, setBlock] = useState<MicBlock | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef<MicBlock | null>(null);
  shown.current = block;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** `onlyShown`: a notice is only updated or cleared, never brought back once it went. */
  const recheck = (onlyShown: boolean) => {
    void checkMicBlock(scope).then(
      (now) => {
        if (mounted.current && (!onlyShown || shown.current)) setBlock(now);
      },
      () => {},
    );
  };

  const act = (onlyShown: boolean) => {
    const b = shown.current;
    if (!b?.action || busy) return;
    const label = b.action.run === "allowWindow" ? "Couldn't allow the microphone" : "Couldn't open the settings";
    setBusy(true);
    undo(b)
      .then(
        () => recheck(onlyShown),
        (e: unknown) => {
          const err = toApiError(e);
          toast({ title: label, description: [err.message, err.hint].filter(Boolean).join(". "), status: "error" });
        },
      )
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  return { block, setBlock, busy, recheck, act };
}

/**
 * A text box's notice after the system refused the microphone (`show`). It stays until access is back, checked
 * whenever the window comes back to the front and right after its button ran; the next tap then listens (nothing
 * starts by itself).
 */
export function useMicBlockNotice(scope: MicScope): { blocked: MicBlocked | null; show(block: MicBlock): void; clear(): void } {
  const s = useMicBlockState(scope);
  useOnFront(s.block !== null, () => s.recheck(true));
  const blocked: MicBlocked | null = s.block && { block: s.block, busy: s.busy, act: () => s.act(true), dismiss: () => s.setBlock(null) };
  return { blocked, show: s.setBlock, clear: () => s.setBlock(null) };
}

/** Settings: what blocks the microphone now (both scopes), checked when it mounts and whenever the window comes back to the front. */
export function useMicAccess(): MicBlocked | null {
  const s = useMicBlockState("window");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once when the card opens; the window coming back checks again.
  useEffect(() => s.recheck(false), []);
  useOnFront(true, () => s.recheck(false));
  return s.block && { block: s.block, busy: s.busy, act: () => s.act(false), dismiss: () => s.setBlock(null) };
}
