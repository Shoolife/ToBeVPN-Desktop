; Mark Start Menu and Desktop shortcuts as "Run as administrator" by flipping
; bit 0x20 of byte 0x15 in the .lnk file (LinkFlags RUNAS bit). This way the
; user is prompted for elevation through the standard UAC flow on every launch
; without having to right-click → "Run as administrator".
!macro NSIS_HOOK_PREINSTALL
  ; The app can be hidden to tray while xray/tun2socks keep running from the
  ; install dir. Stop only ToBeVPN-owned processes before NSIS overwrites files.
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$roots=@(''$INSTDIR'',''$PROFILE\AppData\Local\ToBeVPN'') | Where-Object { $$_ }; $$names=@(''ToBeVPN.exe'',''tobevpn-desktop.exe'',''xray.exe'',''tun2socks.exe''); Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $$proc=$$_; $$path=$$proc.ExecutablePath; if ($$path -and ($$names -contains $$proc.Name)) { foreach ($$root in $$roots) { if ($$path.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $$proc.ProcessId -Force -ErrorAction SilentlyContinue; break } } } }; Start-Sleep -Milliseconds 700"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$paths=@(''$SMPROGRAMS\${PRODUCTNAME}.lnk'',''$DESKTOP\${PRODUCTNAME}.lnk''); foreach ($$p in $$paths) { if (Test-Path $$p) { $$b=[IO.File]::ReadAllBytes($$p); $$b[0x15]=$$b[0x15] -bor 0x20; [IO.File]::WriteAllBytes($$p,$$b) } }"'
!macroend
