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
}

interface ScrollEdges {
  top: boolean;
  bottom: boolean;
}

export default function ScrollEdgeAffordance({
  as = "div",
  className = "",
  children,
  onScroll,
  style,
  ...rest
}: ScrollEdgeAffordanceProps) {
  const viewportRef = useRef<HTMLElement | null>(null);
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

  const mask = `linear-gradient(to bottom, ${edges.top ? "transparent" : "#000"} 0, #000 38px, #000 calc(100% - 38px), ${edges.bottom ? "transparent" : "#000"} 100%)`;
  const Tag = as;

  return (
    <div className="scroll-edge-affordance">
      <Tag
        {...rest}
        ref={(element) => { viewportRef.current = element; }}
        className={`${className} scroll-edge-affordance__viewport`.trim()}
        onScroll={(event) => onScroll?.(event)}
        style={{
          ...style,
          WebkitMaskImage: mask,
          maskImage: mask,
        } as CSSProperties}
      >
        {children}
      </Tag>

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
