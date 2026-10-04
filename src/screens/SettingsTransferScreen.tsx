import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t, tf } from "../i18n";
import MaterialIcon, { type MaterialIconName } from "../components/MaterialIcon";
import ScrollEdgeAffordance from "../components/ScrollEdgeAffordance";
import { useAnimatedDialogClose } from "../components/useAnimatedDialogClose";
import { recordDiagnosticEvent } from "../session/diagnostics";
import {
  MAX_SETTINGS_FILE_BYTES,
  SETTINGS_TRANSFER_SECTION_COUNT,
  applySettingsImport,
  countSelected,
  decodeSettingsDocument,
  exportSettingsFile,
  previewSettingsDocument,
  type SettingsImportPreview,
  type SettingsTransferSelection,
} from "../session/settingsTransfer";
import "../components/WhatsNewDialog.css";
import "./SettingsScreen.css";
import "./SettingsTransferScreen.css";

const ALL_SELECTED: SettingsTransferSelection = { language: true, theme: true, display: true, routing: true };

interface ChoiceItem {
  key: keyof SettingsTransferSelection;
  icon: MaterialIconName;
  title: string;
  description: string;
}

function choiceItems(): ChoiceItem[] {
  return [
    { key: "language", icon: "language", title: t("settings_transfer_language"), description: t("settings_transfer_language_desc") },
    { key: "theme", icon: "palette", title: t("settings_transfer_theme"), description: t("settings_transfer_theme_desc") },
    { key: "display", icon: "openInFull", title: t("settings_transfer_display"), description: t("settings_transfer_display_desc") },
    { key: "routing", icon: "altRoute", title: t("settings_transfer_routing"), description: t("settings_transfer_routing_desc") },
  ];
}

