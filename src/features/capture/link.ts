import { emitTo, listen } from "@tauri-apps/api/event";
import { isTauri } from "@/design/lib/platform";
import type { CaptureSnapshot } from "./snapshot";
import type { TaskImage } from "./task";

/*
 * The Quick capture window and the main window talk in messages. The main window owns the stores,
 * so it does the work (Dispatch sends, answers) and tells the capture window what to show; the
 * capture window never loads the app's core. Inside Tauri the messages are events addressed to
 * one webview (`emitTo`), one event name per direction; in a browser (dev, headless checks) a
 * same-origin BroadcastChannel carries them between tabs.
 */

/** Capture window → main window. */
export type ToMain =
  /** The window shows: post the picture now, and again whenever it changes. */
  | { kind: "hello" }
  /** Hidden: stop posting. */
  | { kind: "bye" }
  /** Dispatch it now to `target`/`repo`. */
  | { kind: "send"; id: string; text: string; images: TaskImage[]; target: string; repo: string }
  /** Open Dispatch with it prefilled (and the main window in front). */
  | { kind: "edit"; id: string; text: string; images: TaskImage[]; target?: string; repo?: string }
  /** Answer `agentKey`'s pending request `requestId` with one option. */
  | { kind: "answer"; id: string; agentKey: string; requestId: string; optionId: string }
  /** Answer it in TeleFlock: the Answer-next HUD on that agent. */
  | { kind: "open"; id: string; agentKey: string };

/** Main window → capture window. */
export type ToCapture =
  | { kind: "state"; snapshot: CaptureSnapshot }
  /** How request `id` went. */
  | { kind: "done"; id: string; ok: boolean; title: string; detail?: string }
  /** The main page (re)started: a showing window says hello again. */
  | { kind: "ready" };

export interface Port<In, Out> {
  post(msg: Out): void;
  /** Returns the unsubscribe. */
  listen(cb: (msg: In) => void): () => void;
}

/** Event names, one per direction (so neither webview hears its own messages). */
export const TO_MAIN = "tf-capture://to-main";
export const TO_CAPTURE = "tf-capture://to-capture";
/** Webview labels (the capture window is created by the shell, `src-tauri/src/capture.rs`). */
export const MAIN_LABEL = "main";
export const CAPTURE_LABEL = "capture";
/** BroadcastChannel name outside Tauri. */
const CHANNEL = "tf-capture";

function tauriPort<In, Out>(hear: string, say: string, to: string): Port<In, Out> {
  return {
    post: (msg) => {
      emitTo(to, say, msg).catch((e: unknown) => console.warn("capture: message not delivered", e));
    },
    listen: (cb) => {
      let off: (() => void) | null = null;
      let gone = false;
      void listen<In>(hear, (e) => cb(e.payload)).then((un) => {
        if (gone) un();
        else off = un;
      });
      return () => {
        gone = true;
        off?.();
      };
    },
  };
}

function channelPort<In, Out>(me: string, other: string): Port<In, Out> | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(CHANNEL);
  return {
    post: (msg) => ch.postMessage({ to: other, msg }),
    listen: (cb) => {
      const on = (e: MessageEvent<{ to?: string; msg?: In }>) => {
        if (e.data?.to === me && e.data.msg) cb(e.data.msg);
      };
      ch.addEventListener("message", on);
      return () => ch.removeEventListener("message", on);
    },
  };
}

/** The main window's end. Null where no capture window can exist (no BroadcastChannel). */
export function mainPort(): Port<ToMain, ToCapture> | null {
  return isTauri() ? tauriPort(TO_MAIN, TO_CAPTURE, CAPTURE_LABEL) : channelPort(MAIN_LABEL, CAPTURE_LABEL);
}

/** The capture window's end. */
export function capturePort(): Port<ToCapture, ToMain> | null {
  return isTauri() ? tauriPort(TO_CAPTURE, TO_MAIN, MAIN_LABEL) : channelPort(CAPTURE_LABEL, MAIN_LABEL);
}

let seq = 0;

/** A request id (`done` answers carry it back). */
export function requestId(): string {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}`;
}
