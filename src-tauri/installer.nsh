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
  ; tauri-plugin-updater starts a passive NSIS update with /P /R /UPDATE.
  ; Tauri's default /R handler deliberately drops to Explorer's unelevated
  ; token before starting the app. That is incompatible with our embedded
  ; requireAdministrator manifest: process creation can appear successful,
  ; then the Windows loader fails before main() with TaskDialogIndirect not
  ; found. Start the installed binary through ShellExecute's elevation verb
  ; instead, then drop /R from $CMDLINE (a writable NSIS variable) so Tauri's
  ; .onInstSuccess callback does not perform a second, broken RunAsUser
  ; launch. PassiveMode must stay set: clearing it (as earlier versions did)
  ; turned the update back into an interactive install whose Finish page,
  ; with its "Run" and "Desktop shortcut" boxes, appeared after the app had
  ; already started.
  ${If} $UpdateMode = 1
  ${AndIf} $PassiveMode = 1
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      ${If} ${Errors}
        StrCpy $R0 ""
      ${EndIf}

      ClearErrors
      ExecShell "runas" "$INSTDIR\${MAINBINARYNAME}.exe" "$R0" SW_SHOWNORMAL
      ${IfNot} ${Errors}
        StrCpy $CMDLINE '"$EXEPATH" /P /UPDATE'
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove the per-user elevated logon task created by the in-app autostart
  ; switch. Ignore a missing task so uninstall remains idempotent.
  nsExec::ExecToLog `"$SYSDIR\schtasks.exe" /Delete /TN "ToBeVPN Autostart" /F`

  ; Drop the catch-all DNS policy (NRPT) the app sets while connected, in
  ; case it is uninstalled with the tunnel up or after a crash.
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-DnsClientNrptRule | Where-Object { $$_.Comment -eq 'ToBeVPN' } | Remove-DnsClientNrptRule -Force; Clear-DnsClientCache"`

  ; Stop the tray instance and bundled helpers before removing Program Files.
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root=[IO.Path]::GetFullPath('$INSTDIR').TrimEnd('\') + '\'; $$names=@('ToBeVPN.exe','tobevpn-desktop.exe','xray.exe','tun2socks.exe'); Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $$proc=$$_; $$path=$$proc.ExecutablePath; if ($$path -and ($$names -contains $$proc.Name) -and $$path.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $$proc.ProcessId -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 700"`
!macroend
