import { useEffect, useRef, useState } from "react";
import type { StringKey } from "../i18n";
import { t } from "../i18n";
import "./TopbarRefreshButton.css";

// Each screen's refresh button explains itself once: a hint appears under it
// for a few seconds the first time the screen opens, then never again for
// that screen (remembered in local storage).
const SEEN_KEY = "tobevpn_refresh_hints_seen_v1";
const HINT_DELAY_MS = 900;
const HINT_VISIBLE_MS = 7_000;

function hintSeen(id: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, unknown>;
    return seen[id] === true;
  } catch {
    // Without storage the hint would show every time: better not at all.
    return true;
  }
}

function markHintSeen(id: string): void {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, unknown>;
    seen[id] = true;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Shown once more next time at worst.
  }
}

export default function TopbarRefreshButton({
  label,
  loading,
  disabled = loading,
  onClick,
  hint,
}: {
  label: string;
  loading: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** One-time hint under the button: a screen id and its text. */
  hint?: { id: string; text: StringKey };
}) {
  const [hintVisible, setHintVisible] = useState(false);
  // As on the phone: told to stop, the icon finishes its turn and comes to
  // rest upright instead of jumping back mid-turn.
  const [spinning, setSpinning] = useState(loading);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  useEffect(() => {
    if (loading) setSpinning(true);
  }, [loading]);

  useEffect(() => {
    if (!hint || hintSeen(hint.id)) return;
    let hideTimer = 0;
    const hide = () => setHintVisible(false);
    const showTimer = window.setTimeout(() => {
      markHintSeen(hint.id);
      setHintVisible(true);
      hideTimer = window.setTimeout(hide, HINT_VISIBLE_MS);
      window.addEventListener("pointerdown", hide, { once: true });
      window.addEventListener("keydown", hide, { once: true });
    }, HINT_DELAY_MS);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      window.removeEventListener("pointerdown", hide);
      window.removeEventListener("keydown", hide);
    };
  }, [hint?.id]);

  return (
    <span className="topbar-refresh-wrap">
      <button
        type="button"
        className="topbar-refresh"
        title={label}
        aria-label={label}
        aria-busy={loading}
        onClick={onClick}
        disabled={disabled}
      >
        <svg
          className={`topbar-refresh__icon ${
            spinning ? "topbar-refresh__icon--spinning" : ""
          }`}
          onAnimationIteration={() => {
            if (!loadingRef.current) setSpinning(false);
          }}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
      {hint && hintVisible && (
        <span className="topbar-hint" role="status">
          {t(hint.text)}
        </span>
      )}
    </span>
  );
}
