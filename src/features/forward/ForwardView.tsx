import { Cable, Info, Plus, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button, cn, EmptyState, IconButton, isAndroid, PageHeader, Tile, useIsMobile } from "@/design";
import { navigate, useForwards, useUi } from "@/core";
import type { ForwardRule } from "@/core/gen";
import { MobileHeader } from "@/features/shell/MobileHeader";
import { useForwardHosts } from "./hosts";
import { RuleCard } from "./RuleCard";
import { RuleEditor } from "./RuleEditor";
import { Streams } from "./Streams";

const DESCRIPTION = "Let the agents and shells on one host use another: run commands there, call its tools by name, reach its ports. This device relays, so it has to be connected to both. Everything on the from host, its agents included, then acts as you on the to host, and a forwarded port is open to every account on the from host (like ssh -L; on Linux only your own user can connect, on macOS and Windows any local account).";

/** Typical pairs, so a first rule is easy to picture. */
const EXAMPLES: readonly { from: string; to: string; what: string }[] = [
  { from: "A remote dev box", to: "This computer", what: "its agents open agent-browser headed on your screen, or run any command here" },
  { from: "A WSL host", to: "The Windows host on the same PC", what: "an agent in WSL uses the browser and tools on Windows" },
];

function Notes() {
  return (
    <div className="flex flex-col gap-2 text-xs text-mute">
      <p className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
        <span>A forward lets everything on the from host, its agents included, act as you on the to host. Each one is opt-in, off until saved, and visible while in use.</span>
      </p>
      {isAndroid && (
        <p className="flex items-start gap-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-accent-hi" />
          <span>
            Forwards only work while TeleFlock is running and connected to both hosts. Turn on{" "}
            <button type="button" className="font-bold text-accent-hi underline decoration-accent-hi/40 underline-offset-2 focus-ring" onClick={() => navigate({ name: "settings" })}>
              Stay connected in the background
            </button>{" "}
            in Settings to keep them going with the app closed.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Forwarding (`#/forward`): the rules saved on this device, each with its status and how to use it from the
 * from-host, and what is using them right now. Needs two hosts; the list stays usable with hosts that are
 * offline (status Waiting) or older (Update needed).
 */
export function ForwardView() {
  const mobile = useIsMobile();
  const hosts = useForwardHosts();
  const forwards = useForwards();
  const { openDialog } = useUi();
  const [editor, setEditor] = useState<{ rule?: ForwardRule; key: number } | null>(null);
  const rules = forwards?.rules ?? [];
  const streams = forwards?.streams ?? [];
  const enough = hosts.length >= 2;
  const open = (rule?: ForwardRule) => setEditor({ rule, key: Date.now() });

  const add = enough ? (
    <Button variant="primary" size={mobile ? "sm" : "md"} icon={<Plus />} onClick={() => open()}>
      New forward
    </Button>
  ) : null;

  return (
    <div className="flex min-h-full flex-col">
      {mobile && (
        <MobileHeader
          title="Forwarding"
          subtitle={enough ? `${rules.length} forward${rules.length === 1 ? "" : "s"} · ${streams.length} in use` : undefined}
          back
          actions={enough ? <IconButton label="New forward" onClick={() => open()}><Plus /></IconButton> : undefined}
        />
      )}
      <div className={cn("mx-auto grid w-full max-w-[880px] grid-cols-[minmax(0,1fr)] content-start", mobile ? "gap-3 px-3 pt-1 pb-6" : "gap-4 px-8 pt-7 pb-12")}>
        {!mobile && <PageHeader kicker="Between hosts" title="Forwarding" description={DESCRIPTION} actions={add} className="mb-1" />}
        {mobile && <p className="px-1 text-xs text-mute">{DESCRIPTION}</p>}

        {!enough ? (
          <Tile>
            <EmptyState
              icon={<Cable />}
              title="Forwarding needs two hosts"
              description={
                hosts.length === 0
                  ? "A forward lets one host use another, so add the host where your agents run and the one whose tools they need: your own computer, say."
                  : `You have one host (${hosts[0]?.name}). Add a second: the host where your agents run, or the one whose tools and browser they should use.`
              }
              action={
                <Button variant="primary" icon={<Plus />} onClick={() => openDialog({ kind: "hostEditor" })}>
                  Add host
                </Button>
              }
            />
          </Tile>
        ) : (
          <>
            {rules.length === 0 ? (
              <Tile>
                <EmptyState
                  icon={<Cable />}
                  title="No forwards yet"
                  description="Pick the host whose agents need something, the host that has it, and what to share: a shell, tools like agent-browser, or ports."
                  action={add}
                />
                <ul className="mx-auto flex max-w-md flex-col gap-2 px-5 pb-6 text-xs text-mute">
                  {EXAMPLES.map((x) => (
                    <li key={x.from} className="rounded-md bg-ink/[0.03] px-3 py-2 shadow-hairline">
                      <span className="font-bold text-ink-2">{x.from}</span> → <span className="font-bold text-ink-2">{x.to}</span>: {x.what}.
                    </li>
                  ))}
                </ul>
              </Tile>
            ) : (
              <>
                {rules.map((rule, i) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    status={forwards?.status.find((s) => s.id === rule.id)}
                    streams={streams.filter((s) => s.ruleId === rule.id)}
                    hosts={hosts}
                    index={i}
                    openUse={rules.length === 1}
                    onEdit={() => open(rule)}
                  />
                ))}
                <Streams streams={streams} rules={rules} hosts={hosts} />
              </>
            )}
            <Notes />
          </>
        )}
      </div>
      {editor && <RuleEditor key={editor.key} open onOpenChange={(o) => !o && setEditor(null)} hosts={hosts} rules={rules} rule={editor.rule} />}
    </div>
  );
}
