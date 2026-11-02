import { FileUp, Hand, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, toast } from "@/design";
import { browserCall, takeOver } from "./actions";
import { browserController, type PendingChooser, type PendingDialog } from "./controller";
import { fileBase64 } from "./frames";
import type { TabOwner } from "./owners";

/** `DOM.setFileInputFiles` takes files on this device: the core stages each picked file, up to 32 MiB. */
const STAGE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A page's alert, confirm, prompt or "leave site?" dialog. On the user's own page it is answered
 * here; on an agent's page the agent answers it (the panel only shows it).
 */
export function DialogOverlay({ dialog, drives, agentName }: { dialog: PendingDialog; drives: boolean; agentName?: string }) {
  const ctl = browserController();
  const [text, setText] = useState(dialog.defaultPrompt ?? "");
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!drives) return;
    if (dialog.type === "prompt") inputRef.current?.select();
    else okRef.current?.focus();
  }, [dialog, drives]);
  let origin = dialog.url;
  try {
    origin = new URL(dialog.url).host || dialog.url;
  } catch {
    // keep the raw address
  }
  const answer = (accept: boolean) => ctl.answerDialog(dialog.tabId, accept, dialog.type === "prompt" ? (accept ? text : undefined) : undefined);
  const leave = dialog.type === "beforeunload";
  return (
    <div className="absolute inset-0 z-raised grid place-items-start justify-center bg-black/25 pt-16">
      <div
        role="alertdialog"
        aria-label={`${origin} says`}
        className="w-[min(28rem,calc(100%-2rem))] rounded-tile bg-[linear-gradient(180deg,var(--color-sheet-1),var(--color-sheet-2))] p-4 shadow-[var(--shadow-d3),inset_0_0_0_1px_var(--color-line-2)]"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (!drives) return;
          if (e.key === "Escape" && dialog.type !== "alert") answer(false);
          if (e.key === "Enter") answer(true);
        }}
      >
        <p className="text-xs font-semibold text-mute">{leave ? "Leave site?" : `${origin} says`}</p>
        <p className="mt-1.5 max-h-48 overflow-y-auto text-sm whitespace-pre-wrap text-ink">{leave ? "Changes you made may not be saved." : dialog.message}</p>
        {dialog.type === "prompt" && drives && (
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-3 h-9 w-full rounded-md bg-well px-3 text-sm text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)] outline-none focus:shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
          />
        )}
        {drives ? (
          <div className="mt-4 flex justify-end gap-2">
            {dialog.type !== "alert" && (
              <Button size="sm" variant="ghost" onClick={() => answer(false)}>
                {leave ? "Stay" : "Cancel"}
              </Button>
            )}
            <Button ref={okRef} size="sm" variant="primary" onClick={() => answer(true)}>
              {leave ? "Leave" : "OK"}
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-mute">{agentName ?? "The agent"} answers this dialog. Take over the tab to answer it yourself.</p>
        )}
      </div>
    </div>
  );
}

/**
 * A page asked for files: the app's own picker opens (the page's click lent it the gesture), and
 * the bar stays as a fallback if the webview refused to open the picker without a fresh click.
 */
export function ChooserBar({ chooser }: { chooser: PendingChooser }) {
  const ctl = browserController();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    inputRef.current?.click();
  }, [chooser]);
  const picked = async (files: FileList | null) => {
    const list = files ? [...files] : [];
    if (list.length === 0) return;
    const big = list.find((f) => f.size > STAGE_MAX_BYTES);
    if (big) {
      toast({ title: `${big.name} is too large`, description: "The browser takes files up to 32 MB from the app.", status: "error" });
      return;
    }
    setBusy(true);
    try {
      const paths: string[] = [];
      for (const f of list) {
        const staged = await browserCall("browser.stageFile", { name: f.name, data: await fileBase64(f) }, `Couldn't hand ${f.name} to the page`);
        if (!staged) return;
        paths.push(staged.path);
      }
      await ctl.setFiles(chooser, paths);
    } catch (e) {
      toast({ title: "Couldn't hand the files to the page", description: e instanceof Error ? e.message : String(e), status: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="absolute inset-x-0 bottom-0 z-raised flex items-center gap-2 border-t border-line bg-tile-3/95 px-3 py-2 text-[13px] shadow-[var(--shadow-d2)]">
      <FileUp className="size-4 shrink-0 text-mute" />
      <span className="min-w-0 flex-1 text-ink-2">The page asks for {chooser.multiple ? "files" : "a file"}.</span>
      <input ref={inputRef} type="file" multiple={chooser.multiple} className="hidden" onChange={(e) => void picked(e.currentTarget.files)} />
      <Button size="sm" variant="primary" loading={busy} onClick={() => inputRef.current?.click()}>
        Choose {chooser.multiple ? "files" : "a file"}…
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => ctl.clearChooser()}>
        Cancel
      </Button>
    </div>
  );
}

export function CrashedNotice({ tabId }: { tabId: string }) {
  return (
    <div className="absolute inset-0 z-raised grid place-items-center bg-tile-1">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <TriangleAlert className="size-8 text-warn" />
        <p className="text-sm font-bold text-ink">This page crashed</p>
        <p className="text-xs text-mute">Its renderer stopped (out of memory, or killed). Reload it to try again.</p>
        <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => browserController().reload(tabId)}>
          Reload
        </Button>
      </div>
    </div>
  );
}

/** An agent's tab: the user watches; Take over lets them drive it (the agent is cut off from it until handed back). */
export function WatchOnly({ tabId, owner }: { tabId: string; owner: Extract<TabOwner, { kind: "agent" }> }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-raised flex justify-center">
      <div className="glass-blur pointer-events-auto flex items-center gap-2.5 rounded-full bg-float/90 py-1.5 pr-1.5 pl-3.5 text-[13px] text-ink-2 shadow-[var(--shadow-d2),inset_0_0_0_1px_var(--color-line-2)]">
        <span>
          {owner.lent ? "Lent to " : "Watching the tab of "}
          <b className="text-ink">{owner.agentName}</b>
        </span>
        <Button size="sm" variant="secondary" icon={<Hand />} onClick={() => void takeOver(tabId)}>
          {owner.lent ? "Take back" : "Take over"}
        </Button>
      </div>
    </div>
  );
}
