; Custom NSIS include for Linux AI Ops Studio.
;
; electron-builder merges this into its generated installer via
; package.json -> build.nsis.include. It must only define the documented
; customization macros (customInstall, customUnInstall, etc.) — NOT raw NSIS
; callbacks like .onInstSuccess, which electron-builder's own template
; already defines and would collide with (a "function already defined"
; compile error). The previous version of this file did exactly that, plus
; used ${GetParameters} without including FileFunc.nsh, so it never actually
; compiled — it was also never wired into package.json, so none of it ever
; ran regardless.

!macro customInstall
  ; Reset the app's first-run marker on every install AND reinstall (not
  ; just the very first install ever), so the in-app OpenRouter setup
  ; wizard (electron/setup-wizard.cjs, triggered from electron/main.cjs)
  ; reliably asks again on next launch — matching what a user expects when
  ; they run the installer again, even over an existing install.
  SetShellVarContext current
  Delete "$APPDATA\linux-ai-ops-studio\.first-run"
!macroend
