fn main() {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut attrs = tauri_build::Attributes::new();

    #[cfg(windows)]
    {
        // Embed our own Windows application manifest:
        //   * requireAdministrator — every launch goes through the UAC prompt,
        //     so route/netsh calls just work without checking is_elevated().
        //   * PerMonitorV2 DPI awareness — match Linux/macOS visual size on
        //     high-DPI Windows displays instead of being upscaled by the OS.
        //   * Common-Controls v6 — required for native Tauri dialogs.
        //   * supportedOS GUIDs for Win 10 / Win 11.
        //
        // Replacing tauri-build's default manifest avoids the CVT1100
        // "duplicate resource" link error we hit when adding embed-manifest.
        let manifest = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}" />
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2,system</dpiAwareness>
    </windowsSettings>
  </application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>"#;
        let win_attrs = tauri_build::WindowsAttributes::new().app_manifest(manifest);
        attrs = attrs.windows_attributes(win_attrs);
    }

    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
