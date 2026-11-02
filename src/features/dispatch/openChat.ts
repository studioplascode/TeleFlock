import { getHostStates, navigate, useHosts } from "@/core";
import { CHAT_REPO } from "@/core/chats";
import { dispatchTarget, worldHostIds } from "./send";
import { useDispatch } from "./store";

/**
 * "New chat" (palette, phone create sheet): Dispatch with "No folder · chat" picked for its current
 * target (the last host or group used, else the first host) and the task box focused. A target
 * that can't start chats says so there (repo chip, composer).
 */
export function openChat(): void {
  const { profiles } = useHosts.getState();
  const d = useDispatch.getState();
  const { target } = dispatchTarget(profiles, worldHostIds({ profiles, states: getHostStates() }), d.lastHost);
  if (target) d.select(target, CHAT_REPO);
  d.focusComposer();
  navigate({ name: "dispatch" });
}
