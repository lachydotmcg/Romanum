import {
  R_PATH,
  SYMBOL_PATH,
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
  /** Render only the compact "Ro" form. */
  compact?: boolean;
};

const X0 = -1;

/**
 * Romanum wordmark. "Ro" and "manum" are separate SVGs that share one coordinate
 * system, so the tail can be revealed on its own while "Ro" stays in place.
 */
export function Wordmark({ className = "", tailClassName = "", compact = false }: WordmarkProps) {
  return (
    <span role="img" aria-label="Romanum" className={`inline-flex ${className}`}>
      <svg
        viewBox={`${X0} ${WORDMARK_Y} ${WORDMARK_SPLIT - X0} ${WORDMARK_HEIGHT}`}
        className="h-full w-auto"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={R_PATH} />
        <path d={SYMBOL_PATH} fillRule="evenodd" />
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
