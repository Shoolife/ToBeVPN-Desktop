import "./TopbarRefreshButton.css";

export default function TopbarRefreshButton({
  label,
  loading,
  disabled = loading,
  onClick,
}: {
  label: string;
  loading: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
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
          loading ? "topbar-refresh__icon--spinning" : ""
        }`}
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
  );
}
