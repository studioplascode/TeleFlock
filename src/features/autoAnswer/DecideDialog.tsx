import { Timer } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";
import { parseAgentKey, useCore } from "@/core";
import type { AutoAnswer } from "@/core/gen";
import { Button } from "@/design";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { setAgentAutoAnswer, useAutoAnswerPending } from "./actions";
import { samePolicy } from "./format";
import { useCountdown, useHostAutoAnswer } from "./hooks";
import { PolicyEditor, QUALIFIES_NOTE } from "./PolicyEditor";

/** The agent whose "Decide for me…" dialog is open; `gen` remounts it on every open. */
const useDecideDialog = create<{ agentKey: string | null; gen: number }>(() => ({ agentKey: null, gen: 0 }));

/** "Decide for me…" (card menu, session menu): a running or parked omp agent's own policy. */
export function openDecideDialog(agentKey: string): void {
  useDecideDialog.setState((s) => ({ agentKey, gen: s.gen + 1 }));
}

/** Mounted once by the shell (`app/App.tsx`). */
export function DecideDialog() {
  const agentKey = useDecideDialog((s) => s.agentKey);
  const gen = useDecideDialog((s) => s.gen);
  // keep the last agent while the dialog animates out
  const [shown, setShown] = useState<{ key: string; gen: number } | null>(null);
  if (agentKey && (shown?.key !== agentKey || shown.gen !== gen)) setShown({ key: agentKey, gen });
  if (!shown) return null;
  return <DecideBody key={shown.gen} agentKey={shown.key} open={agentKey !== null} />;
}

function DecideBody({ agentKey, open }: { agentKey: string; open: boolean }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const name = useCore((s) => s.agents[agentKey]?.name ?? agentId);
  const parked = useCore((s) => !!s.agents[agentKey]?.parked);
  // the agent's own policy; undefined: it follows the host default
  const own = useCore((s) => {
    const aa = s.agents[agentKey]?.autoAnswer;
    return aa?.source === "agent" ? aa.policy : undefined;
  }, samePolicy);
  const hostDefault = useHostAutoAnswer(hostId);
  const countdown = useCountdown(agentKey);
  const pending = useAutoAnswerPending(agentKey);
  const [value, setValue] = useState<AutoAnswer | undefined>(own);
  const close = () => useDecideDialog.setState({ agentKey: null });
  const save = async () => {
    if (await setAgentAutoAnswer(agentKey, value)) close();
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={`Decide for me · ${name}`}
      description={QUALIFIES_NOTE}
      icon={<Timer />}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!hostDefault || samePolicy(value, own)} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-4 pb-1">
        {hostDefault ? (
          <PolicyEditor value={value} onChange={setValue} hostDefault={hostDefault} disabled={pending} />
        ) : (
          <p className="text-sm text-mute">Update TeleFlock on this host to use it.</p>
        )}
        {countdown && countdown.view.phase !== "cancelled" && (
          <p className="rounded-md well px-3 py-2 text-xs text-mute">
            Its question now: <span className="font-bold text-ink-2">{countdown.view.text}</span>. A change applies to it at once; the time it has waited counts.
          </p>
        )}
        {parked && <p className="text-xs text-mute">It is parked: the policy goes with it when it resumes.</p>}
      </div>
    </ResponsiveDialog>
  );
}
