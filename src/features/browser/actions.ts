/**
 * The browser's app-core calls (`browser.*`), each reporting a failure as an error toast. The core
 * sends the new status as an `AppEvent::Browser` too, so callers rarely need the result.
 */
import { core, getBrowserStatus, getRoute, navigate, toApiError, useUi } from "@/core";
import type { AppMethods, BrowserClearWhat, BrowserDownload, BrowserScope, BrowserStatus } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { type ToastInput, toast } from "@/design";
import { confirmAction } from "@/features/workspace/shared/overlays";

type BrowserMethod = Extract<keyof AppMethods, `browser.${string}`>;

/** Calls `browser.*`; on failure toasts `failure` with the core's message and resolves null. */
export async function browserCall<M extends BrowserMethod>(method: M, params: AppMethods[M]["params"], failure: string): Promise<AppMethods[M]["result"] | null> {
  try {
    return await core.app(method, params);
  } catch (e) {
    const err = toApiError(e);
    toast({ title: failure, description: err.hint ? `${err.message} — ${err.hint}` : err.message, status: "error", action: blockedAction(err) });
    return null;
  }
}

/** "Use TeleFlock's browser", with the download's size while it isn't there yet. */
export function ownBrowserLabel(download: BrowserDownload | undefined): string {
  return download?.size != null && !download.installed ? `Use TeleFlock's browser (${formatBytes(download.size)})` : "Use TeleFlock's browser";
}

/**
 * A failure toast's button when the browser did not start because the organization's policy blocks
 * the engine and TeleFlock's own browser is on offer (`browser_blocked`): "Use TeleFlock's browser",
 * which downloads it and opens the Browser page, where the download and then the browser show
 * (unless the browser shows already: beside a session, on its page, in Settings).
 */
export function blockedAction(err: unknown): ToastInput["action"] {
  if (toApiError(err).code !== "browser_blocked") return undefined;
  return {
    label: ownBrowserLabel(getBrowserStatus()?.blocked?.download),
    onClick: () => {
      void chooseOwnBrowser();
      const shown = useUi.getState().split?.kind === "browser" || ["browser", "settings"].includes(getRoute().name);
      if (!shown) navigate({ name: "browser" });
    },
  };
}

export function startBrowser(headed?: boolean): Promise<BrowserStatus | null> {
  return browserCall("browser.start", headed == null ? {} : { headed }, "Couldn't start the browser");
}

export function stopBrowser(): Promise<BrowserStatus | null> {
  return browserCall("browser.stop", {}, "Couldn't stop the browser");
}

/**
 * "Let <agent> use my browser". At the cap the core answers `browser_busy`: the user decides
 * whether to attach anyway.
 */
export async function attachAgent(hostId: string, agentId: string, agentName: string): Promise<boolean> {
  try {
    await core.app("browser.attach", { hostId, agentId });
    toast({ title: `${agentName} can use your browser`, description: "Until you detach it.", status: "done", duration: 2600 });
    return true;
  } catch (e) {
    const err = toApiError(e);
    if (err.code === "browser_busy") {
      const ok = await confirmAction({
        title: "Attach anyway?",
        body: `${err.message}. Each agent's tabs take memory; you can also detach one of them first.`,
        confirmLabel: `Let ${agentName} use it`,
      });
      if (!ok) return false;
      return (await browserCall("browser.attach", { hostId, agentId, overCap: true }, `Couldn't attach ${agentName}`)) != null;
    }
    toast({ title: `Couldn't let ${agentName} use your browser`, description: err.hint ? `${err.message} — ${err.hint}` : err.message, status: "error", action: blockedAction(err) });
    return false;
  }
}

export async function detachAgent(hostId: string, agentId: string, agentName: string): Promise<boolean> {
  return (await browserCall("browser.detach", { hostId, agentId }, `Couldn't detach ${agentName}`)) != null;
}

export type RequestChoice = BrowserScope | "deny";

