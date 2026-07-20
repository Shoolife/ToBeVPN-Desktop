; Windows installs are canonical under Program Files. Versions before v1.0.19
; used %LOCALAPPDATA%\ToBeVPN, while later installers allowed both locations.
; Keep runtime files in that local directory, but remove the obsolete executable
; and registration so a shortcut, deep link, or tray process cannot reopen it.
!macro NSIS_HOOK_PREINSTALL
  ; A hidden tray instance and its sidecars can keep either the old or new
  ; directory locked. Restrict termination to our known install roots. Pass
  ; the dynamic path through the child environment so an apostrophe in it
  ; cannot terminate a PowerShell string literal.
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOBEVPN_INSTALL_DIR", t "$INSTDIR") i.r0'
  ${If} $0 != 0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$sys=[Environment]::SystemDirectory; $$win=[IO.Directory]::GetParent($$sys).FullName; $$env:SystemRoot=$$win; $$env:WINDIR=$$win; $$env:ComSpec=[IO.Path]::Combine($$sys,'cmd.exe'); $$env:PSModulePath=[IO.Path]::Combine($$sys,'WindowsPowerShell','v1.0','Modules'); $$env:PATH=$$sys; $$roots=@($$env:TOBEVPN_INSTALL_DIR,(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) '${PRODUCTNAME}'),(Join-Path ([Environment]::GetFolderPath('ProgramFiles')) '${PRODUCTNAME}'),(Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) '${PRODUCTNAME}')) | Where-Object { $$_ } | ForEach-Object { [IO.Path]::GetFullPath($$_).TrimEnd('\') + '\' } | Select-Object -Unique; $$names=@('ToBeVPN','tobevpn-desktop','xray','tun2socks'); Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $$proc=$$_; try { $$path=$$proc.Path } catch { $$path=$$null }; if ($$path -and ($$names -contains $$proc.Name)) { foreach ($$root in $$roots) { if ($$path.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -InputObject $$proc -Force -ErrorAction SilentlyContinue; break } } } }; Start-Sleep -Milliseconds 700"`
  ${EndIf}

  ; A sidecar terminated by the installer cannot run the app's normal Stop
  ; transaction. Remove only ToBeVPN's uniquely tagged routes/rules so an
  ; interrupted upgrade does not leave the machine offline until next launch.
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$sys=[Environment]::SystemDirectory; $$win=[IO.Directory]::GetParent($$sys).FullName; $$env:SystemRoot=$$win; $$env:WINDIR=$$win; $$env:ComSpec=[IO.Path]::Combine($$sys,'cmd.exe'); $$env:PSModulePath=[IO.Path]::Combine($$sys,'WindowsPowerShell','v1.0','Modules'); $$env:PATH=$$sys; Get-NetFirewallRule -Name 'ToBeVPN-DnsLeakGuard-udp','ToBeVPN-DnsLeakGuard-tcp' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue; Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $$_.Protocol -eq 'NetMgmt' -and $$_.RouteMetric -in 37676,65000 } | Remove-NetRoute -Confirm:$$false -ErrorAction SilentlyContinue; Set-DnsClientServerAddress -InterfaceAlias 'ToBeVPN' -ResetServerAddresses -ErrorAction SilentlyContinue"`

  ; Do not execute, overwrite, or delete files in the legacy user-writable
  ; directory: this installer is elevated and that path can be redirected by
  ; a junction/hard-link race. Removing its registrations and shortcuts makes
  ; the protected Program Files installation canonical without a privileged
  ; filesystem operation below %LOCALAPPDATA%.
  ${If} "$INSTDIR" != "$LOCALAPPDATA\${PRODUCTNAME}"
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
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOBEVPN_START_MENU_LINK", t "$SMPROGRAMS\${PRODUCTNAME}.lnk") i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOBEVPN_DESKTOP_LINK", t "$DESKTOP\${PRODUCTNAME}.lnk") i.r1'
  ${If} $0 != 0
  ${AndIf} $1 != 0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$sys=[Environment]::SystemDirectory; $$win=[IO.Directory]::GetParent($$sys).FullName; $$env:SystemRoot=$$win; $$env:WINDIR=$$win; $$env:ComSpec=[IO.Path]::Combine($$sys,'cmd.exe'); $$env:PSModulePath=[IO.Path]::Combine($$sys,'WindowsPowerShell','v1.0','Modules'); $$env:PATH=$$sys; $$paths=@($$env:TOBEVPN_START_MENU_LINK,$$env:TOBEVPN_DESKTOP_LINK); foreach ($$p in $$paths) { if (Test-Path $$p) { $$b=[IO.File]::ReadAllBytes($$p); $$b[0x15]=$$b[0x15] -bor 0x20; [IO.File]::WriteAllBytes($$p,$$b) } }"`
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove both the legacy fixed task and all per-user namespaced tasks.
  nsExec::ExecToLog `"$SYSDIR\schtasks.exe" /Delete /TN "ToBeVPN Autostart" /F`
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$sys=[Environment]::SystemDirectory; $$win=[IO.Directory]::GetParent($$sys).FullName; $$env:SystemRoot=$$win; $$env:WINDIR=$$win; $$env:ComSpec=[IO.Path]::Combine($$sys,'cmd.exe'); $$env:PSModulePath=[IO.Path]::Combine($$sys,'WindowsPowerShell','v1.0','Modules'); $$env:PATH=$$sys; Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $$_.TaskName -like 'ToBeVPN Autostart *' } | Unregister-ScheduledTask -Confirm:$$false -ErrorAction SilentlyContinue"`

  ; Stop the tray instance and bundled helpers before removing Program Files.
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOBEVPN_INSTALL_DIR", t "$INSTDIR") i.r0'
  ${If} $0 != 0
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$sys=[Environment]::SystemDirectory; $$win=[IO.Directory]::GetParent($$sys).FullName; $$env:SystemRoot=$$win; $$env:WINDIR=$$win; $$env:ComSpec=[IO.Path]::Combine($$sys,'cmd.exe'); $$env:PSModulePath=[IO.Path]::Combine($$sys,'WindowsPowerShell','v1.0','Modules'); $$env:PATH=$$sys; $$root=[IO.Path]::GetFullPath($$env:TOBEVPN_INSTALL_DIR).TrimEnd('\') + '\'; $$names=@('ToBeVPN','tobevpn-desktop','xray','tun2socks'); Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $$proc=$$_; try { $$path=$$proc.Path } catch { $$path=$$null }; if ($$path -and ($$names -contains $$proc.Name) -and $$path.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -InputObject $$proc -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 700"`
  ${EndIf}

  ; A forced process stop cannot run the normal route/DNS finally block.
  ; Remove only entries carrying ToBeVPN's dedicated metrics/rule names.
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$sys=[Environment]::SystemDirectory; $$win=[IO.Directory]::GetParent($$sys).FullName; $$env:SystemRoot=$$win; $$env:WINDIR=$$win; $$env:ComSpec=[IO.Path]::Combine($$sys,'cmd.exe'); $$env:PSModulePath=[IO.Path]::Combine($$sys,'WindowsPowerShell','v1.0','Modules'); $$env:PATH=$$sys; Get-NetFirewallRule -Name 'ToBeVPN-DnsLeakGuard-udp','ToBeVPN-DnsLeakGuard-tcp' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue; Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $$_.Protocol -eq 'NetMgmt' -and $$_.RouteMetric -in 37676,65000 } | Remove-NetRoute -Confirm:$$false -ErrorAction SilentlyContinue; Set-DnsClientServerAddress -InterfaceAlias 'ToBeVPN' -ResetServerAddresses -ErrorAction SilentlyContinue"`
!macroend
