import { useEffect, useRef, useState, type ReactNode } from "react";
import "./FadeSwap.css";

/** A shown layer fades out in this time (FadeSwap.css). */
const OUT_MS = 150;
/** From the loader's mount: the block takes its size, it fades in, holds. */
const LOADER_HOLD_MS = 820;

/** The loader's box is never lower than this (its 84 px mark with room). */
const LOADER_MIN_HEIGHT = 112;

/** The loader step keeps the height the block had, so it does not shrink
 *  for the loader and grow back for content of the same size. */
type Shown = { kind: "content"; key: string } | { kind: "loader"; height: number };

/**
 * Content that changes with `swapKey` (a form opening, a result arriving,
 * the way back) changes in steps, in both directions: the old content fades
 * out, the block (inside SmoothHeight) takes the loader's size and the brand
 * loader shows, centred and still; then it fades out, the block takes the
 * new size and the new content fades in (FadeSwap.css). Nothing is visible
 * while the size changes, so nothing is cut by the moving edge. The loader
 * keeps the height the block had, so the block changes size at most once.
 * A key in `loaderKeys` (waiting for an answer) is the loader step itself
 * until the key changes. Without a `loader` the step is skipped. While the
 * key stays the same the content updates in place (typing).
 */
export default function FadeSwap({
  swapKey,
  children,
  loader,
  loaderKeys = [],
}: {
  swapKey: string;
  children: ReactNode;
  /** The brand loader, shown as its own step between two contents. */
  loader?: ReactNode;
  /** Keys whose content is the loader step itself (waiting for an answer):
   *  it stays until the key changes, then gives way without a second loader. */
  loaderKeys?: string[];
}) {
  const [shown, setShown] = useState<Shown>({ kind: "content", key: swapKey });
  const [leaving, setLeaving] = useState(false);
  // What the shown key showed last, kept on screen while it fades out.
  const lastNode = useRef<ReactNode>(children);
  // The first content appears with the screen, without steps of its own.
  const swapped = useRef(false);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const waiting = loaderKeys.includes(swapKey);
    if ((shown.kind === "content" && shown.key === swapKey) || (shown.kind === "loader" && waiting)) {
      // Back to what is shown before it had gone: it simply stays.
      setLeaving(false);
      return;
    }
    const timers: number[] = [];
    const later = (ms: number, step: () => void) => timers.push(window.setTimeout(step, ms));
    const showNew = () => {
      swapped.current = true;
      setShown({ kind: "content", key: swapKey });
      setLeaving(false);
    };
    // Measured now, while what is shown still holds the block's height.
    const height = Math.max(LOADER_MIN_HEIGHT, layerRef.current?.offsetHeight ?? 0);
    const showLoader = () => {
      swapped.current = true;
      setShown({ kind: "loader", height });
      setLeaving(false);
    };
    setLeaving(true);
    if (waiting) {
      later(OUT_MS, showLoader);
    } else if (shown.kind === "loader" || loader === undefined) {
      later(OUT_MS, showNew);
    } else {
      later(OUT_MS, showLoader);
      later(OUT_MS + LOADER_HOLD_MS, () => setLeaving(true));
      later(OUT_MS + LOADER_HOLD_MS + OUT_MS, showNew);
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapKey]);

  const live = shown.kind === "content" && shown.key === swapKey && !leaving;
  useEffect(() => {
    if (live) lastNode.current = children;
  });

  const layerClass = `fade-swap__layer ${leaving ? "fade-swap__layer--out" : swapped.current ? "fade-swap__layer--in" : ""}`;
  return (
    <div className="fade-swap">
      {shown.kind === "loader" ? (
        <div key="loader" ref={layerRef} className={layerClass} aria-hidden="true">
          <div className="fade-swap__loader" style={{ height: shown.height }}>{loader}</div>
        </div>
      ) : (
        <div
          key={shown.key}
          ref={layerRef}
          className={layerClass}
          aria-hidden={leaving || undefined}
          inert={leaving || undefined}
        >
          {shown.key === swapKey && !leaving ? children : lastNode.current}
        </div>
      )}
    </div>
  );
}

/**
 * A part that opens and closes with a fold and a fade (an error line, a
 * loader), keeping what it showed while it closes.
 */
export function FoldIn({ open, children }: { open: boolean; children: ReactNode }) {
  const kept = useRef<ReactNode>(children);
  if (open) kept.current = children;
  return (
    <div className={`fold-in ${open ? "fold-in--open" : ""}`} aria-hidden={!open || undefined}>
      <div className="fold-in__inner">{open ? children : kept.current}</div>
    </div>
  );
}
