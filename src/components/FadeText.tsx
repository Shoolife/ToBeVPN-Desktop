import "./FadeText.css";

/**
 * Text whose change (a renamed router, a name read anew) fades in instead of
 * switching at once, as on the phone. Keyed by the text: a new text is a new
 * element that plays the fade.
 */
export default function FadeText({ text }: { text: string }) {
  return (
    <span key={text} className="fade-text">
      {text}
    </span>
  );
}
