-- "Удалить ToBeVPN" in the macOS .dmg (scripts/macos-dmg.sh compiles it with
-- osacompile). Removes what the app put on this Mac: the root network helper,
-- its tun2socks and sudoers rule (administrator password), then the app, its
-- login item, caches, settings and the saved sign-in of this user.

on run
	set isRussian to (user locale of (get system info)) starts with "ru"
	if isRussian then
		set askText to "Удалить ToBeVPN с этого Mac?" & return & return & "VPN отключится. Будут удалены приложение, сетевой помощник, автозапуск и данные ToBeVPN на этом Mac (вход в аккаунт тоже). Подписка и аккаунт останутся."
		set cancelLabel to "Отмена"
		set removeLabel to "Удалить"
		set promptText to "ToBeVPN удалит свой сетевой помощник."
		set doneText to "ToBeVPN удалён."
		set failText to "Не удалось удалить ToBeVPN: "
	else
		set askText to "Remove ToBeVPN from this Mac?" & return & return & "The VPN disconnects. The app, its network helper, the login item and ToBeVPN data on this Mac (the sign-in too) are removed. The subscription and the account stay."
		set cancelLabel to "Cancel"
		set removeLabel to "Remove"
		set promptText to "ToBeVPN will remove its network helper."
		set doneText to "ToBeVPN has been removed."
		set failText to "Could not remove ToBeVPN: "
	end if

	try
		display dialog askText buttons {cancelLabel, removeLabel} default button removeLabel cancel button cancelLabel with title "ToBeVPN" with icon caution
	on error number -128
		return
	end try

	-- The app first, so it does not reconnect or rewrite its files.
	try
		if application id "com.tobevpn.desktop" is running then
			tell application id "com.tobevpn.desktop" to quit
			delay 2
		end if
	end try

	set helper to "/Library/PrivilegedHelperTools/app.tobevpn.helper"
	-- As root: the helper's own uninstall (tunnel down, DNS back, its files),
	-- then the same files directly for a helper that has no uninstall yet,
	-- and the app wherever it is installed.
	set rootScript to "if [ -x " & helper & " ]; then " & helper & " uninstall || " & helper & " stop || true; fi; " & ¬
		"rm -rf /var/run/tobevpn; " & ¬
		"rm -f /Library/PrivilegedHelperTools/app.tobevpn.tun2socks /etc/sudoers.d/tobevpn " & helper & "; " & ¬
		"rm -rf /Applications/ToBeVPN.app"
	try
		do shell script rootScript with administrator privileges with prompt promptText
	on error errorText number errorNumber
		if errorNumber is -128 then return
		display dialog (failText & errorText) buttons {"OK"} default button "OK" with title "ToBeVPN" with icon stop
		return
	end try

	-- As this user: what the app kept in the home folder.
	set userScript to "pkill -f '[T]oBeVPN.app/Contents/MacOS/' || true; " & ¬
		"launchctl bootout gui/$(id -u)/ToBeVPN 2>/dev/null || true; " & ¬
		"rm -f \"$HOME/Library/LaunchAgents/ToBeVPN.plist\"; " & ¬
		"rm -rf \"$HOME/Applications/ToBeVPN.app\" " & ¬
		"\"$HOME/Library/Application Support/com.tobevpn.desktop\" \"$HOME/Library/Application Support/ToBeVPN\" " & ¬
		"\"$HOME/Library/Caches/tobevpn\" \"$HOME/Library/Caches/com.tobevpn.desktop\" " & ¬
		"\"$HOME/Library/WebKit/com.tobevpn.desktop\" " & ¬
		"\"$HOME/Library/Preferences/com.tobevpn.desktop.plist\" " & ¬
		"\"$HOME/Library/Saved Application State/com.tobevpn.desktop.savedState\"; " & ¬
		"security delete-generic-password -s network.tobevpn.desktop -a device-session-v1 >/dev/null 2>&1 || true"
	try
		do shell script userScript
	end try

	display dialog doneText buttons {"OK"} default button "OK" with title "ToBeVPN"
end run
