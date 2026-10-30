# `src/features/notify`

Notifications in the UI: the bell and inbox (`NotificationCenter.tsx`), toasts and chimes
(`useNotifyBridge.ts`), and, since 0.7.0 ("notifications that find you"), device presence and the
per-host alert settings. The routing itself is not here: tf-hostd decides who is alerted
(`crates/tf-hostd/src/notify/`), the app core relays what the UI and the OS know about the user
(`app.presence`).

## Presence reporting (`usePresenceReporter.ts`, `presence.ts`)

`usePresenceReporter()` is mounted once next to `useNotifyBridge()` in `app/App.tsx`. It calls the
app method `app.presence` with `UiPresence {visible, focused, inputAt?}`:

- once on mount;
- when the window's visibility or focus flips. `design/lib/windowActive.ts` is the single source:
  document visibility, window focus/blur, and in the desktop app Tauri's `onFocusChanged` plus the
  minimized / hidden-to-tray check, so a WebView2 window that is still "visible" to the document
  counts as not shown;
- on input (`pointerdown`, `keydown`, `wheel`, `touchstart`; capture, passive), at most once per
  20 s while input continues (`INPUT_EVERY_MS`). The newest input time rides along on every report.

There are no timers: an idle window costs nothing (architecture §6.3), and between reports the
core and the host extrapolate. `PresenceTracker` (`presence.ts`) holds this logic without React or
the DOM (and the unit test); the hook only wires events to it. A repeated state is not re-sent. A
core that answers `unknown_method` or `unsupported` (older than 0.7.0) switches reporting off for
the session without a toast.

The core adds what only the system knows (idle time, a locked screen) and the device settings
(`Settings.sharePresence`, `idleAfterMin`, `deviceKind`) before sending its `presence` message to
each host. Turning "Alert the device I'm using" off therefore needs no UI work here.

## Alert handling (`useNotifyBridge.ts`)

`AppEvent.notify` carries `alert?: boolean`:

| `alert` | Meaning | UI |
|---|---|---|
| absent | host before 0.7.0, or routing off | toast, haptic, chime as before |
| `false` | the host routed it to another device in use | listed in the bell and inbox (the store does that), **no** toast, haptic or chime; open toasts of that agent stay |
| `true` (same id again) | the host escalated it to this device | toast, haptic and chime now; it replaces that agent's open toast like any newer notification |

## Settings

- **This device** (`settings/PresenceRows.tsx`, inside Notifications): "Alert the device I'm using"
  (`sharePresence`, absent = on), "This device is" (Auto / Desktop / Phone → `deviceKind`; Auto says
  what it means on this platform), "Idle after" (1 to 15 min → `idleAfterMin`, absent = 3). The two
  detail rows hide while the switch is off.
- **Alerts from your hosts** (`HostAlerts.tsx`, after Muted agents): per host, over the host
  methods `notify.config`, `notify.setPolicy`, `notify.saveChannel`, `notify.removeChannel`,
  `notify.test`.
  - Host picker: the host filter if it is online, else the first online host. A host that is
    offline or answers `unknown_method` (before 0.7.0) shows a note instead of controls.
  - Rows: Alert the device in use (`policy.route`), Escalate when unseen (`escalateAfterS`, 0 =
    never; it also times the push channels set to Unseen, so it stays editable with routing off),
    Escalate to (phones / all devices; disabled while routing is off or escalation is Never).
    **Devices now** lists the apps connected to
    the host with their state; an app without `presence` shows "Older app: alerts everything".
    **Send a test** routes a sample like a real notification (`escalate: true`) and toasts who
    got it (`describeTest` in `alerts.ts`).
  - The config is read when the host changes, replaced by every mutation's answer, and polled
    every 10 s only while the section is on screen and the window is in front.
  - **Push channels** (`PushChannels.tsx`, form in `PushChannelForm.tsx`, shown in the app's
    sheet): ntfy, Pushover and signed webhooks reach you with no app open. Each channel lists its
    masked `target`, when it fires, which kinds it carries, whether details are hidden and the last
    result. Enable (saves only non-secret fields), Test (`notify.test {channelId}`), Edit, Remove
    (inline confirm).

### Secrets

Channel secrets (ntfy topic URL and token, Pushover keys, webhook URL and signing secret) are
stored by the host, owner-only, and never come back: `PushChannel.saved` only lists which fields
exist and `target` is masked. In the form they are password inputs (with a show toggle); a field
you leave empty is omitted from the save (the host keeps the stored value, "saved" shows as the
placeholder), and Clear sends `""` to delete it. Required fields (ntfy URL, Pushover user key and
token, webhook URL) cannot be cleared. Hostd's validation errors show as toasts with
`errorMessage` / `errorHint`.

A webhook with a signing secret sends `X-TeleFlock-Timestamp` and
`X-TeleFlock-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<body>`.

## Demo

`core/demo/notify.ts` answers `notify.*` for the demo host `forge` (in memory: policy, one ntfy
channel, devices "This device", "Pixel 9" and the older "old-laptop"); `studio-pc` plays a host
before 0.7.0 (`unknown_method`). The demo app answers `app.presence` with `{}`.

## Files

| File | Role |
|---|---|
| `usePresenceReporter.ts`, `presence.ts` | presence reporting and its pure tracker |
| `useNotifyBridge.ts` | toasts, chimes, haptics; `alert` handling |
| `HostAlerts.tsx` | the "Alerts from your hosts" section |
| `PushChannels.tsx`, `PushChannelForm.tsx` | channel list and add/edit form |
| `alerts.ts` | labels and pure helpers (escalation delays, kinds, test toast, Auto device) |
| `../settings/PresenceRows.tsx` | the device rows in Notifications |
