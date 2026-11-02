/**
 * The part of the Chrome DevTools Protocol the browser panel uses (tot protocol, Chrome ≥ 120).
 * Only fields read or sent here are declared; the browser sends more.
 */

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
  browserContextId?: string;
}

export interface ScreencastFrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  /** Width and height of the page viewport in CSS pixels. */
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  /** Seconds since the epoch. */
  timestamp?: number;
}

export interface NavigationEntry {
  id: number;
  url: string;
  title: string;
  /** `typed`, `link`, `reload`, `form_submit`, `auto_bookmark`, … */
  transitionType?: string;
}

export interface RemoteObject {
  type: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

export interface ExceptionDetails {
  text: string;
  url?: string;
  lineNumber: number;
  columnNumber: number;
  exception?: RemoteObject;
}

export type MouseType = "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
export type MouseButtonName = "none" | "left" | "middle" | "right" | "back" | "forward";

export interface MouseEventParams {
  type: MouseType;
  x: number;
  y: number;
  modifiers: number;
  button: MouseButtonName;
  buttons: number;
  clickCount: number;
  deltaX?: number;
  deltaY?: number;
  pointerType?: "mouse" | "pen";
}

export type KeyType = "keyDown" | "keyUp" | "rawKeyDown" | "char";

export interface KeyEventParams {
  type: KeyType;
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode?: number;
  text?: string;
  unmodifiedText?: string;
  location?: number;
  isKeypad?: boolean;
  autoRepeat?: boolean;
  /** macOS editing commands (`selectAll`, `undo`, …): Chrome on a Mac runs them instead of the key's default. */
  commands?: string[];
}

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export type DownloadState = "inProgress" | "completed" | "canceled";

type Empty = Record<string, never>;

/** Commands: params and result. */
export interface CdpCommands {
  "Browser.getVersion": { params: Empty; result: { product: string; userAgent: string } };
  "Browser.setDownloadBehavior": {
    params: { behavior: "deny" | "allow" | "allowAndName" | "default"; downloadPath?: string; eventsEnabled?: boolean };
    result: Empty;
  };
  "Browser.cancelDownload": { params: { guid: string }; result: Empty };
  "Target.setDiscoverTargets": { params: { discover: boolean }; result: Empty };
  "Target.getTargets": { params: Empty; result: { targetInfos: TargetInfo[] } };
  "Target.attachToTarget": { params: { targetId: string; flatten: true }; result: { sessionId: string } };
  "Target.detachFromTarget": { params: { sessionId: string }; result: Empty };
  "Target.createTarget": { params: { url: string; background?: boolean; newWindow?: boolean }; result: { targetId: string } };
  "Target.closeTarget": { params: { targetId: string }; result: { success?: boolean } };
  "Target.activateTarget": { params: { targetId: string }; result: Empty };
  "Page.enable": { params: Empty; result: Empty };
  "Page.setInterceptFileChooserDialog": { params: { enabled: boolean }; result: Empty };
  "Page.startScreencast": {
    params: { format: "jpeg" | "png"; quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number };
    result: Empty;
  };
  "Page.stopScreencast": { params: Empty; result: Empty };
  "Page.screencastFrameAck": { params: { sessionId: number }; result: Empty };
  "Page.navigate": { params: { url: string }; result: { frameId: string; errorText?: string } };
  "Page.reload": { params: { ignoreCache?: boolean }; result: Empty };
  "Page.stopLoading": { params: Empty; result: Empty };
  "Page.getNavigationHistory": { params: Empty; result: { currentIndex: number; entries: NavigationEntry[] } };
  "Page.navigateToHistoryEntry": { params: { entryId: number }; result: Empty };
  "Page.handleJavaScriptDialog": { params: { accept: boolean; promptText?: string }; result: Empty };
  "Page.captureScreenshot": { params: { format: "png" | "jpeg"; quality?: number }; result: { data: string } };
  "Emulation.setDeviceMetricsOverride": {
    params: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
    result: Empty;
  };
  "Emulation.clearDeviceMetricsOverride": { params: Empty; result: Empty };
  "Emulation.setFocusEmulationEnabled": { params: { enabled: boolean }; result: Empty };
  "Input.dispatchMouseEvent": { params: MouseEventParams; result: Empty };
  "Input.dispatchKeyEvent": { params: KeyEventParams; result: Empty };
  "Input.insertText": { params: { text: string }; result: Empty };
  "Input.imeSetComposition": { params: { text: string; selectionStart: number; selectionEnd: number }; result: Empty };
  "Runtime.evaluate": {
    params: { expression: string; contextId?: number; returnByValue?: boolean; awaitPromise?: boolean; silent?: boolean };
    result: { result: RemoteObject; exceptionDetails?: ExceptionDetails };
  };
  "Page.createIsolatedWorld": { params: { frameId: string; worldName: string }; result: { executionContextId: number } };
  "Runtime.enable": { params: Empty; result: Empty };
  "Runtime.disable": { params: Empty; result: Empty };
  "Log.enable": { params: Empty; result: Empty };
  "Log.disable": { params: Empty; result: Empty };
  "Network.enable": { params: Empty; result: Empty };
  "Network.disable": { params: Empty; result: Empty };
  "Network.loadNetworkResource": {
    params: { frameId: string; url: string; options: { disableCache: boolean; includeCredentials: boolean } };
    result: { resource: { success: boolean; httpStatusCode?: number; stream?: string; netErrorName?: string; headers?: Record<string, string> } };
  };
  "IO.read": { params: { handle: string; size?: number }; result: { base64Encoded?: boolean; data: string; eof: boolean } };
  "IO.close": { params: { handle: string }; result: Empty };
  "Network.getResponseBody": { params: { requestId: string }; result: { body: string; base64Encoded: boolean } };
  "DOM.setFileInputFiles": { params: { files: string[]; backendNodeId: number }; result: Empty };
}

export interface StackTrace {
  callFrames: { functionName: string; url: string; lineNumber: number; columnNumber: number }[];
}

/** Events: params. */
export interface CdpEvents {
  "Target.targetCreated": { targetInfo: TargetInfo };
  "Target.targetInfoChanged": { targetInfo: TargetInfo };
  "Target.targetDestroyed": { targetId: string };
  "Target.targetCrashed": { targetId: string; status: string; errorCode: number };
  "Target.detachedFromTarget": { sessionId: string; targetId?: string };
  "Page.screencastFrame": { data: string; metadata: ScreencastFrameMetadata; sessionId: number };
  "Page.frameNavigated": { frame: { id: string; parentId?: string; url: string; urlFragment?: string }; type?: string };
  "Page.navigatedWithinDocument": { frameId: string; url: string };
  "Page.frameStartedLoading": { frameId: string };
  "Page.frameStoppedLoading": { frameId: string };
  "Page.loadEventFired": { timestamp: number };
  "Page.javascriptDialogOpening": { url: string; message: string; type: DialogType; defaultPrompt?: string };
  "Page.javascriptDialogClosed": { result: boolean; userInput: string };
  "Page.fileChooserOpened": { frameId: string; mode: "selectSingle" | "selectMultiple"; backendNodeId?: number };
  "Browser.downloadWillBegin": { frameId: string; guid: string; url: string; suggestedFilename: string };
  "Browser.downloadProgress": { guid: string; totalBytes: number; receivedBytes: number; state: DownloadState; filePath?: string };
  "Runtime.consoleAPICalled": { type: string; args: RemoteObject[]; timestamp: number; stackTrace?: StackTrace };
  "Runtime.exceptionThrown": { timestamp: number; exceptionDetails: ExceptionDetails & { stackTrace?: StackTrace } };
  "Log.entryAdded": { entry: { source: string; level: string; text: string; url?: string; lineNumber?: number; stackTrace?: StackTrace } };
  "Network.requestWillBeSent": { requestId: string; request: { url: string; method: string }; type?: string };
  "Network.responseReceived": { requestId: string; type?: string; response: { url: string; status: number; statusText?: string } };
  "Network.loadingFailed": { requestId: string; errorText: string; canceled?: boolean; type?: string };
  "Network.loadingFinished": { requestId: string };
}

export type CdpMethod = keyof CdpCommands;
export type CdpEvent = keyof CdpEvents;
