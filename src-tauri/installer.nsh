; Windows installs are canonical under Program Files. Versions before v1.0.19
; used %LOCALAPPDATA%\ToBeVPN, while later installers allowed both locations.
; Keep runtime files in that local directory, but remove the obsolete executable
; and registration so a shortcut, deep link, or tray process cannot reopen it.
!macro NSIS_HOOK_PREINSTALL
  ; A hidden tray instance and its sidecars can keep either the old or new
  ; directory locked. Restrict termination to our known install roots.
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$roots=@('$INSTDIR',(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) '${PRODUCTNAME}'),(Join-Path ([Environment]::GetFolderPath('ProgramFiles')) '${PRODUCTNAME}'),(Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) '${PRODUCTNAME}')) | Where-Object { $$_ } | ForEach-Object { [IO.Path]::GetFullPath($$_).TrimEnd('\') + '\' } | Select-Object -Unique; $$names=@('ToBeVPN.exe','tobevpn-desktop.exe','xray.exe','tun2socks.exe'); Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $$proc=$$_; $$path=$$proc.ExecutablePath; if ($$path -and ($$names -contains $$proc.Name)) { foreach ($$root in $$roots) { if ($$path.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $$proc.ProcessId -Force -ErrorAction SilentlyContinue; break } } } }; Start-Sleep -Milliseconds 700"`

  ; Do not execute the legacy uninstaller: it lives in a user-writable
  ; directory and this installer is elevated. Delete only known legacy
  ; executables and registrations. Runtime xray.json and diagnostics
  ; intentionally remain under %LOCALAPPDATA%\ToBeVPN.
  ${If} "$INSTDIR" != "$LOCALAPPDATA\${PRODUCTNAME}"
    Delete "$LOCALAPPDATA\${PRODUCTNAME}\ToBeVPN.exe"
    Delete "$LOCALAPPDATA\${PRODUCTNAME}\tobevpn-desktop.exe"
    Delete "$LOCALAPPDATA\${PRODUCTNAME}\uninstall.exe"
    DeleteRegKey HKCU "Software\Classes\tobevpn"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    ; Machine-level shortcuts are created below. Remove user-level links that
    ; could still point at the obsolete executable.
    SetShellVarContext current
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    SetShellVarContext all
  ${EndIf}
!macroend

; Mark Start Menu and Desktop shortcuts as "Run as administrator" by flipping
; bit 0x20 of byte 0x15 in the .lnk file (LinkFlags RUNAS bit). This way the
; user is prompted for elevation through the standard UAC flow on every launch
; without having to right-click -> "Run as administrator".
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$paths=@('$SMPROGRAMS\${PRODUCTNAME}.lnk','$DESKTOP\${PRODUCTNAME}.lnk'); foreach ($$p in $$paths) { if (Test-Path $$p) { $$b=[IO.File]::ReadAllBytes($$p); $$b[0x15]=$$b[0x15] -bor 0x20; [IO.File]::WriteAllBytes($$p,$$b) } }"`
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove the per-user elevated logon task created by the in-app autostart
  ; switch. Ignore a missing task so uninstall remains idempotent.
  nsExec::ExecToLog `"$SYSDIR\schtasks.exe" /Delete /TN "ToBeVPN Autostart" /F`

  ; Stop the tray instance and bundled helpers before removing Program Files.
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root=[IO.Path]::GetFullPath('$INSTDIR').TrimEnd('\') + '\'; $$names=@('ToBeVPN.exe','tobevpn-desktop.exe','xray.exe','tun2socks.exe'); Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $$proc=$$_; $$path=$$proc.ExecutablePath; if ($$path -and ($$names -contains $$proc.Name) -and $$path.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $$proc.ProcessId -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 700"`
!macroend