// Ported from the Android client's SettingsTransferScreen.
export default function SettingsTransferScreen({ onBack }: { onBack: () => void }) {
  const [exportSelection, setExportSelection] = useState<SettingsTransferSelection>(ALL_SELECTED);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [preview, setPreview] = useState<SettingsImportPreview | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedCount = countSelected(exportSelection);
  const summary =
    selectedCount === 0 ? t("settings_transfer_nothing_selected")
    : selectedCount === SETTINGS_TRANSFER_SECTION_COUNT ? t("settings_transfer_all_settings")
    : tf("settings_transfer_selected_count", selectedCount, SETTINGS_TRANSFER_SECTION_COUNT);

  const runExport = async () => {
    if (busy || selectedCount === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const path = await exportSettingsFile(exportSelection);
      setMessage({ text: tf("settings_transfer_export_saved", path), error: false });
    } catch (error) {
      recordDiagnosticEvent("SettingsTransfer", `Settings export failed: ${String(error)}`, "W");
      setMessage({ text: t("settings_transfer_error"), error: true });
    } finally {
      setBusy(false);
    }
  };

  const onFileChosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setMessage(null);
    try {
      if (file.size > MAX_SETTINGS_FILE_BYTES) throw new Error("Settings file is too large");
      const document = decodeSettingsDocument(await file.text());
      const nextPreview = previewSettingsDocument(document);
      if (countSelected(nextPreview.available) === 0) throw new Error("Nothing applicable on desktop");
      setPreview(nextPreview);
    } catch (error) {
      recordDiagnosticEvent("SettingsTransfer", `Settings import read failed: ${String(error)}`, "W");
      setMessage({ text: t("settings_transfer_error"), error: true });
    }
  };

  return (
    <div className="transfer-root">
      <div className="transfer-topbar">
        <button className="transfer-topbar__back" onClick={onBack} aria-label={t("back")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="transfer-topbar__title">{t("settings_transfer_title")}</span>
      </div>

      <ScrollEdgeAffordance className="transfer-content">
        <div className="transfer-card transfer-privacy">
          <span className="transfer-icon transfer-icon--orange"><MaterialIcon name="security" size={22} /></span>
          <div>
            <div className="transfer-card__title">{t("settings_transfer_private_title")}</div>
            <div className="transfer-card__text">{t("settings_transfer_private_description")}</div>
          </div>
        </div>

        <TransferCard
          icon="uploadFile"
          accent="blue"
          title={t("settings_transfer_export_title")}
          description={t("settings_transfer_export_description")}
        >
          <button
            type="button"
            className={`transfer-summary ${optionsExpanded ? "transfer-summary--open" : ""}`}
            onClick={() => setOptionsExpanded((value) => !value)}
            aria-expanded={optionsExpanded}
          >
            <span>{summary}</span>
            <MaterialIcon name="keyboardArrowDown" size={24} className="transfer-summary__arrow" />
          </button>
          <div className={`transfer-options ${optionsExpanded ? "transfer-options--open" : ""}`}>
            <div className="transfer-options__inner">
              {choiceItems().map((item) => (
                <ChoiceRow
                  key={item.key}
                  item={item}
                  checked={exportSelection[item.key]}
                  onChange={(value) => setExportSelection((prev) => ({ ...prev, [item.key]: value }))}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            className="transfer-primary"
            disabled={busy || selectedCount === 0}
            onClick={() => void runExport()}
          >
            {t("settings_transfer_export_action")}
          </button>
        </TransferCard>

        <TransferCard
          icon="fileOpen"
          accent="teal"
          title={t("settings_transfer_import_title")}
          description={t("settings_transfer_import_description")}
        >
          <button
            type="button"
            className="transfer-secondary"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {t("settings_transfer_choose_file")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json,text/plain"
            hidden
            onChange={(event) => void onFileChosen(event)}
          />
        </TransferCard>

        {message && (
          <div className={`transfer-message ${message.error ? "transfer-message--error" : ""}`} role="status">
            {message.text}
          </div>
        )}
      </ScrollEdgeAffordance>

      {preview && (
        <ImportDialog
          preview={preview}
          onDismiss={() => setPreview(null)}
          onImported={(reload) => {
            setPreview(null);
            if (reload) {
              window.location.reload();
            } else {
              setMessage({ text: t("settings_transfer_import_success"), error: false });
            }
          }}
          onFailed={() => {
            setPreview(null);
            setMessage({ text: t("settings_transfer_error"), error: true });
          }}
        />
      )}
    </div>
  );
}

function TransferCard({
  icon,
  accent,
  title,
  description,
  children,
}: {
  icon: MaterialIconName;
  accent: "blue" | "teal";
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="transfer-card">
      <div className="transfer-card__head">
        <span className={`transfer-icon transfer-icon--${accent}`}><MaterialIcon name={icon} size={22} /></span>
        <div className="transfer-card__head-text">
          <div className="transfer-card__title">{title}</div>
          <div className="transfer-card__text">{description}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function ChoiceRow({
  item,
  checked,
  disabled = false,
  description,
  onChange,
}: {
  item: ChoiceItem;
  checked: boolean;
  disabled?: boolean;
  description?: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="transfer-choice"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <MaterialIcon name={item.icon} size={22} className="transfer-choice__icon" />
      <span className="transfer-choice__text">
        <span className="transfer-choice__title">{item.title}</span>
        <span className="transfer-choice__desc">{description ?? item.description}</span>
      </span>
      <span className={`settings-switch ${checked ? "settings-switch--on" : ""}`} aria-hidden="true">
        <span className="settings-switch__thumb" />
      </span>
    </button>
  );
}

function ImportDialog({
  preview,
  onDismiss,
  onImported,
  onFailed,
}: {
  preview: SettingsImportPreview;
  onDismiss: () => void;
  onImported: (reload: boolean) => void;
  onFailed: () => void;
}) {
  const { closing, requestClose } = useAnimatedDialogClose(onDismiss);
  const [selection, setSelection] = useState<SettingsTransferSelection>(preview.available);
  const [busy, setBusy] = useState(false);
  const items = choiceItems().filter((item) => preview.available[item.key]);

  const apply = async () => {
    if (busy || countSelected(selection) === 0) return;
    setBusy(true);
    try {
      onImported(await applySettingsImport(preview, selection));
    } catch (error) {
      recordDiagnosticEvent("SettingsTransfer", `Settings import apply failed: ${String(error)}`, "W");
      onFailed();
    }
  };

  const target = document.getElementById("overlay-root") ?? document.body;
  return createPortal(
    <div
      className={`whats-new-overlay ${closing ? "whats-new-overlay--closing" : ""}`}
      onClick={() => !busy && requestClose()}
    >
      <div
        className="whats-new-dialog transfer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="transfer-dialog-title" className="transfer-dialog__title">{t("settings_transfer_import_title")}</h2>
        <p className="transfer-card__text">{t("settings_transfer_file_contents")}</p>
        <div className="transfer-dialog__list">
          {items.map((item) => (
            <ChoiceRow
              key={item.key}
              item={item}
              checked={selection[item.key]}
              disabled={busy}
              onChange={(value) => setSelection((prev) => ({ ...prev, [item.key]: value }))}
            />
          ))}
        </div>
        <div className="dialog__actions dialog__actions--logout">
          <button
            type="button"
            className="dialog__btn dialog__btn--secondary"
            disabled={busy}
            onClick={() => requestClose()}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="dialog__btn dialog__btn--primary"
            disabled={busy || countSelected(selection) === 0}
            onClick={() => void apply()}
          >
            {t("settings_transfer_import_confirm")}
          </button>
        </div>
      </div>
    </div>,
    target,
  );
}
