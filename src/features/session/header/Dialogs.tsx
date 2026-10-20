import { Layers, Pause, Pencil, Play, Send, SquarePlus, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { parseAgentKey, useSession } from "@/core";
import { Button, Dialog, DialogContent, Field, formatCompact, Input, ProgressRing, Textarea } from "@/design";
import { hostCall, usePending } from "../api";
import { useSessionUi } from "../state";

/** All modal dialogs of a session, driven by `useSessionUi().dialog[key]`. Mount once per session. */
export function SessionDialogs({ agentKey }: { agentKey: string }) {
  const dialog = useSessionUi((s) => s.dialog[agentKey] ?? null);
  const close = () => useSessionUi.getState().openDialog(agentKey, null);
  const onOpenChange = (o: boolean) => !o && close();
  return (
    <>
      <Dialog open={dialog === "goal"} onOpenChange={onOpenChange}>
        {dialog === "goal" && <GoalContent agentKey={agentKey} close={close} />}
      </Dialog>
      <Dialog open={dialog === "rename"} onOpenChange={onOpenChange}>
        {dialog === "rename" && <RenameContent agentKey={agentKey} close={close} />}
      </Dialog>
      <Dialog open={dialog === "compact" || dialog === "handoff"} onOpenChange={onOpenChange}>
        {(dialog === "compact" || dialog === "handoff") && <CompactContent agentKey={agentKey} handoff={dialog === "handoff"} close={close} />}
      </Dialog>
      <Dialog open={dialog === "newSession"} onOpenChange={onOpenChange}>
        {dialog === "newSession" && <NewSessionContent agentKey={agentKey} close={close} />}
      </Dialog>
    </>
  );
}

function GoalContent({ agentKey, close }: { agentKey: string; close: () => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const goal = meta?.goal;
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [budget, setBudget] = useState(goal?.budget != null ? String(goal.budget) : "");
  const [busy, run] = usePending();
  const budgetN = budget.trim() === "" ? undefined : Number.parseInt(budget.replace(/[_,\s]/g, ""), 10);
  const budgetValid = budgetN === undefined || (Number.isFinite(budgetN) && budgetN > 0);
  const act = async (op: "set" | "pause" | "resume" | "drop" | "budget") => {
    const res = await run(
      hostCall(
        hostId,
        "agent.goal",
        { agentId, op, objective: op === "set" ? objective.trim() : undefined, budget: op === "set" || op === "budget" ? budgetN : undefined },
        { success: op === "set" ? "Goal set" : op === "budget" ? "Budget updated" : `Goal ${op === "drop" ? "dropped" : `${op}d`}` },
      ),
    );
    if (res.ok) close();
  };
  return (
    <DialogContent
      icon={<Target />}
      title={goal ? "Goal" : "Set a goal"}
      description={goal ? `omp keeps working toward this objective${goal.status === "paused" ? " (paused)" : ""}.` : "omp works autonomously toward the objective until it's met or the token budget runs out."}
      footer={
        goal ? (
          <>
            <Button variant="danger" icon={<Trash2 />} onClick={() => void act("drop")} disabled={busy}>
              Drop
            </Button>
            {goal.status === "paused" ? (
              <Button icon={<Play />} onClick={() => void act("resume")} disabled={busy}>
                Resume
              </Button>
            ) : (
              <Button icon={<Pause />} onClick={() => void act("pause")} disabled={busy}>
                Pause
              </Button>
            )}
            <Button variant="primary" onClick={() => void act(objective.trim() !== goal.objective ? "set" : "budget")} disabled={busy || !budgetValid || !objective.trim()} loading={busy}>
              Save
            </Button>
          </>
        ) : (
          <Button variant="primary" icon={<Target />} onClick={() => void act("set")} disabled={busy || !objective.trim() || !budgetValid} loading={busy}>
            Start goal
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {goal && goal.budget != null && goal.tokensUsed != null && (
          <div className="flex items-center gap-3 rounded-lg well px-3 py-2.5">
            <ProgressRing done={goal.tokensUsed} total={goal.budget} size={44} label={`${Math.round((goal.tokensUsed / goal.budget) * 100)}%`} status={goal.status === "active" ? "running" : "idle"} />
            <div className="text-sm">
              <div className="font-bold tabular">
                {formatCompact(goal.tokensUsed)} / {formatCompact(goal.budget)} tokens
              </div>
              <div className="text-xs text-mute">budget used</div>
            </div>
          </div>
        )}
        <Field label="Objective" description="Be concrete about what done looks like.">
          {(id) => <Textarea id={id} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="e.g. Make every test in src/board pass and open a PR" autoFocus maxHeight={200} />}
        </Field>
        <Field label="Token budget" hint="optional" error={budgetValid ? undefined : "Enter a positive number of tokens"}>
          {(id) => <Input id={id} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 2000000 (empty = no budget)" invalid={!budgetValid} />}
        </Field>
      </div>
    </DialogContent>
  );
}

function RenameContent({ agentKey, close }: { agentKey: string; close: () => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const [title, setTitle] = useState(meta?.title ?? "");
  const [busy, run] = usePending();
  const submit = async () => {
    if (!title.trim()) return;
    const res = await run(hostCall(hostId, "agent.rename", { agentId, title: title.trim() }, { success: "Session renamed" }));
    if (res.ok) close();
  };
  return (
    <DialogContent
      icon={<Pencil />}
      title="Rename session"
      width={480}
      footer={
        <Button variant="primary" onClick={() => void submit()} disabled={!title.trim() || busy} loading={busy}>
          Rename
        </Button>
      }
    >
      <Field label="Title">
        {(id) => (
          <Input
            id={id}
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        )}
      </Field>
    </DialogContent>
  );
}

function CompactContent({ agentKey, handoff, close }: { agentKey: string; handoff: boolean; close: () => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const { meta } = useSession(agentKey);
  const [focus, setFocus] = useState("");
  const [busy, run] = usePending();
  const submit = async () => {
    const instructions = focus.trim() || undefined;
    const res = await run(
      handoff
        ? hostCall(hostId, "agent.handoff", { agentId, instructions }, { success: "Handoff started" })
        : hostCall(hostId, "agent.compact", { agentId, instructions }, { success: "Compacting…" }),
    );
    if (res.ok) close();
  };
  return (
    <DialogContent
      icon={handoff ? <Send /> : <Layers />}
      title={handoff ? "Handoff" : "Compact context"}
      description={
        handoff
          ? "Summarise the session and continue in a fresh context. omp refuses while a turn is streaming."
          : `Summarise older turns to free context${meta?.context ? ` (now ${meta.context.pct}% of ${formatCompact(meta.context.window)})` : ""}.`
      }
      width={520}
      footer={
        <Button variant="primary" onClick={() => void submit()} loading={busy}>
          {handoff ? "Hand off" : "Compact"}
        </Button>
      }
    >
      <Field label="Focus" hint="optional">
        {(id) => <Textarea id={id} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="What should the summary keep? e.g. the API decisions and open bugs" autoFocus maxHeight={160} />}
      </Field>
    </DialogContent>
  );
}

function NewSessionContent({ agentKey, close }: { agentKey: string; close: () => void }) {
  const { hostId, agentId } = parseAgentKey(agentKey);
  const [busy, run] = usePending();
  const submit = async () => {
    const res = await run(hostCall(hostId, "agent.newSession", { agentId }, { success: "New session started" }));
    if (res.ok) close();
  };
  return (
    <DialogContent
      icon={<SquarePlus />}
      title="Start a new session?"
      description="omp starts a fresh session file in this pane. The current session stays on disk and can be resumed later."
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            New session
          </Button>
        </>
      }
    />
  );
}
