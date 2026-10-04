import type { CSSProperties } from "react";
import "./M3Slider.css";

// A stepped slider drawn like Material 3 1.4 on the phone (Slider.kt): a
// 16px track with rounded outer ends, a 4x44px handle with a 6px gap on each
// side, and tick dots. A transparent native range input on top handles
// pointer and keyboard input, so behaviour and accessibility stay standard.

const CORNER = 8; // track height / 2
const GAP = 8; // handle width / 2 + 6px gap

/** Position of a fraction on the track: the end steps sit on the very edge,
 *  inner steps are inset by the corner radius (Slider.kt sliderValueEnd). */
function valuePosition(fraction: number): string {
  if (fraction <= 0) return "0px";
  if (fraction >= 1) return "100%";
  return `calc(${CORNER}px + (100% - ${CORNER * 2}px) * ${fraction})`;
}

export default function M3Slider({
  min,
  max,
  value,
  onChange,
  ariaLabel,
  ariaValueText,
  color = "#2196f3",
}: {
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  ariaValueText?: string;
  color?: string;
}) {
  const steps = max - min;
  const fraction = steps > 0 ? (value - min) / steps : 0;
  const position = valuePosition(fraction);
  // Ticks at every step except the two ends and the one under the handle.
  const ticks: number[] = [];
  for (let step = 1; step < steps; step += 1) {
    if (min + step !== value) ticks.push(step / steps);
  }
  const showActive = fraction > 0;
  const showInactive = fraction < 1;

  return (
    <div className="m3-slider" style={{ "--m3-slider-color": color } as CSSProperties}>
      <div className="m3-slider__track" aria-hidden="true">
        {showActive && (
          <span
            className="m3-slider__active"
            style={{ width: `calc(${position} - ${GAP}px)` }}
          />
        )}
        {showInactive && (
          <span
            className="m3-slider__inactive"
            style={{ left: `calc(${position} + ${GAP}px)` }}
          />
        )}
        {ticks.map((tick) => (
          <span
            key={tick}
            className={`m3-slider__tick ${tick < fraction ? "m3-slider__tick--active" : ""}`}
            style={{ left: `calc(${CORNER}px + (100% - ${CORNER * 2}px) * ${tick})` }}
          />
        ))}
        <span className="m3-slider__handle" style={{ left: position }} />
      </div>
      <input
        className="m3-slider__input"
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </div>
  );
}
