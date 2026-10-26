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
export { markResuming, onAgentMoved, onAgentsPruned, resumeAgent, useResuming } from "./agentLifecycle";
export type { PrunedGone } from "./agentLifecycle";
export { linkProps, openLink, safeHref } from "./links";
export type { LinkProps } from "./links";
export { CoreError, apiError, isApiError, toApiError } from "./errors";
export { pulseBus, termBus } from "./buses";
export type { PulseListener, PulseAllListener, TermListener } from "./buses";
export type {
  AgentView,
  BtwEntry,
  BtwTurnView,
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
  markAgentNotificationsRead,
  markNotificationRead,
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
  useIrcEntries,
  useNotifications,
  useSession,
  useSessionItem,
  useSettings,
  useSuccessor,
  useTunnels,
  useWorkspaces,
} from "./hooks";
export type { AgentFilter, HostsView, NotificationsView, SessionView, SettingsView } from "./hooks";
export { ircOf, ircThreads, ircUnread } from "./irc";
export type { IrcEntry, IrcThread } from "./irc";
export {
  describePace,
  formatPct,
  formatSpan,
  projectWindow,
  refreshLimits,
  sessionLimits,
  tightestWindow,
  useAccountLimits,
  windowsForModel,
} from "./limits";
export type { HostLimits, PaceOutcome, SessionLimits, WindowPace } from "./limits";
export { navigate, useRoute, getRoute, parseHash, routeToHash } from "./nav";
export type { Route, RouteName } from "./nav";
export { useUi } from "./ui";
export type { UiDialog, SplitState, UiState } from "./ui";
export { usePrefs } from "./prefs";
export type { Prefs } from "./prefs";
export {
  aiNamingEnabled,
  suggestAgentName,
  suggestBranch,
  suggestCommitMessage,
  suggestPullRequest,
  suggestTemplateName,
  suggestTitle,
  useAiNaming,
  useAiSuggestion,
} from "./ai";
export type { AiCallOptions, AiTask } from "./ai";
export { DRAFT_LIMITS, draftKey, draftKeyParts, drafts, flushDrafts, pruneDrafts, useDraft, useDraftState, useDrafts } from "./drafts";
export type { DraftEntry, DraftLimits, DraftSetter } from "./drafts";
export { useDraftImages } from "./draftImages";
export type { DraftImage } from "./draftImages";
export { ANSWER_SCOPE, answerDraftKey, startDraftSweep } from "./draftSweep";
