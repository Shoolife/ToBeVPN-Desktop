import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getSavedLang, t, tf } from "../i18n";
import {
  deleteDiagnosticLog,
  exportDiagnosticLog,
  listDiagnosticLogs,
  refreshDiagnosticState,
  setDiagnosticCollection,
  type DiagnosticLogFileInfo,
  type DiagnosticState,
} from "../session/diagnostics";
import Spinner from "./Spinner";
import MaterialIcon from "./MaterialIcon";
import { isBrowserPreviewRuntime } from "../session/browserPreview";
import "./DiagnosticsPanel.css";

function formatBytes(bytes: number): string {
  const units = getSavedLang() === "ru"
    ? { bytes: "Б", kilobytes: "КБ", megabytes: "МБ" }
    : { bytes: "B", kilobytes: "KB", megabytes: "MB" };
  if (bytes < 1024) return `${bytes} ${units.bytes}`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} ${units.kilobytes}`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${units.megabytes}`;
}

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(getSavedLang() === "ru" ? "ru-RU" : "en-US", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(parsed);
}

function formatCompactDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(getSavedLang() === "ru" ? "ru-RU" : "en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsed);
}

function ScrollArrows({ top, bottom }: { top: boolean; bottom: boolean }) {
  return (
    <>
      <div className={`diagnostics-scroll-arrow diagnostics-scroll-arrow--top ${top ? "is-visible" : ""}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15" /></svg>
      </div>
      <div className={`diagnostics-scroll-arrow diagnostics-scroll-arrow--bottom ${bottom ? "is-visible" : ""}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      </div>
    </>
  );
}

function useScrollFades(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(false);
  const [bottom, setBottom] = useState(false);
  const update = () => {
    const element = ref.current;
    if (!element) return;
    setTop(element.scrollTop > 1);
    setBottom(element.scrollTop < element.scrollHeight - element.clientHeight - 1);
  };
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return { ref, top, bottom, update };
}

function ModalFrame({
  children,
  onClose,
  className = "",
  placement = "center",
  canClose = true,
}: {
  children: React.ReactNode | ((requestClose: () => void) => React.ReactNode);
  onClose: () => void;
  className?: string;
  placement?: "center" | "bottom";
  canClose?: boolean;
}) {
  const isBottomSheet = placement === "bottom";
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const requestClose = useCallback(() => {
    if (!canClose) return;
    if (closeTimerRef.current !== null) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, isBottomSheet ? 300 : 180);
  }, [canClose, isBottomSheet, onClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
  }, []);

  const target = document.getElementById("overlay-root") ?? document.body;
  return createPortal(
    <div
      className={`diagnostics-overlay ${isBottomSheet ? "diagnostics-overlay--bottom" : ""} ${closing ? "diagnostics-overlay--closing" : ""}`}
      onMouseDown={requestClose}
    >
      <div
        className={`diagnostics-modal ${className} ${closing ? "diagnostics-modal--closing" : ""}`}
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {typeof children === "function" ? children(requestClose) : children}
      </div>
    </div>,
    target,
  );
}

function DiagnosticsInfoDialog({ onClose }: { onClose: () => void }) {
  const fades = useScrollFades(true);
  return (
    <ModalFrame onClose={onClose} className="diagnostics-modal--info">
      {(requestClose) => (
        <>
          <div className="diagnostics-modal__icon" aria-hidden="true">
            <MaterialIcon name="bugReportOutlined" size={32} />
          </div>
          <div className="diagnostics-modal__title">{t("diagnostics_info_title")}</div>
          <div className="diagnostics-scroll-shell">
            <div
              className="diagnostics-info-scroll"
              ref={fades.ref}
              onScroll={fades.update}
              style={{
                WebkitMaskImage: `linear-gradient(to bottom, ${fades.top ? "transparent" : "#000"} 0, #000 34px, #000 calc(100% - 34px), ${fades.bottom ? "transparent" : "#000"} 100%)`,
                maskImage: `linear-gradient(to bottom, ${fades.top ? "transparent" : "#000"} 0, #000 34px, #000 calc(100% - 34px), ${fades.bottom ? "transparent" : "#000"} 100%)`,
              }}
            >
              <p>{t("diagnostics_info_manual")}</p>
              <p>{t("diagnostics_info_persistence")}</p>
              <p>{t("diagnostics_info_contents")}</p>
              <p>{t("diagnostics_info_daily")}</p>
              <p>{t("diagnostics_info_privacy")}</p>
              <p>{t("diagnostics_info_share")}</p>
            </div>
            <ScrollArrows top={fades.top} bottom={fades.bottom} />
          </div>
          <button className="diagnostics-modal__done" onClick={requestClose}>
            {t("diagnostics_info_done")}
          </button>
        </>
      )}
    </ModalFrame>
  );
}

