import { PanelTopClose, Pencil, SquareX, X } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { core, toApiError } from "@/core";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  Input,
  toast,
} from "@/design";
import { haptic } from "@/features/shell/haptics";

/** One herdr pane as listed in the terminal tab strip. */
export interface TabTarget {
  paneId: string;
  tabId: string;
  tabLabel: string;
  /** What the strip shows for this pane. */
  label: string;
  /** Pane hosts an agent: closing it is offered from the agent's own controls, not here. */
  hasAgent: boolean;
  /** Panes in the same herdr tab (Close tab closes them all). */
  tabPaneCount: number;
}

type Pending = { kind: "rename"; t: TabTarget } | { kind: "closeTab"; t: TabTarget } | { kind: "closePane"; t: TabTarget } | null;

export interface TabActionsProps {
  hostId: string;
  target: TabTarget;
  /** Called after the pane (or its whole tab) was closed. */
  onClosed(paneIds: string[]): void;
  /** Panes of the target's herdr tab (for Close tab). */
  tabPaneIds: string[];
  children: ReactNode;
}

async function run(what: string, call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    haptic("success");
    return true;
  } catch (e) {
    const err = toApiError(e);
    toast({ title: `${what} failed`, description: err.hint ?? err.message, status: "error" });
    return false;
  }
}

/** Right-click (long-press on touch) menu for a terminal tab: rename / close tab / close pane. */
export function TabActions({ hostId, target, onClosed, tabPaneIds, children }: TabActionsProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const host = core.host(hostId);

  const close = () => {
    if (!busy) setPending(null);
  };

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    if (pending?.kind !== "rename") return;
    const next = label.trim();
    if (!next || next === pending.t.tabLabel) return setPending(null);
    setBusy(true);
    const ok = await run("Rename tab", () => host.call("tab.rename", { tabId: pending.t.tabId, label: next }));
    setBusy(false);
    if (ok) setPending(null);
  };

  const confirmClose = async () => {
    if (pending?.kind !== "closeTab" && pending?.kind !== "closePane") return;
    setBusy(true);
    const ok =
      pending.kind === "closeTab"
        ? await run("Close tab", () => host.call("tab.close", { tabId: pending.t.tabId }))
        : await run("Close pane", () => host.call("pane.close", { paneId: pending.t.paneId }));
    setBusy(false);
    if (!ok) return;
    onClosed(pending.kind === "closeTab" ? tabPaneIds : [pending.t.paneId]);
    setPending(null);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>
            Tab {target.tabLabel} · {target.paneId}
          </ContextMenuLabel>
          <ContextMenuItem
            icon={<Pencil />}
            onSelect={() => {
              setLabel(target.tabLabel);
              setPending({ kind: "rename", t: target });
            }}
          >
            Rename tab…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon={<PanelTopClose />} danger onSelect={() => setPending({ kind: "closeTab", t: target })}>
            Close tab{target.tabPaneCount > 1 ? ` (${target.tabPaneCount} panes)` : ""}…
          </ContextMenuItem>
          {!target.hasAgent && (
            <ContextMenuItem icon={<SquareX />} danger onSelect={() => setPending({ kind: "closePane", t: target })}>
              Close pane…
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={pending?.kind === "rename"} onOpenChange={(o) => !o && close()}>
        {pending?.kind === "rename" && (
          <DialogContent
            title="Rename tab"
            description={`herdr tab ${pending.t.tabId}`}
            icon={<Pencil />}
            width={420}
            footer={
              <>
                <Button variant="ghost" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" form="tf-tab-rename" loading={busy} disabled={!label.trim()}>
                  Rename
                </Button>
              </>
            }
          >
            <form id="tf-tab-rename" onSubmit={(e) => void submitRename(e)}>
              <Input autoFocus value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} aria-label="Tab name" placeholder="Tab name" />
            </form>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={pending?.kind === "closeTab" || pending?.kind === "closePane"} onOpenChange={(o) => !o && close()}>
        {(pending?.kind === "closeTab" || pending?.kind === "closePane") && (
          <DialogContent
            title={pending.kind === "closeTab" ? `Close tab “${pending.t.tabLabel}”?` : `Close pane ${pending.t.paneId}?`}
            description={
              pending.kind === "closeTab"
                ? `Ends every process in its ${pending.t.tabPaneCount === 1 ? "pane" : `${pending.t.tabPaneCount} panes`}${pending.t.hasAgent || pending.t.tabPaneCount > 1 ? ", including any agents running there" : ""}. This can't be undone.`
                : `Ends the shell running in “${pending.t.label}”. This can't be undone.`
            }
            icon={<X />}
            width={440}
            footer={
              <>
                <Button variant="ghost" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="danger" loading={busy} onClick={() => void confirmClose()} data-autofocus>
                  {pending.kind === "closeTab" ? "Close tab" : "Close pane"}
                </Button>
              </>
            }
          />
        )}
      </Dialog>
    </>
  );
}
