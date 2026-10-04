import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import "./ScrollEdgeAffordance.css";

interface ScrollEdgeAffordanceProps
  extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  as?: "div" | "main";
  children: ReactNode;
  /**
   * Fade the edges with background-coloured overlays instead of a mask. For
   * lists whose rows WebKitGTK composites separately (swipeable rows): the
   * mask left a hard line where such a row met the top edge.
   */
  overlayFade?: boolean;
}

interface ScrollEdges {
  top: boolean;
  bottom: boolean;
}

export default function ScrollEdgeAffordance({
  as = "div",
  className = "",
  children,
  overlayFade = false,
  onScroll,
  style,
  ...rest
}: ScrollEdgeAffordanceProps) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayFadeRef = useRef(overlayFade);
  overlayFadeRef.current = overlayFade;
  const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame: number | null = null;

    const update = () => {
      frame = null;
      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const next = {
        top: maxScroll > 1 && viewport.scrollTop > 1,
        bottom: maxScroll > 1 && viewport.scrollTop < maxScroll - 1,
      };
      setEdges((current) =>
        current.top === next.top && current.bottom === next.bottom ? current : next,
      );
      // The fade grows with the first 38px of scroll instead of popping in,
      // so the top edge behaves like the bottom one. Written straight to the
      // DOM every scroll frame; a React re-render would lag and snap.
      const remaining = Math.max(0, maxScroll - viewport.scrollTop);
      const fadeTop = maxScroll > 1 ? Math.min(1, viewport.scrollTop / EDGE_FADE_PX) : 0;
      const fadeBottom = maxScroll > 1 ? Math.min(1, remaining / EDGE_FADE_PX) : 0;
      if (overlayFadeRef.current) {
        const root = rootRef.current;
        root?.style.setProperty("--edge-fade-top", String(fadeTop));
        root?.style.setProperty("--edge-fade-bottom", String(fadeBottom));
      } else {
        applyEdgeFade(viewport);
      }
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    const observeSizes = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(viewport);
      Array.from(viewport.children).forEach((child) => resizeObserver.observe(child));
      scheduleUpdate();
    };
    const mutationObserver = new MutationObserver(observeSizes);
    mutationObserver.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    observeSizes();

    void document.fonts?.ready.then(scheduleUpdate).catch(() => {});

    return () => {
      viewport.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  const Tag = as;

  return (
    <div className="scroll-edge-affordance" ref={rootRef}>
      <Tag
        {...rest}
        ref={(element) => { viewportRef.current = element; }}
        className={`${className} scroll-edge-affordance__viewport`.trim()}
        onScroll={(event) => onScroll?.(event)}
        style={style as CSSProperties}
      >
        {children}
      </Tag>

      {overlayFade && (
        <>
          <div
            className={`scroll-edge-affordance__fade scroll-edge-affordance__fade--top ${edges.top ? "is-visible" : ""}`}
            aria-hidden="true"
          />
          <div
            className={`scroll-edge-affordance__fade scroll-edge-affordance__fade--bottom ${edges.bottom ? "is-visible" : ""}`}
            aria-hidden="true"
          />
        </>
      )}

      <div
        className={`scroll-edge-affordance__arrow scroll-edge-affordance__arrow--top ${edges.top ? "is-visible" : ""}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </div>
      <div
        className={`scroll-edge-affordance__arrow scroll-edge-affordance__arrow--bottom ${edges.bottom ? "is-visible" : ""}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>
  );
}

const EDGE_FADE_PX = 38;

/** A mask that fades each edge by the given amount (0 = no fade, 1 = full). */
export function edgeFadeMask(fadeTop: number, fadeBottom: number, fadePx = EDGE_FADE_PX): string {
  const top = (1 - fadeTop).toFixed(3);
  const bottom = (1 - fadeBottom).toFixed(3);
  return `linear-gradient(to bottom, rgba(0,0,0,${top}) 0, #000 ${fadePx}px, #000 calc(100% - ${fadePx}px), rgba(0,0,0,${bottom}) 100%)`;
}

/**
 * Gradual edge fade for any scrolling element: each edge fades in over the
 * first `fadePx` of scroll instead of popping in. Call on every scroll and
 * when the content size changes; it writes the mask straight to the element.
 */
export function applyEdgeFade(element: HTMLElement, fadePx = EDGE_FADE_PX): void {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
  const mask = edgeFadeMask(
    maxScroll > 1 ? Math.min(1, element.scrollTop / fadePx) : 0,
    maxScroll > 1 ? Math.min(1, (maxScroll - element.scrollTop) / fadePx) : 0,
    fadePx,
  );
  element.style.setProperty("-webkit-mask-image", mask);
  element.style.setProperty("mask-image", mask);
}
