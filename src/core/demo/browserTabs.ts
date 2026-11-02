/**
 * The demo's TeleFlock Browser tabs (`?demo`): the demo backend (`./browser`) reports who owns them
 * (`BrowserStatus.tabs`), the panel's fake browser (`src/features/browser/demo`) shows them. Tabs an
 * agent opens later (an allowed request) go through `openDemoAgentTab`, so the fake opens them too,
 * whether it is running yet or not.
 */
export interface DemoBrowserTab {
  /** CDP target id. */
  targetId: string;
  url: string;
  /** Window the tab opens in: the user's tabs share window 1, each agent's tabs have their own (as the core places them). */
  window: number;
  /** The agent the tab belongs to; absent: the user's. */
  owner?: { hostId: string; agentId: string };
}

export const DEMO_BROWSER_TABS: readonly DemoBrowserTab[] = [
  { targetId: "demo-tab-start", url: "https://start.teleflock.demo/", window: 1 },
  { targetId: "demo-tab-mail", url: "https://mail.example.com/inbox", window: 1 },
  { targetId: "demo-tab-quota", url: "https://dashboard.example.com/billing", window: 2, owner: { hostId: "forge", agentId: "quota" } },
  { targetId: "demo-tab-ci", url: "https://ci.example.com/runs", window: 3, owner: { hostId: "forge", agentId: "ci" } },
];

/** The fake browser's WebSocket address: the panel connects to the in-process fake instead of a socket. */
export const DEMO_BROWSER_WS = "demo:browser";

/** Where the address bar searches on `?demo`: the fake's own search page (a real search engine is a network error there). */
export const DEMO_SEARCH_URL = "https://search.teleflock.demo/?q=";

let opened: DemoBrowserTab[] = [];
let listener: ((tab: DemoBrowserTab) => void) | null = null;

/** The demo backend: an agent opened a tab. The fake browser opens it now, or when it starts. */
export function openDemoAgentTab(tab: DemoBrowserTab): void {
  opened = [...opened, tab];
  listener?.(tab);
}

/** The fake browser: the tabs agents opened so far; `onOpen` hears of later ones (one listener, the newest). */
export function demoAgentTabs(onOpen: (tab: DemoBrowserTab) => void): readonly DemoBrowserTab[] {
  listener = onOpen;
  return opened;
}

/** Tests: forgets the tabs agents opened and the listener. */
export function resetDemoAgentTabs(): void {
  opened = [];
  listener = null;
}
