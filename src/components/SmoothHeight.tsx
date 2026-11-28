import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Room around the content for what is drawn outside it (a field's focus ring). */
const BLEED = 4;

/**
 * Follows its content's height with an even motion instead of a jump: a
 * form opening, a check result arriving, a loader giving way to a card.
 * With `bleed` it clips BLEED past its content, so a focused field's ring
 * near its edge is not cut; the layout does not move. Put it inside a card,
 * not around it, so the card's own rounded edge is never clipped.
 *
 * No mask while it moves: the screen's scroll area is masked already, and a
 * nested mask switched on and off made WebKitGTK repaint the whole screen,
 * which shook.
 */
export default function SmoothHeight({
  children,
  duration = 420,
  bleed = false,
}: {
  children: ReactNode;
  duration?: number;
  bleed?: boolean;
}) {
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
        // A layer of its own for the whole life, as the app's other height
        // animations (.faq-item__a-wrap): no re-rasterising at start and end.
        willChange: "height",
        ...(bleed ? { margin: -BLEED } : {}),
      }}
    >
      <div ref={innerRef} style={bleed ? { padding: BLEED } : undefined}>{children}</div>
    </div>
  );
}
