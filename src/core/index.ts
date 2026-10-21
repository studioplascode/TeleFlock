/**
 * TeleFlock frontend core. See `src/core/README.md`.
 * Wire types come from `@/core/gen` (generated from crates/tf-proto).
 */
export type { Backend, CoreTransport } from "./transport/types";
export type { CoreClient, HostClient } from "./client";
export {
  core,
  startCore,
  onAppEvent,
  refreshHost,
  refreshAll,
  openSession,
  closeSession,
  loadOlder,
  flushCoreEvents,
} from "./client";
export { agentKey, parseAgentKey } from "./keys";
export { linkProps, openLink, safeHref } from "./links";
export type { LinkProps } from "./links";
export { CoreError, apiError, isApiError, toApiError } from "./errors";
export { pulseBus, termBus } from "./buses";
export type { PulseListener, PulseAllListener, TermListener } from "./buses";
export type {
  AgentView,
  BtwEntry,
  CoreState,
  HostActivityEvent,
  HostEntry,
  HostNotification,
  SessionEntry,
  SessionStatus,
} from "./store/state";
export {
  DEFAULT_SETTINGS,
  getAgentViews,
  getWorkspacesSnapshot,
  loadOlderActivity,
  getTranscript,
  selectAgentKeys,
  useActivity,
  useAgent,
  useAgentKeys,
  useBackend,
  useBtw,
  useColumnKeys,
  useCore,
  useHostIds,
  useHostStale,
  useHostState,
  useHostStates,
  useHosts,
  isMuted,
  useIsMuted,
  useInbox,
  useNotifications,
  useSession,
  useSessionItem,
  useSettings,
  useTunnels,
  useWorkspaces,
} from "./hooks";
export type { AgentFilter, HostsView, NotificationsView, SessionView, SettingsView } from "./hooks";
export { navigate, useRoute, getRoute, parseHash, routeToHash } from "./nav";
export type { Route, RouteName } from "./nav";
export { useUi } from "./ui";
export type { UiDialog, SplitState, UiState } from "./ui";
