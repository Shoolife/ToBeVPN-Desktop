import type { SelectedServer } from "../App";
import ServersScreen from "../screens/ServersScreen";
import type { VpnServer } from "../session/auth";
import "./BrowserServersPreview.css";

function noop() {
  // Browser preview only renders the UI state.
}

export default function BrowserServersPreview({
  servers,
}: {
  servers: VpnServer[];
}) {
  const selectedServer: SelectedServer | null = null;

  return (
    <div className="browser-servers-preview">
      <section className="browser-servers-preview__panel">
        <div className="browser-servers-preview__label">Админ</div>
        <div className="browser-servers-preview__frame">
          <ServersScreen
            onBack={noop}
            onSelect={noop}
            onSelectAutomatic={noop}
            selectedServer={selectedServer}
            automaticServerSelection
            previewServers={servers}
            forceShowEndpoint
          />
        </div>
      </section>
      <section className="browser-servers-preview__panel">
        <div className="browser-servers-preview__label">Обычный пользователь</div>
        <div className="browser-servers-preview__frame">
          <ServersScreen
            onBack={noop}
            onSelect={noop}
            onSelectAutomatic={noop}
            selectedServer={selectedServer}
            automaticServerSelection
            previewServers={servers}
            forceShowEndpoint={false}
          />
        </div>
      </section>
    </div>
  );
}