/** Answers an agent's request: Allow for this session (`session`), Allow once (`turn`), Deny. */
export async function answerRequest(requestId: string, choice: RequestChoice, overCap = false): Promise<boolean> {
  const params = choice === "deny" ? { requestId, allow: false } : { requestId, allow: true, scope: choice, ...(overCap ? { overCap: true } : {}) };
  return (await browserCall("browser.answer", params, choice === "deny" ? "Couldn't deny the request" : "Couldn't allow the request")) != null;
}

export function takeOver(targetId: string): Promise<BrowserStatus | null> {
  return browserCall("browser.takeOver", { targetId }, "Couldn't take over the tab");
}

export function handBack(targetId: string): Promise<BrowserStatus | null> {
  return browserCall("browser.handBack", { targetId }, "Couldn't hand the tab back");
}

export function lendTab(targetId: string, hostId: string, agentId: string, agentName: string): Promise<BrowserStatus | null> {
  return browserCall("browser.lendTab", { targetId, hostId, agentId }, `Couldn't let ${agentName} use this tab`);
}

export function revealDownload(path: string): Promise<unknown> {
  return browserCall("browser.revealDownload", { path }, "Couldn't show the download");
}

export function clearBrowsingData(what: BrowserClearWhat): Promise<BrowserStatus | null> {
  return browserCall("browser.clearData", { what }, "Couldn't clear browsing data");
}

/** Downloads Chrome for Testing (about 200 MB); progress and failure arrive in `BrowserStatus.install`. */
export function installEngine(): Promise<BrowserStatus | null> {
  return browserCall("browser.installEngine", {}, "Couldn't start the download");
}

/**
 * "Use TeleFlock's browser" (an engine the organization's policy blocks): downloads Chrome for
 * Testing unless it is there; then the core chooses it and starts the browser with it.
 */
export function chooseOwnBrowser(): Promise<BrowserStatus | null> {
  return browserCall("browser.installEngine", { start: true }, "Couldn't download TeleFlock's browser");
}

export function cancelInstall(): Promise<BrowserStatus | null> {
  return browserCall("browser.cancelInstall", {}, "Couldn't cancel the download");
}

/** Shows the profile folder in the file manager; an older core without the call is told apart from a failure. */
export async function revealProfile(): Promise<boolean> {
  try {
    await core.app("browser.revealProfile", {});
    return true;
  } catch (e) {
    const err = toApiError(e);
    if (err.code === "unknown_method") toast({ title: "This TeleFlock can't show the profile folder", description: "Update the app core to open it from here.", status: "error" });
    else toast({ title: "Couldn't show the profile folder", description: err.hint ? `${err.message} — ${err.hint}` : err.message, status: "error" });
    return false;
  }
}

const CLEAR_COPY: Record<BrowserClearWhat, { title: string; body?: string; confirmLabel?: string; done: string }> = {
  cookies: {
    title: "Clear cookies?",
    body: "This signs you out of every site in the TeleFlock Browser. Agents that use it will need you to sign in again.",
    confirmLabel: "Clear cookies",
    done: "Cookies cleared",
  },
  cache: { title: "Clear the cache?", done: "Cache cleared" },
  everything: {
    title: "Clear everything?",
    body: "This removes your logins, history, site data and settings from the TeleFlock Browser. It restarts with a fresh profile.",
    confirmLabel: "Clear everything",
    done: "Browsing data cleared",
  },
};

/** Clears browsing data after a confirm that names what is lost (the cache is cheap: no confirm). */
export async function clearBrowsingDataConfirmed(what: BrowserClearWhat): Promise<boolean> {
  const copy = CLEAR_COPY[what];
  if (copy.confirmLabel && !(await confirmAction({ title: copy.title, body: copy.body, confirmLabel: copy.confirmLabel, danger: true }))) return false;
  if (!(await clearBrowsingData(what))) return false;
  toast({ title: copy.done, status: "done", duration: 2600 });
  return true;
}
