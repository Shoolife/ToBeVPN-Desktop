import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Follows its content's height with an even motion instead of a jump: a
 * form opening, a check result arriving, a loader giving way to a card.
 */
export default function SmoothHeight({ children, duration = 420 }: { children: ReactNode; duration?: number }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    setHeight(inner.offsetHeight);
    const observer = new ResizeObserver(() => setHeight(inner.offsetHeight));
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      style={{
        height: height ?? "auto",
        overflow: "hidden",
        transition: `height ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
        flexShrink: 0,
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
