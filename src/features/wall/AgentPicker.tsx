import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgent, useColumnKeys, useHosts } from "@/core";
import type { Column } from "@/core/gen";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Popover, PopoverContent, PopoverTrigger, StatusOrb } from "@/design";
import { COLUMN_STATUS } from "@/features/shell/status";
import { agentStateWord, LANE_ORDER, LANE_TITLE } from "@/features/shell/vocab";
import { useWall } from "./store";

function PickerItem({ agentKey, index, onPick }: { agentKey: string; index: number; onPick: () => void }) {
  const agent = useAgent(agentKey);
  const tile = useWall((s) => s.shown.indexOf(agentKey));
  const multiHost = useHosts((h) => h.profiles.length > 1);
  const hostName = useHosts((h) => h.profiles.find((p) => p.id === agent?.hostId)?.name ?? agent?.hostId);
  if (!agent) return null;
  const where = [multiHost && hostName, agent.repo, agent.branch].filter(Boolean).join(" · ");
  return (
    <CommandItem
      value={`${agentKey} ${agent.name} ${agent.title} ${agent.repo ?? ""} ${agent.branch ?? ""} ${hostName ?? ""}`}
      onSelect={() => {
        useWall.getState().place(index, agentKey);
        onPick();
      }}
      icon={tile === index ? <Check className="text-accent-hi" /> : <StatusOrb status={COLUMN_STATUS[agent.column]} size={8} label={null} className="mx-1" />}
      className="h-auto min-h-11 py-1.5"
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-bold text-ink">{agent.name}</span>
        <span className="shrink-0 text-2xs text-mute">{agentStateWord(agent)}</span>
        {tile >= 0 && tile !== index && <span className="ml-auto shrink-0 text-2xs font-bold text-accent-ink">tile {tile + 1} · swaps</span>}
      </span>
      {(agent.title || where) && <span className="block truncate text-2xs font-medium text-mute-2">{[agent.title, where].filter(Boolean).join(" — ")}</span>}
    </CommandItem>
  );
}

function PickerGroup({ column, index, onPick }: { column: Column; index: number; onPick: () => void }) {
  const keys = useColumnKeys(column);
  if (keys.length === 0) return null;
  return (
    <CommandGroup heading={LANE_TITLE[column]}>
      {keys.map((k) => (
        <PickerItem key={k} agentKey={k} index={index} onPick={onPick} />
      ))}
    </CommandGroup>
  );
}

/**
 * "Show here…": every agent by lane, searchable. Picking one pins it to tile `index`; an agent
 * already on the wall trades places with this tile's agent.
 */
export function AgentPicker({ index, children }: { index: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(420px,calc(100vw-24px))] p-0">
        {open && (
          // Every typed word must appear somewhere in the agent's name, title, repo, branch or host.
          <Command loop filter={(item, search) => (search.toLowerCase().split(/\s+/).every((w) => item.toLowerCase().includes(w)) ? 1 : 0)}>
            <CommandInput placeholder={`Show in tile ${index + 1}…`} className="h-11 text-sm" />
            <CommandList className="max-h-[min(380px,55dvh)]">
              <CommandEmpty>No agent matches</CommandEmpty>
              {LANE_ORDER.map((column) => (
                <PickerGroup key={column} column={column} index={index} onPick={() => setOpen(false)} />
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
