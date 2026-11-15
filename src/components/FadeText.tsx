import "./FadeText.css";

/**
 * Text whose change (a renamed router, a name read anew) fades in instead of
 * switching at once, as on the phone. Keyed by the text: a new text is a new
 * element that plays the fade.
 */
export default function FadeText({ text, fadeKey }: { text: string; fadeKey?: string }) {
  // A live value (traffic counted each second) passes what it belongs to (the
  // period): it then changes in place and fades only when that changes.
  return (
    <span key={fadeKey ?? text} className="fade-text">
      {text}
    </span>
  );
}
