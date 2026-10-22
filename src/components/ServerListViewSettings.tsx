import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t, type StringKey } from "../i18n";
import type { MeasuredVpnServer } from "../session/serverQuality";
import {
  ADMIN_DEFAULT_SERVER_LIST_VIEW,
  matchingServerListPreset,
  saveServerListView,
  SERVER_LIST_PRESET_ORDER,
  SERVER_LIST_PRESETS,
  type ServerListPreset,
  type ServerListView,
  type ServerSubtitle,
  useServerListView,
} from "../session/serverListView";
import { ServerListRow } from "../screens/ServersScreen";

const PRESET_COPY: Record<ServerListPreset, { title: StringKey; desc: StringKey }> = {
  detailed: {
    title: "server_list_view_preset_detailed",
    desc: "server_list_view_preset_detailed_desc",
  },
  condensed: {
    title: "server_list_view_preset_condensed",
    desc: "server_list_view_preset_condensed_desc",
  },
  technical: {
    title: "server_list_view_preset_technical",
    desc: "server_list_view_preset_technical_desc",
  },
  address: {
    title: "server_list_view_preset_address",
    desc: "server_list_view_preset_address_desc",
  },
  user: {
    title: "server_list_view_preset_user",
    desc: "server_list_view_preset_user_desc",
  },
  compact: {
    title: "server_list_view_preset_compact",
    desc: "server_list_view_preset_compact_desc",
  },
};

// The whole screen fits the window without scrolling: one preview row, the
// presets in a 3x2 grid and the three line settings as compact rows.

const SUBTITLES: { value: ServerSubtitle; label: StringKey }[] = [
  { value: "country", label: "server_list_view_subtitle_country" },
  { value: "protocol", label: "server_list_view_subtitle_protocol" },
  { value: "protocolFull", label: "server_list_view_subtitle_protocol_full" },
  { value: "none", label: "server_list_view_subtitle_none" },
];

