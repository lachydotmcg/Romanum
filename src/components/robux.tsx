/** Robux denomination, separate from Romanum's circular credit coin. */
export function Robux({ className = "size-4" }: { className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
    <path d="m12 2 8.66 5v10L12 22l-8.66-5V7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M8.5 8.5h7v7h-7z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>;
}
