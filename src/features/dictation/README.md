# `features/dictation` — on-device dictation and Rambler

The app core's on-device speech recognition (`dictation.*`; docs/architecture.md §6.16) and Rambler, dictation
tidied into a prompt by a model on the host (`ai.complete` task `ramble`; §3.8, §6.10). The mic's sources live with
the composer: `useDictation` (`features/session/composer`) picks the app core's engine once a speech model is chosen,
else Android's recognizer or the Web Speech API; a session keeps its engine until it ends (`engineInUse`).

On-device engine:
- `store.ts`: `useDictationModels`, the app core's `DictationState` (`dictation.models`, then every
  `AppEvent::Dictation`; `missing` when the core has none: `unsupported` on Android and builds without the engine,
  `unknown_method` before 0.9.0), the routing of `AppEvent::DictationSession` events to whoever started each session
  (`onDictationSession`), `chosenModel`, `openDictationSettings` (a composer's **Open settings** after a no-model
  error) and `newSessionId` (random: tabs sharing a devserver never collide).
- `deviceSession.ts`: `DeviceSession`, one listening session: events under the page's id, listened to before
  `dictation.start` is sent so none is lost; a stop or cancel while the start is on its way is sent once it answered.
- `models.ts`: what Settings shows and decides: the model **On this device** picks, the one that takes over after a
  delete (as the app core decides it), download percent, the languages the chosen model can be told and what it
  hears with the current choice (`heardLanguage`, tf-dictation's `Model::language_for` in TypeScript).
- `DictationSettings.tsx`: Settings → Dictation: what blocks the microphone when something does (`MicAccessRow`,
  below), System / On this device, the models (size, languages, memory, speed and accuracy, Recommended, "Slow for
  live dictation"; download with progress, cancel, resume, Retry with the error; Use; delete with a confirm that names
  the takeover), the language, the microphone (listed when the card opens; a chosen one that isn't connected stays by
  name), then `<RamblerRows/>`. A core without speech models gets one row that says what listens instead.

Microphone blocked (§6.16 "Microphone access"): Windows' and macOS' privacy settings and Android's permission never ask
again once refused, and WebView2 (the Windows window's speech recognition) remembers its own Block for good.
- `micAccess.ts`: what to say and which button undoes it (`micBlock`, `refusedBlock` after a start refused with
  `permission`, `androidMicBlock`): "Windows blocks the microphone for TeleFlock." with **Open Windows settings**
  (`ms-settings:privacy-microphone`), macOS with **Open System Settings** (its Microphone pane), Android with **Open
  Android settings** (the app's info), the window's Block with **Allow the microphone**. The app core's engine only
  minds the system's setting (`scope` `engine`); the window's speech recognition minds both (`window`). Linux keeps no
  such setting: a device's refusal stays its error.
- `useMicAccess.ts`: reads it (`dictation.microphoneAccess`; the Android app asks the plugin's `microphone_permission`,
  which never prompts), runs the button (`dictation.openMicrophoneSettings`, `dictation.allowWindowMicrophone`, the
  plugin's `open_app_settings`) and checks again right after it and whenever the window comes back to the front
  (`focus`, `visibilitychange`), so the notice goes once the switch is on and the next tap listens, without a restart.
  `useMicBlockNotice` is a text box's notice after a refused tap; `useMicAccess` is Settings' row.
- `MicBlocked.tsx`: the notice above a text box (`useRamblerDictation`'s `panel`, so the session composer, Dispatch,
  the ask card and Quick answer all show it), with the button and Hide.

Rambler (the logic in `@/core/rambler`, `rambler.test.ts`, and `@/core/ai`: `suggestRamble`, `ramblePrompt`,
`parseRamble`):
- `useRamblerDictation.tsx`: the hook every text box uses instead of `useDictation`. With Rambler off (Settings →
  Dictation) it is the plain dictation; on, it routes utterances to a `Rambler` session, which sends nothing while
  the person speaks (it only keeps the host's worker warm: `ai.prewarm` at the start, then every minute). When the
  dictation ends (Stop, the engine ending it, the field closing) the session makes its one call over the whole
  transcript, the box is filled once (one undoable edit), and the hook returns the `panel` to render above the box.
- `RamblerCard.tsx`: the card while dictating (the transcript as heard, the words being heard in italics) and
  tidying ("Tidying…"), and the strip after the fill (**Use raw transcript** / **Undo**, or why the words were kept
  as dictated); `tone="sun"` for the ask card's sunset background.
- `edit.ts`: `replaceRange` (an `insertText` edit on a focused box so Ctrl+Z works, else a draft write).

Surfaces: session `Composer`, `DispatchComposer` (Rambler's context: the thread's repository, none for a chat),
`AskCard`'s Other field (the hook lives in the field, so closing it ends the session), `QuickAnswer`'s Other field
(the hook lives in the card: closing the field, by Esc, an answer or the question going, stops a running mic as Stop
would, and what was said lands in the field's draft).

Demo: `src/core/demo/dictation.ts` (`?demo`): the real catalog, downloads of a few seconds (progress, cancel, resume),
sessions that hear a canned English or German ramble, `unsupported` on an Android user agent. `?demo&mic=denied`:
Windows blocks the microphone (macOS on a Mac user agent), with Parakeet chosen so a composer's mic is there: a tap
shows the notice, Settings shows the row, and Open Windows settings stands for turning the switch on there.
`?demo&mic=webview`: the window's own Block, lifted by Allow the microphone.

Tests: `bun test src/features/dictation src/core/demo/dictation.test.ts src/features/session/composer/useDictation.test.ts src/core/rambler.test.ts`.
