import { useRef } from "react";
import "./FadeText.css";

/**
 * Text whose change (a renamed router, a name read anew) fades in instead of
 * switching at once, as on the phone. A new text is a new element that plays
 * the fade.
 */
export default function FadeText({ text, fadeKey }: { text: string; fadeKey?: string }) {
  // A live value (traffic counted each second) passes what it belongs to (the
  // period): it then changes in place and fades only when that changes — and
  // only if the text changes with it, so an equal number ("0", "0 B") stays
  // standing instead of blinking out and in.
  const last = useRef({ key: fadeKey ?? text, text, generation: 0 });
  const key = fadeKey ?? text;
  if (key !== last.current.key) {
    if (text !== last.current.text) last.current.generation += 1;
    last.current.key = key;
  }
  last.current.text = text;
  return (
    <span key={last.current.generation} className="fade-text">
      {text}
    </span>
  );
}
