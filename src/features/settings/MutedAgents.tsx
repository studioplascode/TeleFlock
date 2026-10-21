import { BellOff, BellRing } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { AgentGlyph, Button, spring, toast } from "@/design";
import { parseAgentKey, useAgent, useHosts, useSettings } from "@/core";
import { errorMessage } from "@/features/shell/errors";
import { haptic } from "@/features/shell/haptics";
import { Section } from "./parts";

function MutedRow({ agentKey, onUnmute }: { agentKey: string; onUnmute: () => void }) {
  const agent = useAgent(agentKey);
  const { hostId, agentId } = parseAgentKey(agentKey);
  const hostName = useHosts((h) => h.profiles.find((p) => p.id === hostId)?.name ?? hostId);
  const name = agent?.name ?? agentId;
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
      transition={spring.smooth}
      className="flex items-center gap-3 py-2.5"
    >
      <AgentGlyph name={name} size={30} className={agent ? undefined : "opacity-50 saturate-0"} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-ink">{name}</div>
        <div className="truncate text-xs text-mute">{agent ? [hostName, agent.title].filter(Boolean).join(" · ") : `${hostName} · no longer running`}</div>
      </div>
      <Button size="sm" variant="secondary" icon={<BellRing />} onClick={onUnmute}>
        Unmute
      </Button>
    </motion.li>
  );
}

/** Agents whose notifications are silenced, with one-tap unmute. */
export function MutedAgents({ index }: { index: number }) {
  const muted = useSettings((s) => s.mutedAgents);
  const setMuted = useSettings((s) => s.setMuted);
  const unmute = (key: string) => {
    haptic("tick");
    setMuted(key, false).catch((err: unknown) => toast({ title: `Couldn't unmute: ${errorMessage(err)}`, status: "error" }));
  };
  return (
    <Section index={index} icon={<BellOff />} title="Muted agents" description="These agents never notify you or play a sound. Their cards still show on the board.">
      {muted.length === 0 ? (
        <p className="py-2 text-sm text-mute-2">No muted agents. Mute a noisy one from its card or session menu.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          <AnimatePresence initial={false}>
            {muted.map((key) => (
              <MutedRow key={key} agentKey={key} onUnmute={() => unmute(key)} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Section>
  );
}
