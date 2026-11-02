/**
 * "Let <agent> use my browser" / "Stop letting <agent> use my browser" for an agent's menus (the
 * session header's actions, the sidebar's agent menu): on a computer whose TeleFlock has a usable
 * browser, for omp agents (their omp drives it).
 */
import { useBrowser } from "@/core";
import type { Agent } from "@/core/gen";
import { isAndroid } from "@/design";
import { ACTIONS } from "@/features/shell/vocab";
import { attachAgent, detachAgent } from "./actions";

export interface BrowserLendItem {
  /** It can drive this device's browser now. */
  attached: boolean;
  label: string;
  description: string;
  run(): void;
}

export function useBrowserLendItem(agent: (Pick<Agent, "id" | "name" | "kind"> & { hostId: string }) | undefined): BrowserLendItem | null {
  const status = useBrowser();
  if (!agent || isAndroid || !status || status.state === "unavailable" || agent.kind !== "omp") return null;
  const { hostId, id, name } = agent;
  if (status.attachments.some((a) => a.hostId === hostId && a.agentId === id)) {
    return { attached: true, label: `Stop letting ${name} use my browser`, description: ACTIONS.browserDetach.description, run: () => void detachAgent(hostId, id, name) };
  }
  return { attached: false, label: `Let ${name} use my browser`, description: ACTIONS.browserAttach.description, run: () => void attachAgent(hostId, id, name) };
}
