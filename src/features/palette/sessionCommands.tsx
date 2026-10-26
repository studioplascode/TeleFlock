import {
  Brain,
  ClipboardList,
  Cpu,
  FileDown,
  GitFork,
  MessageCircleQuestion,
  Minimize2,
  Pause,
  Play,
  Rocket,
  SquarePen,
  SquarePlus,
  SquareSlash,
  Target,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { agentKey, core, navigate, useUi } from "@/core";
import { MOBILE_MAX_WIDTH, toast } from "@/design";
import { openTerminal } from "@/features/board/agentActions";
import { runSlash } from "@/features/session/composer/slash";
import type { Agent } from "@/core/gen";
import { errorHint, errorMessage } from "@/features/shell/errors";
import { GLOSSARY } from "@/features/shell/glossary";
import { haptic } from "@/features/shell/haptics";
import { ACTIONS } from "@/features/shell/vocab";

/** A palette sub-page that collects an argument. */
export type PalettePage =
  | { kind: "model"; hostId: string; agentId: string }
  | { kind: "thinking"; hostId: string; agentId: string }
  | { kind: "text"; title: string; placeholder: string; submitLabel: string; run: (text: string) => Promise<unknown>; allowEmpty?: boolean };

export interface SessionCommand {
  id: string;
  title: string;
  keywords: string[];
  icon: ReactNode;
  hint?: string;
  /** Either run directly, or open a page to collect an argument. */
  run?: () => Promise<unknown>;
  page?: PalettePage;
}

/** Run a host call with success/failure toasts. */
export function hostCall<T>(label: string, p: Promise<T>, success?: (r: T) => string | undefined): Promise<T | undefined> {
  return p.then(
    (r) => {
      haptic("success");
      toast({ title: success?.(r) ?? label, status: "done" });
      return r;
    },
    (err: unknown) => {
      haptic("warning");
      toast({ title: `${label} failed: ${errorMessage(err)}`, description: errorHint(err), status: "error" });
      return undefined;
    },
  );
}

/**
 * Slash-style commands for one session, each mapped to its precise host method. Commands that
 * need an omp session are only offered for omp agents.
 */
export function sessionCommands(hostId: string, agent: Agent): SessionCommand[] {
  const h = core.host(hostId);
  const agentId = agent.id;
  const omp = agent.omp;
  if (!omp) return [];
  const plan = omp.mode !== "normal";
  const goal = omp.goal;
  return [
    { id: "model", title: "Switch model…", keywords: ["/switch", "/model", "provider"], icon: <Cpu />, hint: omp.model ? `${omp.model.provider}/${omp.model.id}` : undefined, page: { kind: "model", hostId, agentId } },
    { id: "thinking", title: "Thinking level…", keywords: ["/effort", "reasoning", "think"], icon: <Brain />, hint: omp.thinking, page: { kind: "thinking", hostId, agentId } },
    {
      id: "plan",
      title: plan ? "Leave plan mode" : "Enter plan mode",
      keywords: ["/plan", "mode"],
      icon: <ClipboardList />,
      hint: GLOSSARY.plan.text,
      run: () => hostCall(plan ? "Plan mode off" : "Plan mode on", h.call("agent.setPlan", { agentId, on: !plan })),
    },
    {
      id: "fast",
      title: omp.fast ? "Turn fast mode off" : "Turn fast mode on",
      keywords: ["/fast", "speed"],
      icon: <Zap />,
      hint: GLOSSARY.fast.text,
      run: () => hostCall(omp.fast ? "Fast mode off" : "Fast mode on", h.call("agent.setFast", { agentId, on: !omp.fast })),
    },
    {
      id: "goal",
      title: goal ? "Change goal…" : "Set a goal…",
      keywords: ["/goal", "objective", "budget"],
      icon: <Target />,
      hint: GLOSSARY.goal.text,
      page: {
        kind: "text",
        title: "Goal",
        placeholder: "What should the agent keep working toward?",
        submitLabel: "Set goal",
        run: (objective) => hostCall("Goal set", h.call("agent.goal", { agentId, op: "set", objective })),
      },
    },
    ...(goal
      ? [
          goal.status === "paused"
            ? { id: "goal-resume", title: "Resume goal", keywords: ["/goal resume"], icon: <Play />, run: () => hostCall("Goal resumed", h.call("agent.goal", { agentId, op: "resume" })) }
            : { id: "goal-pause", title: "Pause goal", keywords: ["/goal pause"], icon: <Pause />, run: () => hostCall("Goal paused", h.call("agent.goal", { agentId, op: "pause" })) },
          { id: "goal-drop", title: "Drop goal", keywords: ["/goal drop", "clear"], icon: <X />, run: () => hostCall("Goal dropped", h.call("agent.goal", { agentId, op: "drop" })) },
        ]
      : []),
    {
      id: "compact",
      title: ACTIONS.compact.label,
      keywords: ["/compact", "summarize", "context"],
      icon: <Minimize2 />,
      hint: [omp.context ? `${Math.round(omp.context.pct)}% used` : undefined, ACTIONS.compact.description].filter(Boolean).join(" · "),
      page: {
        kind: "text",
        title: "Compact",
        placeholder: "Optional: what to focus the summary on",
        submitLabel: "Compact now",
        allowEmpty: true,
        run: (instructions) => hostCall("Compacting", h.call("agent.compact", { agentId, instructions: instructions || undefined })),
      },
    },
    {
      id: "fork-pane",
      title: ACTIONS.forkNewPane.label,
      keywords: ["/fork", "branch", "copy"],
      icon: <GitFork />,
      hint: ACTIONS.forkNewPane.description,
      run: () => hostCall("Forked into a new pane", h.call("agent.fork", { agentId, placement: "pane" })),
    },
    {
      id: "fork-here",
      title: ACTIONS.forkInPlace.label,
      keywords: ["/fork", "branch"],
      icon: <GitFork />,
      hint: ACTIONS.forkInPlace.description,
      run: () => hostCall("Forked", h.call("agent.fork", { agentId, placement: "inPlace" })),
    },
    {
      id: "rename",
      title: ACTIONS.rename.label,
      keywords: ["/rename", "title"],
      icon: <SquarePen />,
      hint: agent.title || ACTIONS.rename.description,
      page: { kind: "text", title: "Rename", placeholder: agent.title || "New session title", submitLabel: "Rename", run: (title) => hostCall("Renamed", h.call("agent.rename", { agentId, title })) },
    },
    {
      id: "handoff",
      title: ACTIONS.handoff.label,
      keywords: ["/handoff", "hand off", "new context"],
      icon: <Rocket />,
      hint: ACTIONS.handoff.description,
      page: {
        kind: "text",
        title: "Hand off",
        placeholder: "Optional: what the next session should focus on",
        submitLabel: "Hand off",
        allowEmpty: true,
        run: (instructions) => hostCall("Handing off", h.call("agent.handoff", { agentId, instructions: instructions || undefined })),
      },
    },
    {
      id: "export",
      title: ACTIONS.exportHtml.label,
      keywords: ["/export", "html", "save", "export session"],
      icon: <FileDown />,
      hint: ACTIONS.exportHtml.description,
      run: () => hostCall("Exported", h.call("agent.export", { agentId }), (r) => `Exported to ${r.path}`),
    },
    {
      id: "btw",
      title: "Ask on the side (/btw)…",
      keywords: ["/btw", "side question", "aside"],
      icon: <MessageCircleQuestion />,
      hint: GLOSSARY.btw.text,
      page: { kind: "text", title: "By the way", placeholder: "A quick side question that won't derail the agent", submitLabel: "Ask", run: (question) => hostCall("Side question sent", h.call("agent.btw", { agentId, question })) },
    },
    {
      id: "new-session",
      title: ACTIONS.newSession.label,
      keywords: ["/new", "clear", "reset", "start a new session"],
      icon: <SquarePlus />,
      hint: ACTIONS.newSession.description,
      page: {
        kind: "text",
        title: "New session",
        placeholder: "Press Enter to start over in this pane",
        submitLabel: "Start a new session",
        allowEmpty: true,
        run: () => hostCall("New session started", h.call("agent.newSession", { agentId })),
      },
    },
    {
      id: "slash",
      title: "Run a slash command…",
      keywords: ["/", "command", "raw"],
      icon: <SquareSlash />,
      page: {
        kind: "text",
        title: "Slash command",
        placeholder: "/command arguments",
        submitLabel: "Run",
        run: (command) =>
          runSlash(
            {
              hostId,
              agentId,
              key: agentKey(hostId, agentId),
              meta: undefined,
              // a parked agent has no pane: it resumes first, then its new pane opens (as in the composer)
              openTerminal: () => {
                const mobile = window.innerWidth <= MOBILE_MAX_WIDTH;
                if (agent.parked) openTerminal(agentKey(hostId, agentId), mobile);
                else if (mobile) navigate({ name: "terminal", hostId, agentId });
                else useUi.getState().setSplit({ kind: "terminal", hostId, agentId, paneId: agent.paneId });
              },
            },
            command.startsWith("/") ? command : `/${command}`,
          ),
      },
    },
  ];
}
