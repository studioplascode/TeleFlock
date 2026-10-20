; TeleFlock NSIS hooks (bundle.windows.nsis.installerHooks).
; The app registers its toast AUMID under HKCU at first run (display name + icon for toasts);
; remove it with the app. The teleflock:// protocol keys are handled by Tauri's installer.

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\dev.teleflock.app"
!macroend