function DiagnosticHistoryDialog({
  logs,
  loading,
  deleting,
  onClose,
  onExport,
  onDelete,
}: {
  logs: DiagnosticLogFileInfo[];
  loading: boolean;
  deleting: string | null;
  onClose: () => void;
  onExport: (fileName: string) => void;
  onDelete: (log: DiagnosticLogFileInfo) => void;
}) {
  const fades = useScrollFades(true);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ModalFrame onClose={onClose} className="diagnostics-modal--history" placement="bottom">
      <div className="diagnostics-sheet-handle" aria-hidden="true"><span /></div>
      <div className="diagnostics-modal__title">{t("diagnostics_history_title")}</div>
      <div className="diagnostics-modal__description">{t("diagnostics_history_description")}</div>
      <div className="diagnostics-scroll-shell diagnostics-history-shell">
        <div
          className="diagnostics-history"
          ref={fades.ref}
          onScroll={fades.update}
          style={{
            WebkitMaskImage: `linear-gradient(to bottom, ${fades.top ? "transparent" : "#000"} 0, #000 30px, #000 calc(100% - 30px), ${fades.bottom ? "transparent" : "#000"} 100%)`,
            maskImage: `linear-gradient(to bottom, ${fades.top ? "transparent" : "#000"} 0, #000 30px, #000 calc(100% - 30px), ${fades.bottom ? "transparent" : "#000"} 100%)`,
          }}
        >
          {loading ? (
            <div className="diagnostics-history__empty"><Spinner size={30} thickness={3} /></div>
          ) : logs.length === 0 ? (
            <div className="diagnostics-history__empty">{t("diagnostics_history_empty")}</div>
          ) : logs.map((log) => (
            <div className="diagnostics-history-item" key={log.fileName}>
              <div className="diagnostics-history-item__icon">
                <MaterialIcon name="descriptionOutlined" size={22} />
              </div>
              <div className="diagnostics-history-item__content">
                <div className="diagnostics-history-item__date">
                  {log.date === today ? t("diagnostics_history_today") : formatDate(log.date)}
                </div>
                <div className="diagnostics-history-item__size">
                  {log.date === today
                    ? `${formatCompactDate(log.date)} · ${formatBytes(log.sizeBytes)}`
                    : formatBytes(log.sizeBytes)}
                </div>
              </div>
              <button
                className="diagnostics-history-item__action"
                onClick={() => onExport(log.fileName)}
                title={t("diagnostics_history_export")}
                aria-label={t("diagnostics_history_export")}
              >
                <MaterialIcon name="shareOutlined" size={22} />
              </button>
              <button
                className="diagnostics-history-item__action diagnostics-history-item__action--delete"
                onClick={() => onDelete(log)}
                disabled={deleting === log.fileName}
                title={t("diagnostics_history_delete")}
                aria-label={t("diagnostics_history_delete")}
              >
                {deleting === log.fileName ? <Spinner size={18} thickness={2.5} /> : (
                  <MaterialIcon name="deleteOutline" size={22} />
                )}
              </button>
            </div>
          ))}
        </div>
        <ScrollArrows top={fades.top} bottom={fades.bottom} />
      </div>
    </ModalFrame>
  );
}

