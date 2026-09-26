import type { CSSProperties } from "react";
import {
  R_PATH,
  SYMBOL_PATH,
  SYMBOL_TILT,
  SYMBOL_UPRIGHT_Y,
  TAIL_PATH,
  WORDMARK_END,
  WORDMARK_HEIGHT,
  WORDMARK_SPLIT,
  WORDMARK_Y,
} from "./wordmark-paths";

type WordmarkProps = {
  /** Sizing and colour. Set a height; the width follows. Fill uses currentColor. */
  className?: string;
  /** Classes for the wrapper around "manum", e.g. to reveal it. */
  tailClassName?: string;
  /**
   * Classes for the square "o". When set, they own its rotation and position: `var(--tilt)`
   * holds the resting angle and `var(--upright-y)` the offset that sits the upright square on
   * the baseline. Without them the square rests at its tilt.
   */
  symbolClassName?: string;
  /** Render only the compact "Ro" form. */
  compact?: boolean;
};

const X0 = -1;
const TILT = `${SYMBOL_TILT}deg`;
// Rotate the square around its own centre.
const SYMBOL_ORIGIN: CSSProperties = { transformBox: "fill-box", transformOrigin: "center" };
const SYMBOL_VARS = { "--tilt": TILT, "--upright-y": `${SYMBOL_UPRIGHT_Y}px` };

/**
 * Romanum wordmark. "Ro" and "manum" are separate SVGs that share one coordinate
 * system, so the tail can be revealed on its own while "Ro" stays in place.
 */
export function Wordmark({
  className = "",
  tailClassName = "",
  symbolClassName,
  compact = false,
}: WordmarkProps) {
  const symbolStyle = (
    symbolClassName ? { ...SYMBOL_ORIGIN, ...SYMBOL_VARS } : { ...SYMBOL_ORIGIN, rotate: TILT }
  ) as CSSProperties;

  return (
    <span role="img" aria-label="Romanum" className={`inline-flex ${className}`}>
      <svg
        viewBox={`${X0} ${WORDMARK_Y} ${WORDMARK_SPLIT - X0} ${WORDMARK_HEIGHT}`}
        className="h-full w-auto"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={R_PATH} />
        <path d={SYMBOL_PATH} fillRule="evenodd" className={symbolClassName} style={symbolStyle} />
      </svg>
      {!compact && (
        <span className={`h-full ${tailClassName}`}>
          <svg
            viewBox={`${WORDMARK_SPLIT} ${WORDMARK_Y} ${WORDMARK_END - WORDMARK_SPLIT} ${WORDMARK_HEIGHT}`}
            className="h-full w-auto"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d={TAIL_PATH} />
          </svg>
        </span>
      )}
    </span>
  );
}
