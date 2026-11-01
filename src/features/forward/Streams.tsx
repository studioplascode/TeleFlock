import { Cable, Square, SquareTerminal, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { slugify } from "@/core/forward";
import { formatBytes } from "@/core/upload";
import type { ForwardKind, ForwardRule, ForwardStream } from "@/core/gen";
import { Button, Elapsed, Tile } from "@/design";
import { stopStream } from "./actions";
import type { ForwardHost } from "./hosts";

const KINDS: Record<ForwardKind, { label: string; icon: LucideIcon }> = {
  command: { label: "Command", icon: Terminal },
  shell: { label: "Shell", icon: SquareTerminal },
  tool: { label: "Tool", icon: Wrench },
  port: { label: "Port", icon: Cable },
};

/**
 * What is using a forward right now, newest first: the command, shell, tool call or port connection,
 * how long it has run, the bytes each way, and Stop (ends that one stream; the rule stays).
 */
export function Streams({ streams, rules, hosts }: { streams: readonly ForwardStream[]; rules: readonly ForwardRule[]; hosts: readonly ForwardHost[] }) {
  const sorted = [...streams].sort((a, b) => b.startedAt - a.startedAt);
  const nameOf = (id: string) => hosts.find((h) => h.id === id)?.name ?? id;
  return (
    <Tile className="p-4 max-md:p-3.5">
      <h2 className="mb-1 flex items-center gap-2 font-display text-lg font-bold">
        In use now <span className="rounded-full bg-ink/8 px-2 text-xs font-bold text-mute tabular">{streams.length}</span>
      </h2>
      {sorted.length === 0 ? (
        <p className="py-2 text-xs text-mute">Nothing is using a forward right now. Commands, shells, tools and port connections show here while they run.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {sorted.map((s) => {
            const rule = rules.find((r) => r.id === s.ruleId);
            const { label, icon: Icon } = KINDS[s.kind];
            return (
              <li key={s.id} className="flex items-center gap-3 py-2.5 first:pt-1.5 last:pb-0">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent/14 text-accent-hi [&_svg]:size-4" title={label}>
                  <Icon aria-label={label} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm font-semibold text-ink" title={s.label}>
                    {s.label}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-2xs text-mute">
                    <span className="truncate">{rule ? streamRoute(nameOf(rule.fromHost), nameOf(rule.toHost), rule.name) : "forward removed"}</span>
                    <Elapsed since={s.startedAt} />
                    <span className="tabular" title="From the from-host to the to-host, then back">
                      ↑ {formatBytes(s.bytesUp)} ↓ {formatBytes(s.bytesDown)}
                    </span>
                  </div>
                </div>
                <Button size="sm" variant="secondary" icon={<Square className="fill-current" />} onClick={() => stopStream(s.id)} aria-label={`Stop ${s.label}`}>
                  Stop
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}

/** `forge → laptop`, plus the forward's name when it is not the to-host's own (`· gpu`). */
function streamRoute(from: string, to: string, name: string): string {
  return name === slugify(to) ? `${from} → ${to}` : `${from} → ${to} · ${name}`;
}