export default function DiagnosticsPanel({
  state,
  onNotice,
}: {
  state: DiagnosticState;
  onNotice: (message: string) => void;
}) {
  const previewModal = isBrowserPreviewRuntime()
    ? new URLSearchParams(window.location.search).get("diagnosticsModal")
    : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(previewModal === "info");
  const [historyOpen, setHistoryOpen] = useState(previewModal === "history");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [logs, setLogs] = useState<DiagnosticLogFileInfo[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DiagnosticLogFileInfo | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!state.collecting) return;
    const interval = window.setInterval(() => {
      void refreshDiagnosticState().catch(() => {});
    }, 5000);
    return () => window.clearInterval(interval);
  }, [state.collecting]);

  useEffect(() => {
    if (previewModal !== "history") return;
    setHistoryLoading(true);
    void listDiagnosticLogs()
      .then(setLogs)
      .finally(() => setHistoryLoading(false));
  }, [previewModal]);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch {
      setError(t("diagnostics_operation_failed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleCollection = () => run(async () => {
    const next = await setDiagnosticCollection(!state.collecting);
    onNotice(next.collecting ? t("diagnostics_collection_started") : t("diagnostics_collection_stopped"));
  });

  const exportLog = (fileName?: string) => run(async () => {
    if (!fileName && !state.hasCurrentLog) {
      setError(t("diagnostics_no_log_to_export"));
      return;
    }
    const path = await exportDiagnosticLog(fileName);
    onNotice(tf("diagnostics_exported", path));
  });

  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setError(null);
    try {
      setLogs(await listDiagnosticLogs());
    } catch {
      setError(t("diagnostics_operation_failed"));
    } finally {
      setHistoryLoading(false);
    }
  };

  const confirmDelete = async (closeDialog: () => void) => {
    if (!deleteTarget || deleting) return;
    setDeleting(deleteTarget.fileName);
    try {
      await deleteDiagnosticLog(deleteTarget.fileName);
      setLogs(await listDiagnosticLogs());
      closeDialog();
      onNotice(t("diagnostics_log_deleted"));
    } catch {
      setError(t("diagnostics_operation_failed"));
    } finally {
      setDeleting(null);
    }
  };

  const summary = state.hasCurrentLog && state.currentLogDate
    ? tf("diagnostics_log_summary", formatDate(state.currentLogDate), formatBytes(state.currentLogSizeBytes))
    : t("diagnostics_log_empty");

  return (
    <>
      <div className={`diagnostics-card ${state.collecting ? "is-collecting" : ""}`}>
        <div className="diagnostics-card__head">
          <div className="diagnostics-card__icon">
            <MaterialIcon name="bugReportOutlined" size={23} />
          </div>
          <div className="diagnostics-card__heading">
            <div className="diagnostics-card__title">{t("diagnostics_title")}</div>
            <div className={`diagnostics-card__status ${state.collecting ? "is-active" : ""}`}>
              {state.collecting ? t("diagnostics_status_collecting") : t("diagnostics_status_stopped")}
            </div>
          </div>
          <button
            className="diagnostics-card__info"
            onClick={() => setInfoOpen(true)}
            aria-label={t("diagnostics_info_button")}
            title={t("diagnostics_info_button")}
          >
            <MaterialIcon name="info" size={24} />
          </button>
        </div>

        <div className="diagnostics-card__summary">{summary}</div>
        {error && <div className="diagnostics-card__error">{error}</div>}

        <div className="diagnostics-card__actions">
          <button
            className={`diagnostics-action diagnostics-action--collection ${state.collecting ? "is-stop" : ""}`}
            onClick={toggleCollection}
            disabled={busy}
          >
            {busy
              ? <Spinner size={18} thickness={2.5} />
              : state.collecting ? t("diagnostics_stop") : t("diagnostics_start")}
          </button>
          <button className="diagnostics-action" onClick={openHistory} disabled={busy}>
            {t("diagnostics_history_button")}
          </button>
        </div>
      </div>

      {infoOpen && <DiagnosticsInfoDialog onClose={() => setInfoOpen(false)} />}
      {historyOpen && (
        <DiagnosticHistoryDialog
          logs={logs}
          loading={historyLoading}
          deleting={deleting}
          onClose={() => setHistoryOpen(false)}
          onExport={(fileName) => exportLog(fileName)}
          onDelete={setDeleteTarget}
        />
      )}
      {deleteTarget && (
        <ModalFrame
          onClose={() => setDeleteTarget(null)}
          className="diagnostics-modal--confirm"
          canClose={!deleting}
        >
          {(requestClose) => (
            <>
              <div className="diagnostics-modal__title">{t("diagnostics_history_delete_title")}</div>
              <div className="diagnostics-modal__description">
                {tf("diagnostics_history_delete_message", formatDate(deleteTarget.date))}
              </div>
              <div className="diagnostics-confirm-actions">
                <button onClick={requestClose} disabled={Boolean(deleting)}>{t("cancel")}</button>
                <button className="is-danger" onClick={() => confirmDelete(requestClose)} disabled={Boolean(deleting)}>
                  {deleting ? <Spinner size={18} thickness={2.5} /> : t("diagnostics_history_delete_confirm")}
                </button>
              </div>
            </>
          )}
        </ModalFrame>
      )}
    </>
  );
}
