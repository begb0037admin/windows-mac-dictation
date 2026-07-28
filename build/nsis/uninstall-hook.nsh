; electron-builder NSIS customization: removes the Run-key login-item
; registration app.setLoginItemSettings() creates on Windows, and nothing
; else - userData (settings, logs) is deliberately left alone.
;
; NOT YET LIVE-VERIFIED (FINAL_BRIEF.md SS16/SS18 explicitly require this):
; this hook must be authored AFTER a bootstrap install (no hook) has been
; installed and its actual Run-key registration observed, not guessed.
; This version's best-effort guess: Electron's app.setLoginItemSettings(),
; called in electron/main.js without an explicit `name` option, defaults to
; using app.getName() (== electron/package.json's "name" field, currently
; "dictation-shell" - see i1_claude.md's flagged, not-yet-decided rename
; question) as the Run-key value name, and process.execPath as its data.
; ${PRODUCT_NAME} is electron-builder's own build-time variable for the
; product name actually used for this specific installer - using that
; keeps this hook correct automatically if/when the name question above is
; resolved either way, PROVIDED live observation confirms Electron is
; actually keying off the same name (it may key off "name" not
; "productName" - this is exactly what SS16's bootstrap-install step must
; confirm before this hook can be trusted).

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
