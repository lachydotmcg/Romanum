import { SYMBOL_CENTER, SYMBOL_PATH, SYMBOL_TILT } from "./wordmark-paths";

/** A Romanum credit: a coin stamped with the wordmark's tilted "o". Inherits the text colour. */
export function Coin({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.75" />
      <path
        d={SYMBOL_PATH}
        fill="currentColor"
        fillRule="evenodd"
        transform={`translate(12 12) rotate(${SYMBOL_TILT}) scale(0.1) translate(${-SYMBOL_CENTER[0]} ${-SYMBOL_CENTER[1]})`}
      />
    </svg>
  );
}
