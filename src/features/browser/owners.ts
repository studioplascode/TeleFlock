/**
 * Who a tab belongs to (the user, or an agent attached to the browser) and how the tab strip groups
 * and colours them. Pure: the core says which tabs are agents' (`BrowserStatus.tabs`), every other
 * tab is the user's.
 */
import type { BrowserAttachment, BrowserStatus, BrowserTabOwner } from "@/core/gen";
import type { Tab, TabsState } from "./tabs";

export type TabOwner =
  | { kind: "user" }
  | {
      kind: "agent";
      hostId: string;
      agentId: string;
      agentName: string;
      /** The user's own tab, handed to the agent ("Let <agent> use this tab"). */
      lent: boolean;
      /** The user took it over: the agent cannot drive it until it is handed back. */
      takenOver: boolean;
      /** The agent's attachment ended; the tab stays until the user closes it. */
      detached: boolean;
      activeAt?: number;
    };

export const USER_OWNER: TabOwner = { kind: "user" };

/** `user`, or the agent's key (`hostId::agentId`). */
export function ownerKey(owner: TabOwner): string {
  return owner.kind === "user" ? "user" : `${owner.hostId}::${owner.agentId}`;
}

export function ownerOf(entries: readonly BrowserTabOwner[] | undefined, targetId: string): TabOwner {
  const e = entries?.find((x) => x.targetId === targetId);
  if (!e) return USER_OWNER;
  return { kind: "agent", hostId: e.hostId, agentId: e.agentId, agentName: e.agentName, lent: e.lent, takenOver: e.takenOver, detached: e.detached, activeAt: e.activeAt };
}

/**
 * The user may drive a tab: their own, or an agent's they took over. An agent's tab (created by it
 * or lent to it) is watch-only while the agent may drive it, so the two never fight over it.
 */
export function userDrives(owner: TabOwner): boolean {
  return owner.kind === "user" || owner.takenOver || owner.detached;
}

/** The agent sent the browser something within this long: shown as driving. */
export const DRIVING_MS = 5000;

/** Driving: the agent acted within `DRIVING_MS` of `now` (a `now` far before `activeAt`, an idle clock, is not). */
export function isDriving(activeAt: number | undefined, now: number): boolean {
  return activeAt != null && now - activeAt < DRIVING_MS && now - activeAt > -DRIVING_MS;
}

/** Muted owner hues (the host swatches' family), assigned per agent. */
export const OWNER_COLORS = ["#8ea9c4", "#c4a07e", "#86b3aa", "#bfa0c0", "#a7b08c", "#c79f9f", "#c8b48e", "#a99cc2"] as const;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A colour per agent key: each starts at its own hash slot and takes the next free one, in the
 * order given (so two agents on screen never share a colour while there are colours left).
 */
export function ownerColors(keys: readonly string[]): Record<string, string> {
  const used = new Set<number>();
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (out[key]) continue;
    let slot = hash(key) % OWNER_COLORS.length;
    for (let i = 0; i < OWNER_COLORS.length && used.has(slot); i++) slot = (slot + 1) % OWNER_COLORS.length;
    used.add(slot);
    out[key] = OWNER_COLORS[slot] ?? OWNER_COLORS[0];
  }
  return out;
}

export interface TabGroup {
  key: string;
  /** The group's owner (an agent group: as its first tab says, or its attachment). */
  owner: TabOwner;
  /** `You`, or the agent's name. */
  label: string;
  hostId?: string;
  color?: string;
  tabs: Tab[];
  /** Each tab's own owner entry (taken over, lent, detached differ per tab). */
  owners: Record<string, TabOwner>;
  /** The agent is attached right now (it may open more tabs). */
  attached: boolean;
  attachment?: BrowserAttachment;
  /** Any of its tabs, or the attachment, saw the agent act within `DRIVING_MS`. */
  driving: boolean;
}

/**
 * Tabs grouped by owner: the user's first (always present, even empty), then each agent in the
 * order its first tab appears, then attached agents without tabs yet. A group keeps the strip's
 * tab order. A tab lent to an agent sits in the agent's group while lent.
 */
export function groupTabs(tabs: TabsState, status: Pick<BrowserStatus, "tabs" | "attachments"> | null, now: number): TabGroup[] {
  const entries = status?.tabs ?? [];
  const attachments = status?.attachments ?? [];
  const attachmentOf = (hostId: string, agentId: string) => attachments.find((a) => a.hostId === hostId && a.agentId === agentId);
  const user: TabGroup = { key: "user", owner: USER_OWNER, label: "You", tabs: [], owners: {}, attached: false, driving: false };
  const agents = new Map<string, TabGroup>();
  for (const id of tabs.order) {
    const tab = tabs.byId[id];
    if (!tab) continue;
    const owner = ownerOf(entries, id);
    if (owner.kind === "user") {
      user.tabs.push(tab);
      user.owners[id] = owner;
      continue;
    }
    const key = ownerKey(owner);
    let g = agents.get(key);
    if (!g) {
      const attachment = attachmentOf(owner.hostId, owner.agentId);
      g = { key, owner, label: owner.agentName, hostId: owner.hostId, tabs: [], owners: {}, attached: !!attachment, attachment, driving: false };
      agents.set(key, g);
    }
    g.tabs.push(tab);
    g.owners[id] = owner;
    if (!owner.takenOver && !owner.detached && isDriving(owner.activeAt, now)) g.driving = true;
  }
  for (const a of attachments) {
    const key = `${a.hostId}::${a.agentId}`;
    const g = agents.get(key);
    if (g) {
      if (isDriving(a.activeAt, now)) g.driving = true;
      continue;
    }
    agents.set(key, {
      key,
      owner: { kind: "agent", hostId: a.hostId, agentId: a.agentId, agentName: a.agentName, lent: false, takenOver: false, detached: false, activeAt: a.activeAt },
      label: a.agentName,
      hostId: a.hostId,
      tabs: [],
      owners: {},
      attached: true,
      attachment: a,
      driving: isDriving(a.activeAt, now),
    });
  }
  const colors = ownerColors([...agents.keys()]);
  for (const g of agents.values()) g.color = colors[g.key];
  return [user, ...agents.values()];
}

/** What an agent group's menu can do with its tabs. */
export function groupTabActions(g: TabGroup): { takeOver: string[]; handBack: string[]; giveBack: string[]; close: string[] } {
  const out = { takeOver: [] as string[], handBack: [] as string[], giveBack: [] as string[], close: [] as string[] };
  for (const t of g.tabs) {
    const o = g.owners[t.id];
    if (!o || o.kind !== "agent") continue;
    // A lent tab is the user's: taking it back ends the loan (the core's takeOver), it never closes with the agent's tabs.
    if (o.lent) {
      if (!o.takenOver) out.giveBack.push(t.id);
      continue;
    }
    out.close.push(t.id);
    if (o.detached) continue;
    if (o.takenOver) out.handBack.push(t.id);
    else out.takeOver.push(t.id);
  }
  return out;
}
