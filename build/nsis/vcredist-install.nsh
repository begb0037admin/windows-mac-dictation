; electron-builder NSIS customization: silently installs the Microsoft
; Visual C++ Redistributable (x64) bundled under resources\redist\ during
; setup.
;
; Why this exists: the Windows backend's faster-whisper/ctranslate2 CPU
; codepath (used automatically on machines with no NVIDIA GPU - see
; main.py's _resolve_whisper_device()) and onnxruntime both depend on
; msvcp140_1.dll, which is NOT part of Windows out of the box and is
; missing on any machine that only has an older/partial VC++ runtime
; installed. Without it, the frozen backend doesn't raise a catchable
; error - it hard-crashes (access violation) the instant it tries to load
; the whisper model. Confirmed live on a GPU-less Windows 11 laptop
; (2026-08-24): CPU transcription only started working after installing
; this exact redistributable.
;
; ExecWait rather than Exec: the app must not be launched (and therefore
; must not try to load the whisper model) until this has actually
; finished. /install /quiet /norestart matches Microsoft's own documented
; silent-install switches; the redistributable's installer is itself
; idempotent (fast no-op if an equal-or-newer version is already present),
; so this always runs rather than trying to pre-detect an installed
; version via the registry.
;
; Not a hard install failure: exit code 1638 (a newer/equal version is
; already installed) and 3010 (success, reboot required) are both
; success-shaped outcomes, not defects. Anything else is surfaced to the
; user but does not abort the PTT install - CPU-only machines would then
; simply see the same crash this hook exists to prevent, with a clear
; path to installing it by hand from https://aka.ms/vs/17/release/vc_redist.x64.exe.

!macro customInstall
  DetailPrint "Installing Microsoft Visual C++ Redistributable..."
  ExecWait '"$INSTDIR\resources\redist\vc_redist.x64.exe" /install /quiet /norestart' $0
  ${If} $0 != 0
  ${AndIf} $0 != 1638
  ${AndIf} $0 != 3010
    DetailPrint "Visual C++ Redistributable install returned exit code $0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "The Microsoft Visual C++ Redistributable could not be installed automatically (exit code $0).$\r$\n$\r$\nPTT may fail to start on this machine unless it is already installed. You can install it manually from https://aka.ms/vs/17/release/vc_redist.x64.exe"
  ${EndIf}
!macroend