/** Admin-only screen in Personalization: which lines a server row shows. */
export default function ServerListViewSettings({
  previewServers,
}: {
  previewServers: MeasuredVpnServer[];
}) {
  const view = useServerListView();
  const preset = matchingServerListPreset(view);
  const update = (patch: Partial<ServerListView>) => saveServerListView({ ...view, ...patch });

  return (
    <>
      <div className="server-view-preview">
        <div className="server-view-preview__header">
          <span>{t("server_list_view_preview")}</span>
          <span className="server-view-preview__badge">
            {preset ? t(PRESET_COPY[preset].title) : t("server_list_view_custom")}
          </span>
        </div>
        <PreviewStage servers={previewServers} view={view} />
      </div>

      <div className="display-scale-section-label">{t("server_list_view_presets")}</div>
      <div className="server-view-presets">
        {SERVER_LIST_PRESET_ORDER.map((option) => (
          <button
            key={option}
            type="button"
            className={`server-view-preset ${preset === option ? "is-selected" : ""}`}
            aria-pressed={preset === option}
            onClick={() => saveServerListView(SERVER_LIST_PRESETS[option])}
          >
            <PresetSketch view={SERVER_LIST_PRESETS[option]} />
            <span className="server-view-preset__copy">
              <span className="server-view-preset__title">{t(PRESET_COPY[option].title)}</span>
              <span className="server-view-preset__desc">{t(PRESET_COPY[option].desc)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="display-scale-section-label">{t("server_list_view_lines")}</div>
      <div className="display-scale-group">
        <div className="server-view-subtitle">
          <span>{t("server_list_view_subtitle")}</span>
          <div className="server-view-segments" role="radiogroup">
            {SUBTITLES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={view.subtitle === option.value}
                className={`server-view-segment ${view.subtitle === option.value ? "is-selected" : ""}`}
                onClick={() => update({ subtitle: option.value })}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="display-scale-group__divider" />
        <SwitchRow
          title={t("server_list_view_endpoint")}
          checked={view.endpoint}
          onChange={(endpoint) => update({ endpoint })}
        />
        <div className="display-scale-group__divider" />
        <SwitchRow
          title={t("server_list_view_protocol")}
          checked={view.protocol}
          onChange={(protocol) => update({ protocol })}
        />
      </div>
    </>
  );
}

// Longest of the content fades in SettingsScreen.css (delay included).
const PREVIEW_FADE_MS = 320;

interface PreviewLayer {
  id: number;
  view: ServerListView;
  leaving: boolean;
}

/**
 * The preview is the server list itself (real rows, not a drawing). On a view
 * change the card's background is one shape that eases to the new height,
 * while the contents (text, icons, lines) cross-fade on transparent layers:
 * no text is ever re-laid out mid-animation, so nothing shimmers. The stage
 * keeps the height of the tallest view (an invisible "Detailed" card) with
 * the card centred in it, so the controls below never move.
 */
function PreviewStage({
  servers,
  view,
}: {
  servers: MeasuredVpnServer[];
  view: ServerListView;
}) {
  const viewKey = `${view.subtitle}-${view.endpoint}-${view.protocol}`;
  const [layers, setLayers] = useState<PreviewLayer[]>(() => [{ id: 0, view, leaving: false }]);
  const shownKeyRef = useRef(viewKey);
  const nextIdRef = useRef(1);
  const currentLayerRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const currentId = layers[layers.length - 1]?.id;

  // The background follows the card now in front.
  useLayoutEffect(() => {
    const card = currentLayerRef.current?.querySelector<HTMLElement>(".server-item");
    if (card) setCardHeight(card.offsetHeight);
  }, [currentId]);

  useEffect(() => {
    if (viewKey === shownKeyRef.current) return;
    shownKeyRef.current = viewKey;
    const id = nextIdRef.current++;
    setLayers((current) => [
      ...current.map((layer) => ({ ...layer, leaving: true })),
      { id, view, leaving: false },
    ]);
    const timer = window.setTimeout(() => {
      setLayers((current) => current.filter((layer) => !layer.leaving || layer.id > id));
    }, PREVIEW_FADE_MS);
    return () => window.clearTimeout(timer);
    // viewKey carries every field of view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  return (
    <div className="server-view-stage">
      <div className="server-view-stage__sizer" aria-hidden="true">
        {servers.map((server) => (
          <ServerListRow
            key={server.id}
            server={server}
            flagsReady
            view={ADMIN_DEFAULT_SERVER_LIST_VIEW}
          />
        ))}
      </div>
      <div
        className="server-view-stage__card"
        style={cardHeight === null ? undefined : { height: cardHeight }}
        aria-hidden="true"
      />
      {layers.map((layer) => (
        <div
          key={layer.id}
          ref={layer.id === currentId ? currentLayerRef : undefined}
          className={`server-view-stage__layer ${layer.leaving ? "is-leaving" : ""}`}
          aria-hidden={layer.leaving}
        >
          {servers.map((server) => (
            <ServerListRow key={server.id} server={server} flagsReady view={layer.view} />
          ))}
        </div>
      ))}
    </div>
  );
}

function SwitchRow({
  title,
  checked,
  onChange,
}: {
  title: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="display-text-style-row server-view-switch"
      onClick={() => onChange(!checked)}
    >
      <span>{title}</span>
      <span
        className={`settings-switch ${checked ? "settings-switch--on" : ""}`}
        role="switch"
        aria-checked={checked}
      >
        <span className="settings-switch__thumb" />
      </span>
    </button>
  );
}

/** A miniature server card: flag, name bar, optional subtitle and rows. */
function PresetSketch({ view }: { view: ServerListView }) {
  return (
    <span className="server-view-sketch" aria-hidden="true">
      <span className="server-view-sketch__card">
        <span className="server-view-sketch__main">
          <span className="server-view-sketch__flag" />
          <span className="server-view-sketch__text">
            <span className="server-view-sketch__name" />
            {view.subtitle !== "none" && (
              <span
                className={`server-view-sketch__subtitle ${view.subtitle === "protocolFull" ? "server-view-sketch__subtitle--long" : ""}`}
              />
            )}
          </span>
          <span className="server-view-sketch__ping" />
        </span>
        {view.endpoint && <span className="server-view-sketch__row" />}
        {view.protocol && <span className="server-view-sketch__row server-view-sketch__row--short" />}
      </span>
    </span>
  );
}
