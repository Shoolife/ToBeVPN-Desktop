; Mark Start Menu and Desktop shortcuts as "Run as administrator" by flipping
; bit 0x20 of byte 0x15 in the .lnk file (LinkFlags RUNAS bit). This way the
; user is prompted for elevation through the standard UAC flow on every launch
; without having to right-click → "Run as administrator".
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$paths=@(''$SMPROGRAMS\${PRODUCTNAME}.lnk'',''$DESKTOP\${PRODUCTNAME}.lnk''); foreach ($$p in $$paths) { if (Test-Path $$p) { $$b=[IO.File]::ReadAllBytes($$p); $$b[0x15]=$$b[0x15] -bor 0x20; [IO.File]::WriteAllBytes($$p,$$b) } }"'
!macroend
