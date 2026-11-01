import { ArrowRight, ChevronDown, MoreHorizontal, Pencil, Terminal, Trash2, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Chip, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, fadeRise, IconButton, spring, StatusOrb, Switch, Tile, Button } from "@/design";
import { navigate, useCore } from "@/core";
import type { ForwardRule, ForwardStatus, ForwardStream } from "@/core/gen";
import { connect, disconnect } from "@/features/hosts/ConnStatusCard";
import { Commands } from "./Commands";
import { removeRule, setEnabled } from "./actions";
import type { ForwardHost } from "./hosts";
import { buildSnippets, olderThan, statusLook } from "./model";

/** First release of tf-hostd that speaks forwarding. */
const FORWARD_HOSTD = "0.8.0";

function HostName({ host, id }: { host: ForwardHost | undefined; id: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <StatusOrb status={host?.online ? "done" : "idle"} size={7} label={null} />
      <span className="truncate font-display text-md font-bold text-ink">{host?.name ?? id}</span>
    </span>
  );
}

/** What an old host needs: its tf-hostd updates when the app connects to it again. */
function UpdateHosts({ rule, hosts }: { rule: ForwardRule; hosts: readonly ForwardHost[] }) {
  const fromVersion = useCore((s) => s.hosts[rule.fromHost]?.state.info.hostdVersion);
  const toVersion = useCore((s) => s.hosts[rule.toHost]?.state.info.hostdVersion);
  const old = [
    { id: rule.fromHost, version: fromVersion },
    { id: rule.toHost, version: toVersion },
  ].filter((h) => olderThan(h.version, FORWARD_HOSTD));
  return (
    <>
      {old.map((h) => {
        const name = hosts.find((x) => x.id === h.id)?.name ?? h.id;
        return (
          <Button key={h.id} size="sm" variant="secondary" onClick={() => void disconnect(h.id).then(() => connect(h.id))}>
            Reconnect {name} (tf-hostd {h.version})
          </Button>
        );
      })}
    </>
  );
}

export interface RuleCardProps {
  rule: ForwardRule;
  status: ForwardStatus | undefined;
  streams: readonly ForwardStream[];
  hosts: readonly ForwardHost[];
  index: number;
  /** Start with the commands open (the only rule). */
  openUse?: boolean;
  onEdit(): void;
}

/** One forward: from → to, what it offers, its status, and (opened) how to use it from the from-host. */
export function RuleCard({ rule, status, streams, hosts, index, openUse, onEdit }: RuleCardProps) {
  const [use, setUse] = useState(openUse ?? false);
  const from = hosts.find((h) => h.id === rule.fromHost);
  const to = hosts.find((h) => h.id === rule.toHost);
  const look = statusLook(status);
  const fromName = from?.name ?? rule.fromHost;
  const toName = to?.name ?? rule.toHost;
  const fromOs = useCore((s) => s.hosts[rule.fromHost]?.state.info.os);
  const toOs = useCore((s) => s.hosts[rule.toHost]?.state.info.os);
  const note =
    status?.state === "unsupported"
      ? (status.message ?? "tf-hostd on one of these hosts is older than 0.8.0. It updates when TeleFlock connects to it again.")
      : status?.state === "waiting" || status?.state === "error"
        ? status.message
        : undefined;
  const fromWindows = fromOs?.toLowerCase().includes("windows") ?? false;
  const snippets = buildSnippets(rule, { fromName, toName, fromWindows });
  const portErrors = status?.portErrors ?? [];
  const off = !rule.enabled;
  return (
    <motion.div {...fadeRise} transition={{ ...spring.smooth, delay: index * 0.05 }} className="min-w-0">
      <Tile className={cn("flex flex-col gap-3 p-4 max-md:p-3.5", off && "opacity-80")}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <HostName host={from} id={rule.fromHost} />
              <ArrowRight className="size-4 shrink-0 text-mute-2" aria-label="uses" />
              <HostName host={to} id={rule.toHost} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Chip className="font-mono" icon={<Terminal />}>
                tf-forward {rule.name}
              </Chip>
              <Chip tone={look.tone} aria-label={`Status: ${look.label}`}>
                {look.label}
              </Chip>
              {streams.length > 0 && <Chip tone="running">{streams.length} in use</Chip>}
            </div>
          </div>
          <Switch checked={rule.enabled} onCheckedChange={(on) => setEnabled(rule, on)} label={`${rule.name} is on`} className="mt-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`More for ${rule.name}`} size="sm">
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem danger icon={<Trash2 />} onSelect={() => removeRule(rule)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-mute">
          {rule.shell && <Chip>Shell</Chip>}
          {rule.tools.map((t) => (
            <Chip key={t} tone="accent" className="font-mono">
              {t}
            </Chip>
          ))}
          {rule.ports.map((p) => (
            <Chip key={p.listen} className="font-mono">
              :{p.listen} → :{p.target}
            </Chip>
          ))}
          {!rule.shell && rule.tools.length === 0 && rule.ports.length === 0 && <span>Nothing offered yet.</span>}
        </div>

        {note && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className={cn("min-w-0 flex-1 basis-60 text-xs font-semibold", status?.state === "error" ? "text-error" : "text-mute")}>{note}</p>
            {status?.state === "unsupported" && <UpdateHosts rule={rule} hosts={hosts} />}
            {status?.state === "waiting" && (
              <Button size="sm" variant="secondary" onClick={() => navigate({ name: "hosts" })}>
                Open Hosts
              </Button>
            )}
          </div>
        )}
        {portErrors.length > 0 && (
          <ul className="flex flex-col gap-1">
            {portErrors.map((e) => (
              <li key={e.listen} className="flex items-start gap-2 text-xs font-semibold text-warn">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-mono">{fromName}:{e.listen}</span> isn't listening: {e.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div>
          <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-expanded={use}
            onClick={() => setUse((v) => !v)}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-sm text-xs font-bold text-accent-hi pressable focus-ring"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", !use && "-rotate-90")} />
            How to use it from {fromName}
          </button>
          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={onEdit}>
            Edit
          </Button>
          </div>
          <AnimatePresence initial={false}>
            {use && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring.smooth} className="overflow-hidden">
                <Commands snippets={snippets} fromName={fromName} toName={toName} fromWindows={fromWindows} toWindows={toOs?.toLowerCase().includes("windows")} className="pt-2" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Tile>
    </motion.div>
  );
}
