import "./Spinner.css";

export default function Spinner({
  size = 32,
  thickness = 3,
  className = "",
}: {
  size?: number;
  thickness?: number;
  className?: string;
}) {
  return (
    <span
      className={`spinner ${className}`}
      style={{
        width: size,
        height: size,
        borderWidth: thickness,
      }}
      role="status"
      aria-label="loading"
    />
  );
}
